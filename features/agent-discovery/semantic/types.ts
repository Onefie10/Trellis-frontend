/**
 * Shared types for client-side semantic agent search.
 *
 * The engine never imports a model library directly: it talks to an `Embedder`,
 * which is what makes it testable (inject a stub) and resilient (the real
 * embedder degrades to the lexical fallback when Transformers.js is unavailable).
 */

/** The shape the discovery UI already renders. Extra fields are preserved. */
export interface AgentDocument {
  id: string | number;
  name: string;
  description?: string;
  category?: string;
  capabilities?: string[];
  tags?: string[];
  author?: string;
  [key: string]: unknown;
}

/** Produces one vector per input text. Implementations may batch internally. */
export interface Embedder {
  /** Stable id — part of every cache key, so two models never share vectors. */
  readonly id: string;
  /** Vector length; every vector this embedder returns must match it. */
  readonly dimensions: number;
  /** False until the underlying model has been loaded. */
  readonly ready: boolean;
  /** Loads the model early. Optional — `embed()` loads on first use. */
  warmup?(): Promise<void>;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface EmbeddedAgent<TAgent extends AgentDocument = AgentDocument> {
  agent: TAgent;
  /** Weighted text the vector was computed from. */
  document: string;
  vector: Float32Array;
  /** Content hash of `document` — the cache key. */
  hash: string;
}

export interface SemanticHit<TAgent extends AgentDocument = AgentDocument> {
  agent: TAgent;
  /** Blended score used for ranking, in `[0, 1]`. */
  score: number;
  /** Cosine similarity of the query vector to the agent vector. */
  vectorScore: number;
  /** Weighted lexical overlap, used to keep exact matches on top. */
  lexicalScore: number;
  /** Query terms found in the agent's text, for a "matched on" hint in the UI. */
  matchedTerms: string[];
}

export interface SemanticSearchOptions {
  limit?: number;
  /** Hits below this blended score are dropped. Default 0. */
  minScore?: number;
  /**
   * How much the vector score counts. 1 = pure semantic, 0 = pure keyword.
   * The default (0.75) keeps synonym matches high while a literal name match
   * still wins over a vaguer semantic neighbour.
   */
  hybridWeight?: number;
  /** Drop agents that do not match. */
  filter?: (agent: AgentDocument) => boolean;
  /** Convenience equality filters, e.g. `{ category: "DeFi" }`. */
  fields?: Record<string, unknown>;
}

export interface IndexStats {
  size: number;
  dimensions: number;
  embedder: string;
  /** Texts reused from the embedding cache during the last index build. */
  cacheHits: number;
  /** Texts that had to be embedded. */
  cacheMisses: number;
}

export class EmbeddingUnavailableError extends Error {
  readonly reason: string;

  constructor(message: string, reason = "unavailable") {
    super(message);
    this.name = "EmbeddingUnavailableError";
    this.reason = reason;
  }
}
