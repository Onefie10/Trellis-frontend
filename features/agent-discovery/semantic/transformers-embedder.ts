/**
 * Transformers.js embedder — `Xenova/all-MiniLM-L6-v2`, 384 dimensions, ONNX
 * quantised, running client-side in the WASM backend.
 *
 * Three things matter here:
 *
 *   1. The model is loaded **lazily**. A static import would put ~23MB of weights
 *      and the ONNX runtime into the first paint of the marketplace; the dynamic
 *      import only runs when semantic search is actually used.
 *   2. The import is guarded. If Transformers.js is missing (a checkout that has
 *      not installed it, SSR, a browser without WASM), `load()` throws
 *      `EmbeddingUnavailableError` and callers fall back to `LexicalEmbedder`
 *      instead of the feature disappearing.
 *   3. `embed()` batches and normalises, so the engine can treat the vectors as
 *      unit vectors without a second pass.
 */

import { normalise } from "./cosine";
import { EmbeddingUnavailableError, type Embedder } from "./types";

export const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
/** all-MiniLM-L6-v2 hidden size. */
export const MINILM_DIMENSIONS = 384;

/**
 * The slice of the Transformers.js API this module uses.
 *
 * Declared locally instead of importing the package's types so that a checkout
 * without the dependency still type-checks: the import below is deliberately
 * untyped (see the `@ts-ignore`) and cast to this interface.
 */
interface FeatureExtractionOutput {
  data: Float32Array | number[];
  /** `[batch, dimensions]`, or `[dimensions]` for a single text. */
  dims?: number[];
}

type FeatureExtractionPipeline = (
  texts: string | string[],
  options?: { pooling?: "mean" | "cls" | "none"; normalize?: boolean },
) => Promise<FeatureExtractionOutput>;

interface TransformersModule {
  pipeline: (
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ) => Promise<FeatureExtractionPipeline>;
  env?: {
    allowLocalModels?: boolean;
    allowRemoteModels?: boolean;
    useBrowserCache?: boolean;
    useFSCache?: boolean;
    backends?: { onnx?: { wasm?: { numThreads?: number; proxy?: boolean } } };
  };
}

export interface TransformersEmbedderOptions {
  /** Defaults to `Xenova/all-MiniLM-L6-v2`. */
  model?: string;
  /** Texts per pipeline call. Default 16 — smaller keeps the UI responsive. */
  batchSize?: number;
  /** Ask Transformers.js to use more WASM threads. Default 1. */
  numThreads?: number;
  /** Injected for tests; defaults to a dynamic `import()`. */
  loadModule?: () => Promise<TransformersModule>;
}

async function importTransformers(): Promise<TransformersModule> {
  // @ts-ignore — optional peer dependency: resolved from node_modules when the
  // project has installed `@xenova/transformers`, and reported as a normal
  // runtime failure (handled below) when it has not.
  return (await import("@xenova/transformers")) as TransformersModule;
}

export class TransformersEmbedder implements Embedder {
  readonly id: string;
  readonly dimensions = MINILM_DIMENSIONS;
  readonly model: string;

  private readonly batchSize: number;
  private readonly numThreads: number;
  private readonly loadModule: () => Promise<TransformersModule>;
  private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
  private loaded = false;

  constructor(options: TransformersEmbedderOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.batchSize = Math.max(1, options.batchSize ?? 16);
    this.numThreads = Math.max(1, options.numThreads ?? 1);
    this.loadModule = options.loadModule ?? importTransformers;
    this.id = `transformers:${this.model}`;
  }

  get ready(): boolean {
    return this.loaded;
  }

  /** Loads the model up front, e.g. while the user is still typing. */
  async warmup(): Promise<void> {
    await this.load();
  }

  /** True when the model can actually be loaded in this runtime. */
  async isAvailable(): Promise<boolean> {
    try {
      await this.load();
      return true;
    } catch {
      return false;
    }
  }

  /** Loads the pipeline once; concurrent callers share the same promise. */
  async load(): Promise<FeatureExtractionPipeline> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = this.createPipeline().catch((error) => {
        // Clear the memo so a transient failure (offline) can be retried.
        this.pipelinePromise = null;
        throw error;
      });
    }
    const pipeline = await this.pipelinePromise;
    this.loaded = true;
    return pipeline;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const pipeline = await this.load();

    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const batch = texts.slice(start, start + this.batchSize);
      const output = await pipeline(batch, { pooling: "mean", normalize: true });
      vectors.push(...this.rows(output, batch.length));
    }
    return vectors;
  }

  private async createPipeline(): Promise<FeatureExtractionPipeline> {
    let xenovaModule: TransformersModule;
    try {
      xenovaModule = await this.loadModule();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new EmbeddingUnavailableError(
        `@xenova/transformers could not be loaded (${message})`,
        "module-missing",
      );
    }

    try {
      const env = xenovaModule.env;
      if (env) {
        // Fetch from the Hugging Face CDN and cache in the browser; never look
        // for a local model directory, which a client bundle does not have.
        if (env.allowLocalModels !== undefined) env.allowLocalModels = false;
        if (env.allowRemoteModels !== undefined) env.allowRemoteModels = true;
        if (env.useBrowserCache !== undefined) {
          env.useBrowserCache = typeof window !== "undefined";
        }
        if (env.useFSCache !== undefined) env.useFSCache = false;
        const wasm = env.backends?.onnx?.wasm;
        if (wasm) wasm.numThreads = this.numThreads;
      }

      return await xenovaModule.pipeline("feature-extraction", this.model, {
        quantized: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new EmbeddingUnavailableError(
        `model "${this.model}" could not be initialised (${message})`,
        "model-init-failed",
      );
    }
  }

  /**
   * Turns the pipeline's flat tensor into one `Float32Array` per input.
   *
   * `dims` is `[batch, dimensions]` for a batch and `[dimensions]` for a single
   * text, so both shapes are handled.
   */
  private rows(output: FeatureExtractionOutput, expected: number): Float32Array[] {
    const data = output.data instanceof Float32Array ? output.data : Float32Array.from(output.data);
    const dims = output.dims ?? [];

    if (dims.length <= 1) {
      return [this.finish(data)];
    }

    const dimensions = dims[dims.length - 1];
    if (dims[0] !== expected || data.length !== expected * dimensions) {
      throw new Error(
        `unexpected embedding shape: dims ${dims.join("x")} for ${expected} input(s)`,
      );
    }

    const rows: Float32Array[] = [];
    for (let row = 0; row < expected; row += 1) {
      rows.push(this.finish(data.slice(row * dimensions, (row + 1) * dimensions)));
    }
    return rows;
  }

  /**
   * `normalize: true` already returns unit vectors; re-normalising here is
   * cheap insurance against a model config that ignores the flag, and it makes
   * the dimension check fail loudly rather than silently ranking on garbage.
   */
  private finish(vector: Float32Array): Float32Array {
    if (vector.length !== this.dimensions) {
      throw new Error(
        `expected ${this.dimensions}-dimensional embeddings from ${this.model}, got ${vector.length}`,
      );
    }
    return normalise(vector);
  }
}
