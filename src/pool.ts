/**
 * Minimal concurrency limiter.
 *
 * The Framer CDN throttles: nine simultaneous requests produced six connection
 * failures that all succeeded on retry. Every bulk fetch in this project goes
 * through here rather than a bare `Promise.all`, which would reliably trip it.
 *
 * Written by hand instead of pulling in p-limit — it is twenty lines and the
 * dependency surface of an export tool is worth keeping small.
 */

/** Default parallelism per host. Measured as safe against framerusercontent. */
export const DEFAULT_CONCURRENCY = 4;

/**
 * Run `worker` over every item, at most `limit` at a time, preserving input
 * order in the results.
 *
 * Rejections are captured per item rather than aborting the batch — one dead
 * route should not lose the other forty. Inspect `.error` on each result.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  limit: number = DEFAULT_CONCURRENCY,
): Promise<Array<{ value?: R; error?: unknown; item: T }>> {
  const results: Array<{ value?: R; error?: unknown; item: T }> = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { value: await worker(items[index], index), item: items[index] };
      } catch (error) {
        results[index] = { error, item: items[index] };
      }
    }
  });

  await Promise.all(runners);
  return results;
}
