/**
 * Text normalisation and the lexical half of the hybrid score.
 *
 * MiniLM is trained on prose, not on `DataBotPro_v2 (DeFi)` — so the text handed
 * to the embedder is normalised first (camelCase split, separators removed,
 * punctuation stripped) and the same tokens feed the keyword score.
 */

/** Words that carry no signal in a marketplace query ("an agent for …"). */
export const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "do",
  "for",
  "from",
  "get",
  "has",
  "have",
  "i",
  "in",
  "is",
  "it",
  "its",
  "me",
  "my",
  "need",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "which",
  "who",
  "will",
  "with",
  "you",
  "your",
]);

/** Splits `camelCase`, `PascalCase` and `snake_case` into separate words. */
export function splitWords(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-/\\]+/g, " ");
}

/**
 * Lower-cases, splits identifiers, drops punctuation and collapses whitespace.
 *
 * Emoji and non-Latin scripts survive: they are legitimate content, and stripping
 * them would silently make some agents unsearchable.
 */
export function normaliseText(input: string): string {
  return splitWords(String(input ?? ""))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Query/document tokens: normalised, de-duplicated, stop words removed.
 *
 * A query made entirely of stop words keeps them — `"the who"` must not become
 * an empty search.
 */
export function tokenize(input: string): string[] {
  const tokens = normaliseText(input)
    .split(" ")
    .filter((token) => token.length > 0);

  const meaningful = tokens.filter((token) => !STOP_WORDS.has(token));
  return meaningful.length > 0 ? meaningful : tokens;
}

/** Default character n-gram width. 3 is short enough to bridge `audit`/`auditing`. */
export const NGRAM_SIZE = 3;

/** Character n-grams, which give partial credit for `audit` vs `auditing`. */
export function charNgrams(token: string, size = NGRAM_SIZE): string[] {
  if (token.length <= size) return [token];
  const grams: string[] = [];
  for (let i = 0; i + size <= token.length; i += 1) {
    grams.push(token.slice(i, i + size));
  }
  return grams;
}

/** Field weights for the agent document, most specific first. */
export const FIELD_WEIGHTS = {
  name: 4,
  category: 2.5,
  tags: 2,
  capabilities: 1.5,
  description: 1,
  author: 0.5,
} as const;

export interface AgentFields {
  name: string;
  category: string;
  tags: string;
  capabilities: string;
  description: string;
  author: string;
}

export function agentFields(agent: {
  name?: unknown;
  description?: unknown;
  category?: unknown;
  capabilities?: unknown;
  tags?: unknown;
  author?: unknown;
}): AgentFields {
  return {
    name: String(agent.name ?? ""),
    category: String(agent.category ?? ""),
    tags: Array.isArray(agent.tags) ? agent.tags.join(" ") : "",
    capabilities: Array.isArray(agent.capabilities)
      ? agent.capabilities.join(" ")
      : "",
    description: String(agent.description ?? ""),
    author: String(agent.author ?? ""),
  };
}

/**
 * The text a vector is computed from.
 *
 * Name and category are repeated so the model sees them more than once — a
 * cheaper way to weight a field than separate per-field vectors, and the
 * description stays intact for the sentence-level context MiniLM is good at.
 */
export function buildAgentDocument(agent: {
  name?: unknown;
  description?: unknown;
  category?: unknown;
  capabilities?: unknown;
  tags?: unknown;
  author?: unknown;
}): string {
  const fields = agentFields(agent);
  const parts: string[] = [];

  if (fields.name) parts.push(fields.name, fields.name);
  if (fields.category) parts.push(`category ${fields.category}`, fields.category);
  if (fields.tags) parts.push(`tags ${fields.tags}`);
  if (fields.capabilities) parts.push(`capabilities ${fields.capabilities}`);
  if (fields.description) parts.push(fields.description);
  if (fields.author) parts.push(`by ${fields.author}`);

  const document = normaliseText(parts.join(". "));
  return document === "" ? "unnamed agent" : document;
}

/** Same weighting, but as a token list the lexical scorer can use. */
export function weightedDocumentTokens(agent: {
  name?: unknown;
  description?: unknown;
  category?: unknown;
  capabilities?: unknown;
  tags?: unknown;
  author?: unknown;
}): Map<string, number> {
  const fields = agentFields(agent);
  const weights = new Map<string, number>();

  const add = (text: string, weight: number) => {
    for (const token of tokenize(text)) {
      weights.set(token, Math.max(weights.get(token) ?? 0, weight));
    }
  };

  add(fields.name, FIELD_WEIGHTS.name);
  add(fields.category, FIELD_WEIGHTS.category);
  add(fields.tags, FIELD_WEIGHTS.tags);
  add(fields.capabilities, FIELD_WEIGHTS.capabilities);
  add(fields.description, FIELD_WEIGHTS.description);
  add(fields.author, FIELD_WEIGHTS.author);

  return weights;
}

/**
 * Weighted keyword overlap in `[0, 1]`.
 *
 * Exact token matches earn the full field weight; otherwise the best character
 * n-gram Jaccard against any document token earns a partial share, which is what
 * makes "auditing" find "audit" without a stemmer. Partial credit is capped at
 * the description weight, so it can only ever break a tie — a real token match
 * always outranks it.
 */
export function lexicalScore(
  query: string,
  agent: Parameters<typeof weightedDocumentTokens>[0],
): { score: number; matchedTerms: string[] } {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return { score: 0, matchedTerms: [] };

  const weights = weightedDocumentTokens(agent);
  const documentTokens = [...weights.keys()];
  const grams = new Map<string, Set<string>>();
  for (const token of documentTokens) {
    grams.set(token, new Set(charNgrams(token)));
  }

  let total = 0;
  let best = 0;
  const matchedTerms: string[] = [];

  for (const token of queryTokens) {
    total += FIELD_WEIGHTS.name;
    const exact = weights.get(token) ?? 0;

    if (exact > 0) {
      best += exact;
      matchedTerms.push(token);
      continue;
    }

    const tokenGrams = new Set(charNgrams(token));
    let partial = 0;
    for (const candidate of documentTokens) {
      const candidateGrams = grams.get(candidate) ?? new Set<string>();
      let shared = 0;
      for (const gram of tokenGrams) {
        if (candidateGrams.has(gram)) shared += 1;
      }
      const union = tokenGrams.size + candidateGrams.size - shared;
      if (union === 0) continue;

      const jaccard = shared / union;
      // Only meaningful overlap counts, and a shared prefix alone is too weak.
      if (jaccard >= 0.5) {
        partial = Math.max(partial, jaccard * FIELD_WEIGHTS.description);
      }
    }

    if (partial > 0) {
      best += partial;
      matchedTerms.push(token);
    }
  }

  return { score: total === 0 ? 0 : Math.min(1, best / total), matchedTerms };
}
