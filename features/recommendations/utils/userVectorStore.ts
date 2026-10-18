import { Vector } from './similarity';

const VECTOR_KEY = 'trellis_user_profile_vector';
const SETTINGS_KEY = 'trellis_recommendations_enabled';

export function isRecommendationEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  const setting = localStorage.getItem(SETTINGS_KEY);
  return setting !== 'false';
}

export function setRecommendationEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(SETTINGS_KEY, enabled.toString());
  if (!enabled) {
    clearUserVector();
  }
}

export function getUserVector(): Vector {
  if (typeof window === 'undefined') return {};
  if (!isRecommendationEnabled()) return {};
  
  try {
    const data = localStorage.getItem(VECTOR_KEY);
    return data ? JSON.parse(data) : {};
  } catch (e) {
    return {};
  }
}

export function updateUserVector(terms: string[], weight: number = 1): void {
  if (typeof window === 'undefined') return;
  if (!isRecommendationEnabled()) return;
  
  const currentVector = getUserVector();
  
  for (const term of terms) {
    const t = term.toLowerCase();
    currentVector[t] = (currentVector[t] || 0) + weight;
  }
  
  const keys = Object.keys(currentVector);
  for (const key of keys) {
    if (currentVector[key] > 100) currentVector[key] = 100; // Cap to prevent unbounded growth
  }
  
  localStorage.setItem(VECTOR_KEY, JSON.stringify(currentVector));
}

export function trackAgentInteraction(agentName: string, description: string, category: string = ''): void {
  if (!isRecommendationEnabled()) return;
  const text = `${agentName} ${description} ${category}`;
  const terms = text.toLowerCase().match(/\b\w+\b/g) || [];
  const stopWords = ['the','a','an','and','or','but','in','on','at','to','for','is','are','was','were','of','with','as'];
  const filtered = terms.filter(t => !stopWords.includes(t) && t.length > 2);
  
  updateUserVector(filtered, 1);
}

export function clearUserVector(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(VECTOR_KEY);
}
