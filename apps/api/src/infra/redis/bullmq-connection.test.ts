import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';

import { createBullmqRedisClient } from './bullmq-connection.provider';

/**
 * The evidence ADR-0025 rests on, pinned as a test.
 *
 * The decision to open a SECOND Redis connection instead of reusing
 * `REDIS_CLIENT` is only justified while the constraint below is real. It is
 * a vendor behaviour, so it can change under a patch release without anything
 * in this repository failing to compile — and if it ever does change, the
 * second connection becomes dead weight nobody would think to remove. This
 * file is what tells us.
 *
 * It needs the real Redis: BullMQ resolves and validates the connection while
 * constructing the worker.
 */
describe('the BullMQ Redis connection', () => {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const prefix = process.env.QUEUE_PREFIX ?? 'test';
  const queueName = `connection-probe-${String(process.pid)}`;
  const opened: Redis[] = [];

  function open(options: { readonly maxRetriesPerRequest: number | null }): Redis {
    const client =
      options.maxRetriesPerRequest === null
        ? createBullmqRedisClient(url)
        : new Redis(url, { maxRetriesPerRequest: options.maxRetriesPerRequest });
    client.on('error', () => undefined);
    opened.push(client);
    return client;
  }

  afterAll(() => {
    for (const client of opened) {
      client.disconnect();
    }
  });

  it('is built with maxRetriesPerRequest: null, unlike the shared REDIS_CLIENT', () => {
    const client = open({ maxRetriesPerRequest: null });

    expect(client.options.maxRetriesPerRequest).toBeNull();
  });

  it("keeps the shared client's retry strategy, so it never stops reconnecting", () => {
    const client = open({ maxRetriesPerRequest: null });
    const strategy = client.options.retryStrategy;

    expect(strategy).toBeTypeOf('function');
    // `retryStrategy` is typed as possibly undefined by ioredis; the guard is
    // for the type system, and the assertion above is what actually fails if
    // the provider ever stops setting it.
    if (typeof strategy === 'function') {
      expect(strategy(10_000)).toBe(2000);
    }
  });

  it('is necessary: a Worker on a connection with maxRetriesPerRequest set throws at construction', () => {
    const shared = open({ maxRetriesPerRequest: 1 });

    expect(
      () => new Worker(queueName, () => Promise.resolve(undefined), { connection: shared, prefix }),
    ).toThrowError(/maxRetriesPerRequest must be null/);
  });

  it('is sufficient: a Worker on the dedicated connection constructs', async () => {
    const dedicated = open({ maxRetriesPerRequest: null });

    const worker = new Worker(queueName, () => Promise.resolve(undefined), {
      connection: dedicated,
      prefix,
      autorun: false,
    });
    worker.on('error', () => undefined);

    await worker.close();
  });

  it('is a Worker-only constraint — a Queue on the shared connection is unaffected', async () => {
    const shared = open({ maxRetriesPerRequest: 1 });

    const queue = new Queue(queueName, { connection: shared, prefix });
    await queue.close();
  });
});
