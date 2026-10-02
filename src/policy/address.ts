export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

function domainOf(address: string): string | null {
  const parts = address.split('@');
  return parts.length === 2 && parts[0] && parts[1] ? parts[1] : null;
}

export function matchesPattern(address: string, pattern: string): boolean {
  const a = normalizeAddress(address);
  const p = normalizeAddress(pattern);
  if (p.startsWith('*@')) return domainOf(a) === p.slice(2);
  return a === p;
}

export function isAllowed(address: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPattern(address, p));
}

export function disallowed(addresses: string[], patterns: string[]): string[] {
  const bad = addresses.map(normalizeAddress).filter((a) => !isAllowed(a, patterns));
  return [...new Set(bad)];
}
