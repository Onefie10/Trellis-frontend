/**
 * Deterministic fallback embedder.
 *
 * Used when Transformers.js cannot load (no network, SSR, a test run, an old
 * browser) so semantic search degrades to something still better than the
 * previous plain `includes()` keyword check: hashed bag-of-words with sublinear
 * term frequency, character 3-grams for morphology, and L2 normalisation so
 * `cosineSimilarity` is meaningful.
 *
 * It is deliberately *not* semantic — "financial audit" will not match "contract
 * linter" here. That is MiniLM's job; this keeps the pipeline working when the
 * model is unavailable, and it makes the engine's behaviour testable without
 * downloading 23MB of weights.
 */

import { charNgrams, normaliseText, tokenize } from "./tokenizer";
import { normalise } from "./cosine";
import type { Embedder } from "./types";

/** FNV-1a, used for both the bucket and the sign of a feature. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export interface LexicalEmbedderOptions {
  /** Vector length. Larger means fewer hash collisions. Default 256. */
  dimensions?: number;
  /** Include character n-grams alongside word tokens. Default true. */
  useCharNgrams?: boolean;
  /** Include `word1_word2` bigrams. Default true. */
  useBigrams?: boolean;
}

export class LexicalEmbedder implements Embedder {
  readonly id: string;
  readonly dimensions: number;
  readonly ready = true;

  private readonly useCharNgrams: boolean;
  private readonly useBigrams: boolean;

  constructor(options: LexicalEmbedderOptions = {}) {
    this.dimensions = options.dimensions ?? 256;
    this.useCharNgrams = options.useCharNgrams ?? true;
    this.useBigrams = options.useBigrams ?? true;
    this.id = `lexical-hash-${this.dimensions}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.embedOne(text));
  }

  embedOne(text: string): Float32Array {
    const vector = new Float32Array(this.dimensions);
    const counts = new Map<string, number>();

    const tokens = tokenize(text);
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
      if (this.useCharNgrams) {
        for (const gram of new Set(charNgrams(token))) {
          counts.set(gram, (counts.get(gram) ?? 0) + 0.5);
        }
      }
    }

    if (this.useBigrams) {
      for (let i = 0; i + 1 < tokens.length; i += 1) {
        const bigram = `${tokens[i]}_${tokens[i + 1]}`;
        counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
      }
    }

    // The normalised text itself is a feature, so two identical documents always
    // land on an identical vector regardless of tokenisation changes.
    const canonical = normaliseText(text);
    if (canonical !== "") counts.set(`#${canonical}`, 1.5);

    for (const [feature, count] of counts) {
      const hash = fnv1a(feature);
      const bucket = hash % this.dimensions;
      // A second hash decides the sign, so colliding features cancel out on
      // average instead of always adding energy.
      const sign = (fnv1a(`sign:${feature}`) & 1) === 0 ? 1 : -1;
      vector[bucket] += sign * (1 + Math.log(count));
    }

    return normalise(vector);
  }
}
