export async function waitFor<T>(
  fn: () => T | Promise<T>,
  timeoutMs = 15_000,
): Promise<Exclude<T, null | undefined | false | 0 | ''>> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v as Exclude<T, null | undefined | false | 0 | ''>;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`waitFor timed out${last ? `: ${(last as Error).message}` : ''}`);
}

export const silentLogger = { info() {}, warn() {}, error() {} };
