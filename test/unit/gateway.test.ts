import { describe, expect, it } from 'vitest';
import { Gateway } from '../../src/services/gateway.js';
import { createTestContext } from '../helpers/fakes.js';

describe('Gateway.byKey', () => {
  it('maps each key to exactly its own mailbox', () => {
    const a = createTestContext({
      name: 'a',
      address: 'a@test.local',
      api_key: 'a'.repeat(32),
    }).ctx;
    const b = createTestContext({
      name: 'b',
      address: 'b@test.local',
      api_key: 'b'.repeat(32),
    }).ctx;
    const gw = new Gateway([a, b]);
    expect(gw.byKey('a'.repeat(32))).toBe(a);
    expect(gw.byKey('b'.repeat(32))).toBe(b);
    expect(gw.byKey('c'.repeat(32))).toBeNull();
    expect(gw.byKey('')).toBeNull();
  });
});
