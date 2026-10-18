import {
  EmbeddingCache,
  vectorKey,
  type EmbeddingStorage,
} from "../semantic/embedding-cache";
import { LexicalEmbedder } from "../semantic/hash-embedder";
import {
  assertSameDimensions,
  cosineSimilarity,
  dot,
  meanPool,
  normalise,
  norm,
  quantiseVector,
  toUnitScore,
} from "../semantic/cosine";
import {
  buildAgentDocument,
  charNgrams,
  lexicalScore,
  normaliseText,
  splitWords,
  tokenize,
  weightedDocumentTokens,
} from "../semantic/tokenizer";
import { SemanticSearchIndex } from "../semantic/semantic-search";
import { MINILM_DIMENSIONS, TransformersEmbedder } from "../semantic/transformers-embedder";
import { resolveEmbedder, searchAgentsSemantically } from "../services/semanticSearchService";
import type { AgentDocument, Embedder } from "../semantic/types";

const FINANCE = "financial analysis and market trend prediction engine";
const SECURITY = "security and threat detection for your infrastructure";

function financeAgent(): AgentDocument {
  return { id: "finance", name: "QuantX", description: FINANCE, category: "DeFi" };
}

function securityAgent(): AgentDocument {
  return { id: "security", name: "Sentinel AI", description: SECURITY, category: "Security" };
}

function codeAgent(): AgentDocument {
  return {
    id: "code",
    name: "CodeAssistant",
    description: "Intelligent code generation and debugging in multiple languages.",
    category: "Developer Tools",
  };
}

/** Exact float comparison is a trap; compare within a tolerance instead. */
function approx(actual: number, expected: number, tolerance = 1e-6): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

/**
 * A stand-in for MiniLM: three "topics" instead of 384 dimensions, so cosine
 * behaviour is asserted exactly instead of approximately. It is deliberately
 * semantic-ish (a query word matches a *theme*, not a literal string), which is
 * the property the real model adds over the lexical fallback.
 */
class TopicEmbedder implements Embedder {
  readonly id = "stub-topics";
  readonly dimensions = 3;
  readonly ready = true;
  calls = 0;

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls += 1;
    return texts.map((text) => this.one(text));
  }

  one(text: string): Float32Array {
    const value = text.toLowerCase();
    const vector = new Float32Array(3);
    if (/financ|audit|market|ledger|account|invest/.test(value)) vector[0] = 1;
    if (/security|threat|vulnerab|guard/.test(value)) vector[1] = 1;
    if (/code|lint|debug|develop|program/.test(value)) vector[2] = 1;
    return normalise(vector);
  }
}

/** Fails every call — models the "no model, no fallback" case. */
class FailingEmbedder implements Embedder {
  readonly id = "always-fails";
  readonly dimensions = 3;
  readonly ready = true;

  async embed(): Promise<Float32Array[]> {
    throw new Error("model offline");
  }
}

/** Works for the first `healthCalls` calls, then fails — a query-time outage. */
class FlakyEmbedder implements Embedder {
  readonly id = "flaky";
  readonly dimensions = 3;
  readonly ready = true;
  private calls = 0;

  constructor(private readonly healthCalls: number) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls += 1;
    if (this.calls > this.healthCalls) throw new Error("model went away");
    const base = new TopicEmbedder();
    return texts.map((text) => base.one(text));
  }
}

/** Returns the wrong width after indexing, as a model swap would. */
class DriftingEmbedder implements Embedder {
  readonly id = "drifting";
  readonly dimensions = 3;
  readonly ready = true;
  private calls = 0;

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls += 1;
    const width = this.calls === 1 ? 3 : 2;
    return texts.map(() => new Float32Array(width).fill(1));
  }
}

class MemoryStorage implements EmbeddingStorage {
  private readonly map = new Map<string, string>();
  writes = 0;

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes += 1;
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

describe("semantic tokenizer", () => {
  it("splits identifiers and strips punctuation but keeps content", () => {
    expect(normaliseText("DataBotPro v2.1 (DeFi)_agent")).toBe("data bot pro v2 1 de fi agent");
    expect(splitWords("snake_case-name")).toBe("snake case name");
  });

  it("keeps letters and numbers from every script", () => {
    expect(normaliseText("Café Soroban")).toBe("café soroban");
    // Emoji are symbols, not letters, so they are dropped rather than shipped to
    // the model as noise.
    expect(normaliseText("market data")).toBe("market data");
  });

  it("drops stop words from a natural language query", () => {
    expect(tokenize("I need an agent for financial audit")).toEqual([
      "agent",
      "financial",
      "audit",
    ]);
  });

  it("keeps stop words when the query is made of nothing else", () => {
    expect(tokenize("the who")).toEqual(["the", "who"]);
    expect(tokenize("   ")).toEqual([]);
  });

  it("produces character n-grams for morphological matching", () => {
    expect(charNgrams("audit")).toEqual(["aud", "udi", "dit"]);
    expect(charNgrams("hi")).toEqual(["hi"]);
  });

  it("weights name and category above description", () => {
    const weights = weightedDocumentTokens({
      name: "Audit Bot",
      category: "Security",
      description: "audit",
    });
    expect(weights.get("audit")).toBe(4);
    expect(weights.get("security")).toBe(2.5);
  });

  it("builds the text the model sees with the name repeated", () => {
    expect(buildAgentDocument({ name: "QuantX", category: "DeFi" })).toBe(
      "quant x quant x category de fi de fi",
    );
  });

  it("falls back to a placeholder for an unnamed agent", () => {
    expect(buildAgentDocument({})).toBe("unnamed agent");
  });

  it("scores an exact name match at 1 and stops there", () => {
    const result = lexicalScore("sentinel", securityAgent());
    expect(result.score).toBe(1);
    expect(result.matchedTerms).toContain("sentinel");
  });

  it("gives partial credit for a morphological variant", () => {
    const partial = lexicalScore("auditing", {
      name: "Ledger Ops",
      description: "audit financial records",
    });
    expect(partial.score).toBeGreaterThan(0);
    expect(partial.score).toBeLessThan(1);
    expect(partial.matchedTerms).toContain("auditing");
  });

  it("scores an unrelated query at 0 and reports no matched terms", () => {
    const result = lexicalScore("quantum chemistry", securityAgent());
    expect(result.score).toBe(0);
    expect(result.matchedTerms.length).toBe(0);
  });

  it("keeps the lexical score inside [0, 1] for a long query", () => {
    const result = lexicalScore(
      "sentinel security threat detection agent for my infrastructure please",
      securityAgent(),
    );
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.score).toBeGreaterThan(0);
  });
});

describe("semantic vector maths", () => {
  it("computes dot products and norms", () => {
    expect(dot(Float32Array.from([1, 2, 3]), Float32Array.from([4, 5, 6]))).toBe(32);
    expect(norm(Float32Array.from([3, 4]))).toBe(5);
  });

  it("normalises without mutating the input", () => {
    const input = Float32Array.from([3, 4]);
    const unit = normalise(input);
    expect(input[0]).toBe(3);
    // Float32Array rounds 0.6 to 0.60000002…, so compare within a tolerance.
    expect(approx(unit[0], 0.6)).toBe(true);
    expect(approx(norm(unit), 1)).toBe(true);
  });

  it("returns a zero vector rather than NaN for an all-zero input", () => {
    const zero = normalise(Float32Array.from([0, 0, 0]));
    expect(zero[0]).toBe(0);
    expect(zero[1]).toBe(0);
    expect(cosineSimilarity(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
  });

  it("scores identical, orthogonal and opposite vectors", () => {
    const a = normalise(Float32Array.from([1, 1]));
    const b = normalise(Float32Array.from([1, -1]));
    expect(approx(cosineSimilarity(a, a), 1)).toBe(true);
    expect(cosineSimilarity(a, b)).toBe(0);
    expect(cosineSimilarity(a, Float32Array.from([-a[0], -a[1]]))).toBeLessThan(-0.999);
  });

  it("clamps between -1 and 1 and maps onto [0, 1]", () => {
    const a = Float32Array.from([2, 0]);
    expect(cosineSimilarity(a, a)).toBe(1);
    expect(toUnitScore(1)).toBe(1);
    expect(toUnitScore(0)).toBe(0.5);
    expect(toUnitScore(-1)).toBe(0);
    expect(toUnitScore(5)).toBe(1);
  });

  it("refuses to compare vectors of different widths", () => {
    expect(() =>
      assertSameDimensions(Float32Array.from([1, 2]), Float32Array.from([1, 2, 3])),
    ).toThrow(/dimension mismatch/);
  });

  it("pools token embeddings with an attention mask", () => {
    const pooled = meanPool(
      [Float32Array.from([1, 1]), Float32Array.from([3, 3]), Float32Array.from([9, 9])],
      [1, 1, 0],
    );
    expect(pooled[0]).toBe(2);
    expect(pooled[1]).toBe(2);
  });

  it("returns a zero vector when every token is masked out", () => {
    const pooled = meanPool([Float32Array.from([5, 5])], [0]);
    expect(pooled[0]).toBe(0);
  });

  it("rejects ragged token embeddings", () => {
    expect(() => meanPool([Float32Array.from([1, 2]), Float32Array.from([1])])).toThrow(
      /ragged/,
    );
  });

  it("quantises for compact storage", () => {
    const quantised = quantiseVector(Float32Array.from([0.1234567, 0.5, 1]));
    expect(quantised).toEqual([0.12346, 0.5, 1]);
  });
});

describe("lexical fallback embedder", () => {
  it("is deterministic and unit length", async () => {
    const embedder = new LexicalEmbedder({ dimensions: 64 });
    const [first] = await embedder.embed(["sentinel security agent"]);
    const [again] = await embedder.embed(["sentinel security agent"]);

    expect(Array.from(first)).toEqual(Array.from(again));
    expect(approx(norm(first), 1)).toBe(true);
    expect(embedder.ready).toBe(true);
    expect(embedder.id).toBe("lexical-hash-64");
    expect(embedder.dimensions).toBe(64);
  });

  it("gives different texts different vectors", async () => {
    const embedder = new LexicalEmbedder({ dimensions: 128 });
    const [a, b] = await embedder.embed(["financial audit", "threat detection"]);
    expect(cosineSimilarity(a, b) < 0.9).toBe(true);
  });

  it("ranks overlapping text above unrelated text", async () => {
    const embedder = new LexicalEmbedder({ dimensions: 256 });
    const [query, related, unrelated] = await embedder.embed([
      "financial audit ledger",
      "audit the ledger finances",
      "generative art for posters",
    ]);
    expect(cosineSimilarity(query, related)).toBeGreaterThan(
      cosineSimilarity(query, unrelated),
    );
  });

  it("normalises punctuation, case and camelCase before hashing", async () => {
    const embedder = new LexicalEmbedder({ dimensions: 64 });
    const [plain, decorated] = await embedder.embed(["audit bot", "  AuditBot!  "]);
    expect(approx(cosineSimilarity(plain, decorated), 1)).toBe(true);
  });

  it("changes the vector when character n-grams are disabled", async () => {
    const withGrams = new LexicalEmbedder({ dimensions: 32 });
    const withoutGrams = new LexicalEmbedder({ dimensions: 32, useCharNgrams: false });
    const [a] = await withGrams.embed(["auditing"]);
    const [b] = await withoutGrams.embed(["auditing"]);
    expect(Array.from(a).join(",") === Array.from(b).join(",")).toBe(false);
  });
});

describe("transformers embedder guard rails", () => {
  it("reports the model contract without loading it", () => {
    const embedder = new TransformersEmbedder();
    expect(embedder.dimensions).toBe(MINILM_DIMENSIONS);
    expect(MINILM_DIMENSIONS).toBe(384);
    expect(embedder.id).toBe("transformers:Xenova/all-MiniLM-L6-v2");
    expect(embedder.ready).toBe(false);
  });

  it("raises EmbeddingUnavailableError when the module cannot be loaded", async () => {
    const embedder = new TransformersEmbedder({
      loadModule: async () => {
        throw new Error("Cannot find module '@xenova/transformers'");
      },
    });

    let message = "";
    try {
      await embedder.embed(["hello"]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.includes("could not be loaded")).toBe(true);
    expect(await embedder.isAvailable()).toBe(false);
  });

  it("surfaces a model initialisation failure as unavailable", async () => {
    const embedder = new TransformersEmbedder({
      loadModule: async () =>
        ({
          pipeline: async () => {
            throw new Error("no such model");
          },
        }) as never,
    });

    let message = "";
    try {
      await embedder.warmup();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.includes("could not be initialised")).toBe(true);
  });

  it("shapes a batch tensor into one vector per text", async () => {
    const seen: string[] = [];
    const embedder = new TransformersEmbedder({
      batchSize: 2,
      loadModule: async () =>
        ({
          pipeline: async () => async (texts: string[]) => {
            seen.push(...texts);
            const data = new Float32Array(texts.length * MINILM_DIMENSIONS);
            data.fill(1);
            return { data, dims: [texts.length, MINILM_DIMENSIONS] };
          },
        }) as never,
    });

    const vectors = await embedder.embed(["a", "b", "c"]);
    expect(vectors.length).toBe(3);
    expect(vectors[0].length).toBe(MINILM_DIMENSIONS);
    expect(seen.length).toBe(3);
    expect(embedder.ready).toBe(true);
  });

  it("rejects an unexpected tensor shape", async () => {
    const embedder = new TransformersEmbedder({
      loadModule: async () =>
        ({
          pipeline: async () => async () => ({ data: new Float32Array(3), dims: [3] }),
        }) as never,
    });

    let message = "";
    try {
      await embedder.embed(["a"]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.includes("expected 384-dimensional")).toBe(true);
  });
});

describe("embedding cache", () => {
  it("stores vectors and counts hits and misses", () => {
    const cache = new EmbeddingCache();
    const key = vectorKey("stub", "hello");
    expect(cache.get(key)).toBeUndefined();
    expect(cache.misses).toBe(1);

    cache.set(key, Float32Array.from([1, 0]));
    const hit = cache.get(key);
    expect(hit && Array.from(hit)).toEqual([1, 0]);
    expect(cache.hits).toBe(1);
  });

  it("keys vectors by embedder and content", () => {
    expect(vectorKey("a", "x") === vectorKey("a", "x")).toBe(true);
    expect(vectorKey("a", "x") === vectorKey("b", "x")).toBe(false);
    expect(vectorKey("a", "x") === vectorKey("a", "y")).toBe(false);
  });

  it("evicts the least recently used entry", () => {
    const cache = new EmbeddingCache({ maxEntries: 2 });
    cache.set("a", Float32Array.from([1]));
    cache.set("b", Float32Array.from([1]));
    cache.get("a");
    cache.set("c", Float32Array.from([1]));

    expect(cache.size).toBe(2);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
  });

  it("persists through a storage backend under a namespace", () => {
    const storage = new MemoryStorage();
    const first = new EmbeddingCache({ storage, namespace: "test" });
    const key = vectorKey("stub", "persist me");
    first.set(key, Float32Array.from([0.5, 0.25]));

    expect(storage.length).toBe(1);
    expect(storage.key(0)?.startsWith("test:")).toBe(true);

    const second = new EmbeddingCache({ storage, namespace: "test" });
    const restored = second.get(key);
    expect(restored !== undefined).toBe(true);
    expect(restored ? approx(restored[0], 0.5) : false).toBe(true);
  });

  it("ignores a corrupted stored entry", () => {
    const storage = new MemoryStorage();
    const key = vectorKey("stub", "bad");
    storage.setItem(`test:${key}`, "not json");
    const cache = new EmbeddingCache({ storage, namespace: "test" });
    expect(cache.get(key)).toBeUndefined();
  });

  it("survives a storage backend that throws on write", () => {
    const hostile: EmbeddingStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
    };
    const cache = new EmbeddingCache({ storage: hostile, namespace: "test" });
    cache.set("k", Float32Array.from([1]));

    const kept = cache.get("k");
    expect(kept !== undefined).toBe(true);
    expect(kept ? kept.length : 0).toBe(1);
  });

  it("clears memory and namespaced storage only", () => {
    const storage = new MemoryStorage();
    const cache = new EmbeddingCache({ storage, namespace: "test" });
    cache.set("a", Float32Array.from([1]));
    storage.setItem("other:key", "keep me");

    cache.clear();
    expect(cache.size).toBe(0);
    expect(storage.length).toBe(1);
    expect(storage.getItem("other:key")).toBe("keep me");
  });
});

describe("semantic search index ranking", () => {
  it("orders by cosine similarity when the vector score is all that counts", async () => {
    const embedder = new TopicEmbedder();
    const index = new SemanticSearchIndex<AgentDocument>({ embedder });
    await index.index([financeAgent(), securityAgent(), codeAgent()]);

    const hits = await index.search("financial audit assistant", { hybridWeight: 1 });
    expect(hits.length).toBe(3);
    expect(hits[0].agent.id).toBe("finance");
    expect(hits[0].score).toBe(1);
    expect(hits[0].vectorScore).toBe(1);
  });

  it("matches a theme with no literal keyword overlap", async () => {
    const embedder = new TopicEmbedder();
    const index = new SemanticSearchIndex<AgentDocument>({ embedder });
    await index.index([financeAgent()]);

    const hits = await index.search("auditing the books", { hybridWeight: 1, minScore: 0.9 });
    expect(hits.length).toBe(1);
    // "auditing the books" shares no token with "QuantX — financial analysis and
    // market trend prediction engine"; only the embedding links them.
    expect(hits[0].lexicalScore).toBe(0);
    expect(hits[0].vectorScore).toBe(1);
  });

  it("keeps an exact name match on top when blending keyword and vector", async () => {
    const embedder = new TopicEmbedder();
    const index = new SemanticSearchIndex<AgentDocument>({ embedder });
    await index.index([
      financeAgent(),
      { id: "named", name: "Audit Assistant", description: "General purpose helper." },
    ]);

    const hits = await index.search("audit assistant");
    expect(hits[0].agent.id).toBe("named");
    expect(hits[0].lexicalScore).toBe(1);
    expect(hits[0].matchedTerms).toContain("audit");
    expect(hits[0].matchedTerms).toContain("assistant");
  });

  it("ranks by keyword alone at hybridWeight 0", async () => {
    const embedder = new TopicEmbedder();
    const index = new SemanticSearchIndex<AgentDocument>({ embedder });
    await index.index([financeAgent(), securityAgent()]);

    const hits = await index.search("sentinel", { hybridWeight: 0 });
    expect(hits[0].agent.id).toBe("security");
    expect(hits[0].score).toBe(1);
    expect(hits[1].score).toBe(0);
  });

  it("applies limit, minScore, filter and field filters", async () => {
    const embedder = new TopicEmbedder();
    const index = new SemanticSearchIndex<AgentDocument>({ embedder });
    await index.index([financeAgent(), securityAgent(), codeAgent()]);

    expect((await index.search("agent", { limit: 2 })).length).toBe(2);
    expect(
      (await index.search("financial audit", { hybridWeight: 1, minScore: 0.9 })).length,
    ).toBe(1);
    expect(
      (await index.search("agent", { filter: (agent) => agent.category === "DeFi" })).length,
    ).toBe(1);

    const fieldHits = await index.search("agent", { fields: { category: "Security" } });
    expect(fieldHits.map((hit) => hit.agent.id)).toEqual(["security"]);
  });

  it("matches array fields by membership", async () => {
    const embedder = new TopicEmbedder();
    const index = new SemanticSearchIndex<AgentDocument>({ embedder });
    await index.index([{ ...codeAgent(), tags: ["solidity", "soroban"] }, financeAgent()]);

    const hits = await index.search("agent", { fields: { tags: "soroban" } });
    expect(hits.length).toBe(1);
    expect(hits[0].agent.id).toBe("code");
  });

  it("returns an empty list for an empty query or an empty catalogue", async () => {
    const embedder = new TopicEmbedder();
    const index = new SemanticSearchIndex<AgentDocument>({ embedder });
    expect((await index.search("   ")).length).toBe(0);

    await index.index([]);
    expect((await index.search("anything")).length).toBe(0);
  });

  it("reports scores inside [0, 1] and exposes a snapshot", async () => {
    const embedder = new TopicEmbedder();
    const index = new SemanticSearchIndex<AgentDocument>({ embedder });
    await index.index([financeAgent(), securityAgent()]);

    const hits = await index.search("financial audit");
    for (const hit of hits) {
      expect(hit.score >= 0 && hit.score <= 1).toBe(true);
    }

    const snapshot = index.toSnapshot();
    expect(snapshot.length).toBe(2);
    expect(snapshot[0].vector.length).toBe(3);
    expect(index.agents.length).toBe(2);
  });
});

describe("semantic search index resilience", () => {
  it("reuses cached vectors on a rebuild", async () => {
    const embedder = new TopicEmbedder();
    const index = new SemanticSearchIndex<AgentDocument>({ embedder });
    const agents = [financeAgent(), securityAgent(), codeAgent()];

    const first = await index.index(agents);
    expect(first.cacheMisses).toBe(3);
    expect(first.cacheHits).toBe(0);

    const second = await index.index(agents);
    expect(second.cacheHits).toBe(3);
    expect(second.cacheMisses).toBe(3);
    // Nothing had to be re-embedded: the whole batch came from the cache.
    expect(embedder.calls).toBe(1);
  });

  it("switches to the fallback embedder when the model fails", async () => {
    const failures: string[] = [];
    const index = new SemanticSearchIndex<AgentDocument>({
      embedder: new FailingEmbedder(),
      fallbackEmbedder: new LexicalEmbedder({ dimensions: 32 }),
      onEmbedderError: (error) => failures.push(String(error)),
    });

    const stats = await index.index([financeAgent(), securityAgent()]);
    expect(stats.size).toBe(2);
    expect(index.activeEmbedder.id).toBe("lexical-hash-32");
    expect(failures.length).toBe(1);

    const hits = await index.search("sentinel security");
    expect(hits[0].agent.id).toBe("security");
  });

  it("keeps unembedded agents searchable by keyword when no embedder works", async () => {
    const index = new SemanticSearchIndex<AgentDocument>({
      embedder: new FailingEmbedder(),
    });
    const stats = await index.index([securityAgent(), financeAgent()]);
    expect(stats.size).toBe(0);
    expect(index.size).toBe(0);

    const hits = await index.search("sentinel", { minScore: 0.5 });
    expect(hits.length).toBe(1);
    expect(hits[0].agent.id).toBe("security");
    expect(hits[0].vectorScore).toBe(0);
  });

  it("ranks lexically when the query itself cannot be embedded", async () => {
    const embedder = new FlakyEmbedder(1);
    const index = new SemanticSearchIndex<AgentDocument>({ embedder });
    const stats = await index.index([securityAgent(), financeAgent()]);
    expect(stats.size).toBe(2);

    const hits = await index.search("sentinel", { minScore: 0.5 });
    expect(hits.length).toBe(1);
    expect(hits[0].vectorScore).toBe(0);
    expect(hits[0].lexicalScore).toBeGreaterThan(0.5);
  });

  it("fails loudly when the query vector is not comparable to the index", async () => {
    const index = new SemanticSearchIndex<AgentDocument>({ embedder: new DriftingEmbedder() });
    const stats = await index.index([securityAgent(), financeAgent()]);
    expect(stats.dimensions).toBe(3);

    let message = "";
    try {
      await index.search("sentinel");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.includes("dimension mismatch")).toBe(true);
  });
});

describe("semantic search service", () => {
  const agents: AgentDocument[] = [financeAgent(), securityAgent(), codeAgent()];
  const offlineModel = {
    loadModule: async () => {
      throw new Error("test: model unavailable");
    },
  };

  it("uses the lexical embedder when the model is opted out", async () => {
    const { embedder, semantic } = await resolveEmbedder({ preferTransformers: false });
    expect(semantic).toBe(false);
    expect(embedder.id.startsWith("lexical-hash")).toBe(true);
  });

  it("falls back with a reason when the model is unavailable", async () => {
    const reasons: string[] = [];
    const { embedder, semantic, reason } = await resolveEmbedder({
      preferTransformers: true,
      transformersOptions: offlineModel,
      onFallback: (value) => reasons.push(value),
    });

    expect(semantic).toBe(false);
    expect(embedder.id.startsWith("lexical-hash")).toBe(true);
    expect(reason !== undefined && reason.length > 0).toBe(true);
    expect(reasons.length).toBe(1);
  });

  it("returns ranked hits and reports which embedder answered", async () => {
    const result = await searchAgentsSemantically(agents, "sentinel security threat", {
      preferTransformers: false,
      limit: 2,
    });

    expect(result.results.length).toBe(2);
    expect(result.results[0].agent.id).toBe("security");
    expect(result.embedder.startsWith("lexical-hash")).toBe(true);
    expect(result.semantic).toBe(false);
    expect(result.indexed).toBe(3);
  });

  it("never throws when the model cannot be loaded", async () => {
    const result = await searchAgentsSemantically(agents, "financial analysis", {
      preferTransformers: true,
      transformersOptions: offlineModel,
    });
    expect(result.indexed).toBe(3);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.semantic).toBe(false);
    expect(result.fallbackReason !== undefined).toBe(true);
  });
});
