/**
 * Semantic agent search over a candidate set, with graceful degradation.
 *
 * The backend search (`services/searchService.ts`) asks Algolia; this runs the
 * *browser-side* semantic layer over agents already on the page, which is what
 * makes natural-language queries work without a vector database.
 *
 * Embedder selection is automatic:
 *   1. `TransformersEmbedder` (`Xenova/all-MiniLM-L6-v2`, WASM) when the model
 *      loads;
 *   2. `LexicalEmbedder` otherwise — a hashed bag-of-words space that still ranks
 *      partial matches, so the feature never becomes a white screen when the CDN
 *      is blocked, WASM is unavailable or the package was not installed.
 *
 * The chosen embedder is reported with every result, so the UI can tell the user
 * (or a log can record) which one served the query.
 */

import {
  LexicalEmbedder,
  type LexicalEmbedderOptions,
} from "@/features/agent-discovery/semantic/hash-embedder";
import { browserStorage, EmbeddingCache } from "@/features/agent-discovery/semantic/embedding-cache";
import { SemanticSearchIndex } from "@/features/agent-discovery/semantic/semantic-search";
import {
  TransformersEmbedder,
  type TransformersEmbedderOptions,
} from "@/features/agent-discovery/semantic/transformers-embedder";
import type {
  AgentDocument,
  Embedder,
  SemanticHit,
  SemanticSearchOptions,
} from "@/features/agent-discovery/semantic/types";

export interface SemanticSearchResult<TAgent extends AgentDocument = AgentDocument> {
  results: SemanticHit<TAgent>[];
  /** Which embedder produced the ranking. */
  embedder: string;
  /** True when the ONNX model was used, false when the lexical fallback was. */
  semantic: boolean;
  /** Why the model was not used, when it was not. */
  fallbackReason?: string;
  /** Index size at query time. */
  indexed: number;
}

export interface SemanticSearchServiceOptions {
  /** Probe for the real model on the first query. Default true. */
  preferTransformers?: boolean;
  transformersOptions?: TransformersEmbedderOptions;
  lexicalOptions?: LexicalEmbedderOptions;
  /** Skip the localStorage vector cache. */
  disablePersistentCache?: boolean;
  onFallback?: (reason: string) => void;
}

/**
 * Picks the best embedder available in this runtime and remembers the answer.
 *
 * The probe is cached for the lifetime of the service: a failed model load costs
 * one attempt, not one per query, and the lexical embedder keeps serving.
 */
export async function resolveEmbedder(
  options: SemanticSearchServiceOptions = {},
): Promise<{ embedder: Embedder; semantic: boolean; reason?: string }> {
  if (options.preferTransformers === false) {
    return { embedder: new LexicalEmbedder(options.lexicalOptions), semantic: false };
  }

  const transformers = new TransformersEmbedder(options.transformersOptions);
  try {
    await transformers.warmup();
    return { embedder: transformers, semantic: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    options.onFallback?.(reason);
    return { embedder: new LexicalEmbedder(options.lexicalOptions), semantic: false, reason };
  }
}

/**
 * Searches `agents` for `query` using a fresh index.
 *
 * Call this once per result set; for a fixed catalogue, build a
 * `SemanticSearchIndex` (or use the `useSemanticSearch` hook) so vectors are
 * embedded once and reused across keystrokes.
 */
export async function searchAgentsSemantically<TAgent extends AgentDocument>(
  agents: TAgent[],
  query: string,
  options: SemanticSearchOptions & SemanticSearchServiceOptions = {},
): Promise<SemanticSearchResult<TAgent>> {
  const { embedder, semantic, reason } = await resolveEmbedder(options);
  const cache = new EmbeddingCache({
    storage: options.disablePersistentCache ? undefined : browserStorage(),
    namespace: "trellis:agent-embeddings",
  });

  const index = new SemanticSearchIndex<TAgent>({
    embedder,
    cache,
    fallbackEmbedder: options.preferTransformers === false ? undefined : new LexicalEmbedder(options.lexicalOptions),
  });

  await index.index(agents);
  const results = await index.search(query, options);

  return {
    results,
    embedder: index.activeEmbedder.id,
    semantic: semantic && index.activeEmbedder.id.startsWith("transformers:"),
    fallbackReason: reason,
    indexed: index.size,
  };
}
