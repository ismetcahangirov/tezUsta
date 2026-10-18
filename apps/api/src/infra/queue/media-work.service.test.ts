import { Queue, QueueEvents, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { parseEnv } from '../config/parse-env';
import { createBullmqRedisClient } from '../redis/bullmq-connection.provider';
import { MediaWorkService } from './media-work.service';

/**
 * `MediaWorkService.enqueue` against a real Redis (#374): a rescue enqueue
 * must reach a job that gave up, and must still not duplicate a live one.
 *
 * Its own queue name per run, so nothing here touches the app's `media` queue.
 */
describe('MediaWorkService.enqueue (issue #374)', () => {
  const config = parseEnv({ ...process.env, QUEUE_JOB_ATTEMPTS: '1' });
  const prefix = config.queue.prefix;
  const queueName = `media-work-probe-${String(process.pid)}`;
  const connections: Redis[] = [];
  let queue: Queue;
  let events: QueueEvents;
  let service: MediaWorkService;
  let worker: Worker | undefined;

  function connection(): Redis {
    const client = createBullmqRedisClient(config.redis.url);
    client.on('error', () => undefined);
    connections.push(client);
    return client;
  }

  /** Runs the queue until `jobId` has failed once, then stops the worker. */
  async function failOnce(jobId: string): Promise<void> {
    worker = new Worker(
      queueName,
      () => {
        throw new Error('boom');
      },
      { connection: connection(), prefix },
    );
    worker.on('error', () => undefined);
    await new Promise<void>((resolve) => {
      events.on('failed', ({ jobId: failed }) => {
        if (failed === jobId) {
          resolve();
        }
      });
    });
    await worker.close();
    worker = undefined;
  }

  beforeAll(async () => {
    queue = new Queue(queueName, { connection: connection(), prefix });
    events = new QueueEvents(queueName, { connection: connection(), prefix });
    await events.waitUntilReady();
    service = new MediaWorkService(queue, config);
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    events.removeAllListeners('failed');
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await events.close();
    await queue.close();
    for (const client of connections) {
      client.disconnect();
    }
  });

  it('adds a job once, however often the same id is enqueued while it waits', async () => {
    await service.enqueue('process-media', { purpose: 'p', itemId: 'a' }, 'p-a');
    await service.enqueue('process-media', { purpose: 'p', itemId: 'a' }, 'p-a');

    expect(await queue.getJobCounts('waiting', 'failed')).toEqual({ waiting: 1, failed: 0 });
  });

  it('retries a failed job under the id, with its attempts starting again', async () => {
    const failed = failOnce('p-b');
    await service.enqueue('process-media', { purpose: 'p', itemId: 'b' }, 'p-b');
    await failed;
    expect(await (await queue.getJob('p-b'))?.getState()).toBe('failed');

    await service.enqueue('process-media', { purpose: 'p', itemId: 'b' }, 'p-b');

    const job = await queue.getJob('p-b');
    expect(await job?.getState()).toBe('waiting');
    expect(job?.attemptsMade).toBe(0);
    expect(await queue.getJobCounts('waiting', 'failed')).toEqual({ waiting: 1, failed: 0 });
  });

  it('lets two rescue enqueues of the same failed job race without an error', async () => {
    const failed = failOnce('p-c');
    await service.enqueue('process-media', { purpose: 'p', itemId: 'c' }, 'p-c');
    await failed;

    await Promise.all([
      service.enqueue('process-media', { purpose: 'p', itemId: 'c' }, 'p-c'),
      service.enqueue('process-media', { purpose: 'p', itemId: 'c' }, 'p-c'),
    ]);

    expect(await (await queue.getJob('p-c'))?.getState()).toBe('waiting');
  });
});
