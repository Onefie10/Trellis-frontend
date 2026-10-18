export type Vector = Record<string, number>;

export function cosineSimilarity(vecA: Vector, vecB: Vector): number {
  const keysA = Object.keys(vecA);
  const keysB = Object.keys(vecB);
  
  if (keysA.length === 0 || keysB.length === 0) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (const key of keysA) {
    normA += vecA[key] * vecA[key];
    if (vecB[key]) {
      dotProduct += vecA[key] * vecB[key];
    }
  }
  
  for (const key of keysB) {
    normB += vecB[key] * vecB[key];
  }
  
  if (normA === 0 || normB === 0) return 0;
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function extractTextVector(text: string): Vector {
  const terms = text.toLowerCase().match(/\b\w+\b/g) || [];
  const vec: Vector = {};
  const stopWords = ['the','a','an','and','or','but','in','on','at','to','for','is','are','was','were','of','with','as'];
  
  for (const term of terms) {
    if (!stopWords.includes(term) && term.length > 2) {
      vec[term] = (vec[term] || 0) + 1;
    }
  }
  return vec;
}
