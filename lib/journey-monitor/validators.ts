/**
 * Address and parameter validators for synthetic journey monitor.
 */

export function isValidStellarAddress(address: string): boolean {
  if (!address || typeof address !== 'string' || address.length !== 56) {
    return false;
  }
  return /^G[A-Z0-9]{55}$/.test(address);
}
