export type SenderAuthResult = 'pass' | 'fail' | 'missing';

interface AuthEntry {
  method: string;
  result: string;
  props: Record<string, string>;
}

function parseHeader(value: string): AuthEntry[] {
  const withoutComments = value.replace(/\([^)]*\)/g, ' ');
  return withoutComments
    .split(';')
    .slice(1)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const tokens = part.split(/\s+/);
      const [method = '', result = ''] = (tokens[0] ?? '').toLowerCase().split('=');
      const props: Record<string, string> = {};
      for (const token of tokens.slice(1)) {
        const eq = token.indexOf('=');
        if (eq > 0) props[token.slice(0, eq).toLowerCase()] = token.slice(eq + 1).toLowerCase();
      }
      return { method, result, props };
    });
}

function aligned(domain: string | undefined, fromDomain: string): boolean {
  if (!domain) return false;
  const d = domain.includes('@') ? domain.split('@').pop()! : domain;
  return d === fromDomain || d.endsWith(`.${fromDomain}`) || fromDomain.endsWith(`.${d}`);
}

export function evaluateSenderAuth(headers: string[], fromAddress: string): SenderAuthResult {
  const top = headers[0];
  if (top === undefined) return 'missing';
  const fromDomain = fromAddress.toLowerCase().split('@').pop() ?? '';
  const entries = parseHeader(top);

  const dmarc = entries.filter((e) => e.method === 'dmarc');
  if (dmarc.length > 0) {
    const ok = dmarc.every(
      (e) =>
        e.result === 'pass' &&
        (e.props['header.from'] === undefined || e.props['header.from'] === fromDomain),
    );
    return ok ? 'pass' : 'fail';
  }

  const dkimPass = entries.some(
    (e) => e.method === 'dkim' && e.result === 'pass' && aligned(e.props['header.d'], fromDomain),
  );
  const spfPass = entries.some(
    (e) =>
      e.method === 'spf' && e.result === 'pass' && aligned(e.props['smtp.mailfrom'], fromDomain),
  );
  return dkimPass || spfPass ? 'pass' : 'fail';
}
