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

function authservId(value: string): string {
  return (value.split(';')[0] ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}

/** DMARC results that are an actual verdict; none/temperror/permerror mean "no verdict". */
const DMARC_VERDICTS = new Set(['pass', 'fail', 'quarantine', 'reject']);

/**
 * Evaluates the Authentication-Results added by the receiving server. Uses the top-most header,
 * or, when `trustedAuthservId` is set, the top-most header from that server only.
 */
export function evaluateSenderAuth(
  headers: string[],
  fromAddress: string,
  trustedAuthservId?: string,
): SenderAuthResult {
  const top = trustedAuthservId
    ? headers.find((h) => authservId(h) === trustedAuthservId.toLowerCase())
    : headers[0];
  if (top === undefined) return 'missing';
  const fromDomain = fromAddress.toLowerCase().split('@').pop() ?? '';
  const entries = parseHeader(top);

  const dmarc = entries.filter((e) => e.method === 'dmarc' && DMARC_VERDICTS.has(e.result));
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
