export function generateChecksum(payload: string): string {
  let hash = 0;
  for (let i = 0; i < payload.length; i++) {
    const char = payload.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

export function encodeReferralParams(params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  const searchParams = new URLSearchParams();
  
  let payloadStr = '';
  for (const key of sortedKeys) {
    searchParams.set(key, params[key]);
    payloadStr += `${key}=${params[key]}|`;
  }
  
  const checksum = generateChecksum(payloadStr);
  searchParams.set('chk', checksum);
  
  return searchParams.toString();
}

export function verifyReferralChecksum(queryString: string): boolean {
  const searchParams = new URLSearchParams(queryString);
  const providedChecksum = searchParams.get('chk');
  if (!providedChecksum) return false;
  
  searchParams.delete('chk');
  const sortedKeys = Array.from(searchParams.keys()).sort();
  
  let payloadStr = '';
  for (const key of sortedKeys) {
    payloadStr += `${key}=${searchParams.get(key)}|`;
  }
  
  const expectedChecksum = generateChecksum(payloadStr);
  return expectedChecksum === providedChecksum;
}
