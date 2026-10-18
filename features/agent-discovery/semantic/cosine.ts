/**
 * Vector maths for semantic search.
 *
 * Plain `Float32Array` maths with no dependencies: embeddings arrive as typed
 * arrays from the model, and keeping them as such avoids allocating a number[]
 * per agent on every search.
 */

/** Throws when a vector pair cannot be compared — a real bug, not a soft fail. */
export function assertSameDimensions(a: Float32Array, b: Float32Array): void {
  if (a.length !== b.length) {
    throw new Error(
      `embedding dimension mismatch: ${a.length} vs ${b.length} — query and index must use the same model`,
    );
  }
}

export function dot(a: Float32Array, b: Float32Array): number {
  assertSameDimensions(a, b);
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

export function norm(vector: Float32Array): number {
  return Math.sqrt(dot(vector, vector));
}

/**
 * Returns an L2-normalised copy, or a zero vector when the input is all zeros.
 *
 * Copying rather than mutating matters: the cache hands the same vector to more
 * than one caller.
 */
export function normalise(vector: Float32Array): Float32Array {
  const length = norm(vector);
  if (length === 0) return new Float32Array(vector.length);

  const output = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) output[i] = vector[i] / length;
  return output;
}

/**
 * Cosine similarity in `[-1, 1]`.
 *
 * Normalised vectors are expected (the embedders normalise on the way out), but
 * the denominator is still applied so a raw vector cannot produce a bogus score
 * above 1. A zero vector scores 0 against everything instead of NaN.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  assertSameDimensions(a, b);
  const denominator = norm(a) * norm(b);
  if (denominator === 0) return 0;

  const similarity = dot(a, b) / denominator;
  return Math.max(-1, Math.min(1, similarity));
}

/** Maps a cosine score from `[-1, 1]` onto `[0, 1]`. */
export function toUnitScore(similarity: number): number {
  return (Math.max(-1, Math.min(1, similarity)) + 1) / 2;
}

/** Sorts by `score` descending, then by the original index for stable output. */
export function sortByScoreDescending<T extends { score: number }>(
  items: T[],
  indexOf: (item: T) => number,
): T[] {
  return [...items].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return indexOf(a) - indexOf(b);
  });
}

/**
 * Mean pooling over token embeddings, as used by sentence-transformer models.
 *
 * `attentionMask` is optional because the Transformers.js pipeline returns
 * unpadded output; it exists for tokenizers configured with padding.
 */
export function meanPool(
  tokenEmbeddings: Float32Array[],
  attentionMask?: number[],
): Float32Array {
  if (tokenEmbeddings.length === 0) return new Float32Array(0);

  const dimensions = tokenEmbeddings[0].length;
  const pooled = new Float32Array(dimensions);
  let counted = 0;

  for (let t = 0; t < tokenEmbeddings.length; t += 1) {
    if (attentionMask && attentionMask[t] === 0) continue;
    const token = tokenEmbeddings[t];
    if (token.length !== dimensions) {
      throw new Error("meanPool: ragged token embeddings");
    }
    for (let i = 0; i < dimensions; i += 1) pooled[i] += token[i];
    counted += 1;
  }

  if (counted === 0) return new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i += 1) pooled[i] /= counted;
  return pooled;
}

/** Rounds to 5 decimals — enough for ranking, much smaller in storage. */
export function quantiseVector(vector: Float32Array, decimals = 5): number[] {
  const factor = 10 ** decimals;
  return Array.from(vector, (value) => Math.round(value * factor) / factor);
}
