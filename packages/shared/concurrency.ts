/**
 * Client-side concurrency guardrail for tools and tests.
 *
 * LocalStack runs each Lambda invocation in its own Docker container, so
 * "30 concurrent requests" means "30 containers on your laptop". During
 * development a 25-wide burst reproducibly wedged the emulator: the edge port
 * stopped answering and the run had to be restarted. Real Lambda absorbs that
 * without noticing; this is the sharpest difference between the local
 * environment and AWS, and it is a property of the emulator rather than of the
 * architecture being prototyped.
 *
 * So every client-side fan-out goes through here. `LOCAL_SAFE_CONCURRENCY` is
 * an empirical ceiling for a 16 GB machine — raise it on a bigger host, or
 * remove the wrapper entirely when pointing at real AWS.
 */
export const LOCAL_SAFE_CONCURRENCY = Number(process.env.LOCAL_SAFE_CONCURRENCY ?? 8);

/**
 * Runs tasks with at most `limit` in flight. Results keep input order, and a
 * rejected task resolves to its error rather than aborting the batch, so a
 * caller measuring failure rates still sees every outcome.
 */
export async function mapLimit<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  limit = LOCAL_SAFE_CONCURRENCY,
): Promise<(R | Error)[]> {
  const results = new Array<R | Error>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        results[index] = err instanceof Error ? err : new Error(String(err));
      }
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Fires `count` requests back to back with no concurrency at all.
 *
 * This is the right shape for exercising a *rate* limit: a token bucket cares
 * about requests per second, not about how many are in flight. Keeping it
 * serial tests the limiter honestly while placing the least possible load on
 * the emulator.
 */
export async function rapidSerial<R>(
  count: number,
  fn: (index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < count; i++) results.push(await fn(i));
  return results;
}
