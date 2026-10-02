import { describe, expect, it } from 'vitest';
import { disallowed, isAllowed, matchesPattern } from '../../src/policy/address.js';
import { decideInbound } from '../../src/policy/inbound.js';
import { evaluateSenderAuth } from '../../src/policy/sender-auth.js';

describe('address matching', () => {
  it('matches exact addresses case-insensitively', () => {
    expect(matchesPattern('you@example.net', 'you@example.net')).toBe(true);
    expect(matchesPattern('other@example.net', 'you@example.net')).toBe(false);
  });

  it('matches *@domain only for that exact domain', () => {
    expect(matchesPattern('a@example.org', '*@example.org')).toBe(true);
    expect(matchesPattern('a@mail.example.org', '*@example.org')).toBe(false);
    expect(matchesPattern('a@evilexample.org', '*@example.org')).toBe(false);
  });

  it('isAllowed is false for an empty list', () => {
    expect(isAllowed('a@b.de', [])).toBe(false);
  });

  it('disallowed returns unique offending addresses', () => {
    expect(disallowed(['a@ok.de', 'X@bad.de', 'x@bad.de'], ['*@ok.de'])).toEqual(['x@bad.de']);
  });
});

describe('evaluateSenderAuth', () => {
  it('passes on dmarc=pass', () => {
    expect(
      evaluateSenderAuth(['mx.example; dmarc=pass header.from=example.net'], 'a@example.net'),
    ).toBe('pass');
  });

  it('fails on dmarc=fail even if dkim passes', () => {
    const h = 'mx; dkim=pass header.d=example.net; dmarc=fail (p=reject) header.from=example.net';
    expect(evaluateSenderAuth([h], 'a@example.net')).toBe('fail');
  });

  it('uses aligned dkim or spf when there is no dmarc result', () => {
    expect(evaluateSenderAuth(['mx; dkim=pass header.d=example.net'], 'a@example.net')).toBe(
      'pass',
    );
    expect(
      evaluateSenderAuth(['mx; spf=pass smtp.mailfrom=bounce@example.net'], 'a@example.net'),
    ).toBe('pass');
    expect(evaluateSenderAuth(['mx; dkim=pass header.d=other.com'], 'a@example.net')).toBe('fail');
  });

  it('only looks at the top-most header', () => {
    expect(evaluateSenderAuth(['mx; dmarc=fail', 'forged; dmarc=pass'], 'a@example.net')).toBe(
      'fail',
    );
  });

  it('reports missing when there is no header', () => {
    expect(evaluateSenderAuth([], 'a@example.net')).toBe('missing');
  });
});

describe('decideInbound', () => {
  const cfg = { allow_receive_from: ['boss@test.local'], require_sender_auth: true };

  it('allows an allowed, authenticated sender', () => {
    expect(
      decideInbound(cfg, { from: 'Boss@Test.local', authResults: ['mx; dmarc=pass'] }),
    ).toEqual({ allowed: true });
  });

  it('rejects senders not on the list before checking auth', () => {
    expect(decideInbound(cfg, { from: 'x@test.local', authResults: [] })).toEqual({
      allowed: false,
      reason: 'sender_not_allowed',
    });
  });

  it('rejects a missing From header', () => {
    expect(decideInbound(cfg, { from: null, authResults: [] })).toEqual({
      allowed: false,
      reason: 'sender_not_allowed',
    });
  });

  it('distinguishes missing and failed auth', () => {
    expect(decideInbound(cfg, { from: 'boss@test.local', authResults: [] })).toEqual({
      allowed: false,
      reason: 'sender_auth_missing',
    });
    expect(
      decideInbound(cfg, { from: 'boss@test.local', authResults: ['mx; dmarc=fail'] }),
    ).toEqual({ allowed: false, reason: 'sender_auth_failed' });
  });

  it('skips auth when require_sender_auth is false', () => {
    expect(
      decideInbound(
        { ...cfg, require_sender_auth: false },
        { from: 'boss@test.local', authResults: [] },
      ),
    ).toEqual({ allowed: true });
  });
});
