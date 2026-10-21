import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it, vi } from 'vitest';

import { parseEnv } from '../config/parse-env';
import { DeferredJobHandlerRegistry } from './deferred-job-handler.registry';
import { DeferredQueueProcessor } from './deferred-queue.processor';
import { PermanentJobError } from './queue.types';
import type { DeferredJobPayload } from './queue.types';

const CONFIG = parseEnv({
  DATABASE_URL: 'postgresql://tezusta:tezusta@localhost:5432/tezusta',
  REDIS_URL: 'redis://localhost:6379',
});

class TestProcessor extends DeferredQueueProcessor {
  constructor(handlers: DeferredJobHandlerRegistry) {
    super('arrival', handlers, CONFIG, { mode: 'off', concurrency: 1, modeVariable: 'TEST' });
  }
}

/** The fields `process` reads, as BullMQ hands a job over. */
function job(attemptsMade: number, attempts = 3): Job<DeferredJobPayload> {
  return {
    name: 'arrival-promise',
    id: 'job-7',
    data: { orderId: 'order-1' },
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<DeferredJobPayload>;
}

/** What a test reads back from a logger spy. */
interface Calls {
  readonly mock: { readonly calls: readonly (readonly unknown[])[] };
}

function setUp(failure: Error) {
  const handlers = new DeferredJobHandlerRegistry();
  handlers.register('arrival-promise', () => Promise.reject(failure));
  const processor = new TestProcessor(handlers);
  const logger = processor['deferredLogger'];
  return {
    processor,
    warn: vi.spyOn(logger, 'warn').mockImplementation(() => undefined),
    error: vi.spyOn(logger, 'error').mockImplementation(() => undefined),
  };
}

function lines(spy: Calls): string {
  return spy.mock.calls.map((call) => String(call[0])).join('\n');
}

describe('DeferredQueueProcessor failures (#426)', () => {
  it('only warns about an attempt that will be retried', async () => {
    const { processor, warn, error } = setUp(new Error('redis blinked'));

    await expect(processor.process(job(0))).rejects.toThrow('redis blinked');

    expect(warn).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  it('raises one error line when the last attempt fails, naming the queue, job and attempts', async () => {
    const { processor, error } = setUp(new Error('redis blinked'));

    await expect(processor.process(job(2))).rejects.toThrow('redis blinked');

    expect(error).toHaveBeenCalledOnce();
    const written = lines(error);
    expect(written).toContain('"arrival"');
    expect(written).toContain('"arrival-promise"');
    expect(written).toContain('job-7');
    expect(written).toContain('3/3');
    expect(written).not.toContain('order-1');
  });

  it('raises the error line on the first attempt of a permanent failure', async () => {
    const { processor, error } = setUp(new PermanentJobError('the order is gone'));

    await expect(processor.process(job(0))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(error).toHaveBeenCalledOnce();
    expect(lines(error)).toContain('1/3');
  });

  it("never writes a failed query's bound parameters, in either line", async () => {
    const { processor, warn, error } = setUp(
      new DrizzleQueryError(
        'select 1 from master_locations where ST_MakePoint($1, $2)',
        [49.842717, 40.372613],
        new Error('connection terminated'),
      ),
    );

    await expect(processor.process(job(2))).rejects.toThrow();

    const written = `${lines(warn)}\n${lines(error)}`;
    expect(written).toContain('select 1 from master_locations');
    expect(written).not.toContain('49.842717');
    expect(written).not.toContain('40.372613');
  });
});
