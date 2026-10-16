import type Redis from 'ioredis';

/**
 * Every key matching `pattern`, read with `SCAN` rather than `KEYS` (#367).
 *
 * **Why not `KEYS`.** Redis is single-threaded, and `KEYS` walks the whole
 * keyspace in one command: every other client, which is every other test file
 * in the run, waits until it is done. With a hundred thousand keys left by
 * earlier runs on a developer's Redis, each call held everyone for 23–60 ms.
 * `SCAN` walks the same keyspace a slice at a time, between other clients'
 * commands, and returns the same set.
 *
 * A key may be reported twice by `SCAN`; the result is deduplicated.
 */
export async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const found = new Set<string>();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
    for (const key of keys) {
      found.add(key);
    }
    cursor = next;
  } while (cursor !== '0');
  return [...found];
}

/**
 * Deletes every key matching `pattern`, a batch at a time, with `UNLINK`
 * (the memory is freed off the main thread). Returns how many were deleted.
 */
export async function deleteKeys(redis: Redis, pattern: string): Promise<number> {
  const keys = await scanKeys(redis, pattern);
  let deleted = 0;
  for (let start = 0; start < keys.length; start += 500) {
    deleted += await redis.unlink(...keys.slice(start, start + 500));
  }
  return deleted;
}
