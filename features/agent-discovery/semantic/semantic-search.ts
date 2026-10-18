/**
 * Hybrid semantic search index.
 *
 * Why hybrid: pure cosine similarity orders by "sounds related", which loses the
 * one result a user typed the exact name for; pure keyword matching is the
 * behaviour being replaced. Blending both (75% vector by default) keeps synonym
 * matches high without letting an exact name match drift down the list — and the
 * `matchedTerms` it returns can be shown as "matched on: audit, ledger".
 *
 * The index is embedder-agnostic: pass a `TransformersEmbedder` in the browser,
 * a `LexicalEmbedder` anywhere the model is unavailable, or a stub in a test.
 */

import { cosineSimilarity, toUnitScore } from "./cosine";
import { EmbeddingCache, vectorKey, type EmbeddingCacheOptions } from "./embedding-cache";
import { buildAgentDocument, lexicalScore } from "./tokenizer";
import type {
  AgentDocument,
  Embedder,
  EmbeddedAgent,
  IndexStats,
  SemanticHit,
  SemanticSearchOptions,
} from "./types";

export const DEFAULT_HYBRID_WEIGHT = 0.75;
export const DEFAULT_LIMIT = 20;

export interface SemanticSearchIndexOptions<TAgent extends AgentDocument = AgentDocument> {
  embedder: Embedder;
  cache?: EmbeddingCache;
  cacheOptions?: EmbeddingCacheOptions;
  /** Texts embedded per `embed()` call when indexing. Default 32. */
  indexBatchSize?: number;
  /** Called when the embedder fails, so a caller can log or swap embedders. */
  onEmbedderError?: (error: unknown) => void;
  /** Fallback embedder used automatically when `embedder` throws. */
  fallbackEmbedder?: Embedder;
}

export class SemanticSearchIndex<TAgent extends AgentDocument = AgentDocument> {
  private embedder: Embedder;
  private readonly fallbackEmbedder?: Embedder;
  private readonly cache: EmbeddingCache;
  private readonly indexBatchSize: number;
  private readonly onEmbedderError?: (error: unknown) => void;
  private entries: EmbeddedAgent<TAgent>[] = [];
  private lastStats: IndexStats;
  /** Agents whose embedding failed, so a search can still match them lexically. */
  private unembedded: Array<{ agent: TAgent; document: string; error: string }> = [];
  /** Set once the fallback embedder has failed too — retrying would be pointless. */
  private embedderExhausted = false;

  constructor(options: SemanticSearchIndexOptions<TAgent>) {
    this.embedder = options.embedder;
    this.fallbackEmbedder = options.fallbackEmbedder;
    this.cache = options.cache ?? new EmbeddingCache(options.cacheOptions);
    this.indexBatchSize = Math.max(1, options.indexBatchSize ?? 32);
    this.onEmbedderError = options.onEmbedderError;
    this.lastStats = {
      size: 0,
      dimensions: this.embedder.dimensions,
      embedder: this.embedder.id,
      cacheHits: 0,
      cacheMisses: 0,
    };
  }

  get size(): number {
    return this.entries.length;
  }

  /** The embedder currently in use — may have changed after a fallback. */
  get activeEmbedder(): Embedder {
    return this.embedder;
  }

  get stats(): IndexStats {
    return { ...this.lastStats };
  }

  get agents(): TAgent[] {
    return this.entries.map((entry) => entry.agent);
  }

  /**
   * Embeds every agent, reusing cached vectors.
   *
   * A single failing batch does not abort the build: those agents are kept for
   * lexical matching (and retried on the next `index()` call), because dropping
   * them would silently hide listings.
   */
  async index(agents: TAgent[]): Promise<IndexStats> {
    const documents = agents.map((agent) => buildAgentDocument(agent));
    const keys = documents.map((document) => vectorKey(this.embedder.id, document));

    const vectors: Array<Float32Array | undefined> = keys.map((key) => this.cache.get(key));
    const missing = keys
      .map((key, index) => ({ key, index, document: documents[index] }))
      .filter((item) => vectors[item.index] === undefined);

    let failure: unknown;
    this.embedderExhausted = false;

    for (let start = 0; start < missing.length; start += this.indexBatchSize) {
      const batch = missing.slice(start, start + this.indexBatchSize);
      const batchFailure = await this.embedBatch(batch, vectors);
      if (batchFailure !== undefined) failure = batchFailure;
      // Nothing embeddable is left; the rest will be matched lexically.
      if (this.embedderExhausted) break;
    }

    const entries: EmbeddedAgent<TAgent>[] = [];
    const unembedded: SemanticSearchIndex<TAgent>["unembedded"] = [];

    agents.forEach((agent, index) => {
      const vector = vectors[index];
      if (!vector) {
        unembedded.push({
          agent,
          document: documents[index],
          error: failure instanceof Error ? failure.message : String(failure ?? "not embedded"),
        });
        return;
      }
      entries.push({ agent, document: documents[index], vector, hash: keys[index] });
    });

    this.entries = entries;
    this.unembedded = unembedded;
    this.lastStats = {
      size: entries.length,
      dimensions: this.embedder.dimensions,
      embedder: this.embedder.id,
      cacheHits: this.cache.hits,
      cacheMisses: this.cache.misses,
    };
    return this.stats;
  }

  /** Embeds one query and ranks the index against it. */
  async search(
    query: string,
    options: SemanticSearchOptions = {},
  ): Promise<SemanticHit<TAgent>[]> {
    const trimmed = query.trim();
    if (trimmed === "" || (this.entries.length === 0 && this.unembedded.length === 0)) {
      return [];
    }

    let queryVector: Float32Array;
    try {
      const [vector] = await this.embedder.embed([trimmed]);
      if (!vector) throw new Error(`embedder "${this.embedder.id}" returned no vector`);
      queryVector = vector;
    } catch (error) {
      this.onEmbedderError?.(error);
      // No query vector means no semantic half; the lexical half still works.
      return this.rankByLexicalOnly(trimmed, options);
    }

    const hybridWeight = clamp01(options.hybridWeight ?? DEFAULT_HYBRID_WEIGHT);
    const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
    const minScore = options.minScore ?? 0;
    const all: Array<SemanticHit<TAgent> & { index: number }> = [];

    this.entries.forEach((entry, index) => {
      if (!this.passesFilter(entry.agent, options)) return;

      const vectorScore = toUnitScore(cosineSimilarity(queryVector, entry.vector));
      const lexical = lexicalScore(trimmed, entry.agent);

      all.push({
        agent: entry.agent,
        vectorScore,
        lexicalScore: lexical.score,
        matchedTerms: lexical.matchedTerms,
        score: hybridWeight * vectorScore + (1 - hybridWeight) * lexical.score,
        index,
      });
    });

    return finalise(all, minScore, limit);
  }

  /** Vector store's entries as a serialisable snapshot (for a worker or a test). */
  toSnapshot(): Array<{ id: string | number; hash: string; vector: number[] }> {
    return this.entries.map((entry) => ({
      id: entry.agent.id,
      hash: entry.hash,
      vector: Array.from(entry.vector),
    }));
  }

  /**
   * Ranking when no query vector could be produced.
   *
   * Every surviving hit reports `vectorScore: 0`, so a caller can tell semantic
   * ranking was skipped rather than inferring it from an oddly low score.
   */
  private rankByLexicalOnly(
    query: string,
    options: SemanticSearchOptions,
  ): Array<SemanticHit<TAgent>> {
    const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
    const minScore = options.minScore ?? 0;
    const all: Array<SemanticHit<TAgent> & { index: number }> = [];

    this.entries.forEach((entry, index) => {
      if (!this.passesFilter(entry.agent, options)) return;
      const lexical = lexicalScore(query, entry.agent);
      all.push({
        agent: entry.agent,
        vectorScore: 0,
        lexicalScore: lexical.score,
        matchedTerms: lexical.matchedTerms,
        score: lexical.score,
        index,
      });
    });

    this.unembedded.forEach((entry, offset) => {
      if (!this.passesFilter(entry.agent, options)) return;
      const lexical = lexicalScore(query, entry.agent);
      all.push({
        agent: entry.agent,
        vectorScore: 0,
        lexicalScore: lexical.score,
        matchedTerms: lexical.matchedTerms,
        score: lexical.score,
        index: this.entries.length + offset,
      });
    });

    return finalise(all, minScore, limit);
  }

  /**
   * Embeds one batch, falling back to `fallbackEmbedder` once.
   *
   * Returns the failure (if any) so `index()` can report why agents were left
   * unembedded, and sets `embedderExhausted` when no embedder is left to try.
   */
  private async embedBatch(
    batch: Array<{ key: string; index: number; document: string }>,
    vectors: Array<Float32Array | undefined>,
  ): Promise<unknown | undefined> {
    const attempt = async (embedder: Embedder): Promise<unknown | undefined> => {
      try {
        const embedded = await embedder.embed(batch.map((item) => item.document));
        if (embedded.length !== batch.length) {
          throw new Error(
            `embedder "${embedder.id}" returned ${embedded.length} vectors for ${batch.length} texts`,
          );
        }
        batch.forEach((item, position) => {
          const key = vectorKey(embedder.id, item.document);
          this.cache.set(key, embedded[position]);
          vectors[item.index] = embedded[position];
        });
        return undefined;
      } catch (error) {
        this.onEmbedderError?.(error);
        return error;
      }
    };

    const failure = await attempt(this.embedder);
    if (failure === undefined) return undefined;

    const fallback = this.fallbackEmbedder;
    if (fallback && fallback !== this.embedder) {
      this.embedder = fallback;
      const retryFailure = await attempt(fallback);
      if (retryFailure === undefined) return undefined;
      this.embedderExhausted = true;
      return retryFailure;
    }

    this.embedderExhausted = true;
    return failure;
  }

  private passesFilter(agent: TAgent, options: SemanticSearchOptions): boolean {
    if (options.filter && !options.filter(agent)) return false;
    if (!options.fields) return true;

    return Object.entries(options.fields).every(([field, expected]) => {
      if (expected === undefined) return true;
      const actual = (agent as Record<string, unknown>)[field];
      if (Array.isArray(actual)) return actual.includes(expected);
      return actual === expected;
    });
  }
}

function finalise<TAgent extends AgentDocument>(
  hits: Array<SemanticHit<TAgent> & { index: number }>,
  minScore: number,
  limit: number,
): SemanticHit<TAgent>[] {
  return hits
    .filter((hit) => hit.score >= minScore)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    })
    .slice(0, limit)
    .map((hit) => ({
      agent: hit.agent,
      score: hit.score,
      vectorScore: hit.vectorScore,
      lexicalScore: hit.lexicalScore,
      matchedTerms: hit.matchedTerms,
    }));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HYBRID_WEIGHT;
  return Math.max(0, Math.min(1, value));
}
