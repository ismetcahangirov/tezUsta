import { Injectable } from '@nestjs/common';

import type { DeferredJobHandler } from './queue.types';

/**
 * Raised when a job arrives for a name nobody registered.
 *
 * A named error rather than a bare `Error` so the processor can tell "the
 * handler failed" from "there is no handler", and so a test can assert the
 * difference. The distinction matters operationally: the first is a bug in
 * the work, the second is a deploy in which a job outlived the code that
 * knew how to run it — a job enqueued by the previous release and picked up
 * by this one.
 */
export class UnknownDeferredJobError extends Error {
  constructor(readonly jobName: string) {
    super(`No handler is registered for deferred job "${jobName}"`);
    this.name = 'UnknownDeferredJobError';
  }
}

/**
 * Where a feature module says what to do when one of its deferred jobs comes
 * due, without this module importing it.
 *
 * The same shape as {@link ReadinessCheckRegistry}, and for the same reason:
 * `infra/` must fan out into `modules/`, never back. The dispatch engine
 * (#103) registers `radius-widen` and `give-up` from its own `onModuleInit`;
 * `infra/queue` keeps knowing nothing about dispatch beyond the queue's name.
 *
 * It is also what makes moving the worker into its own process a bootstrap
 * change rather than a redesign: that process imports the feature modules it
 * must serve, they register their handlers into this registry exactly as they
 * do now, and nothing in `infra/queue` changes.
 */
@Injectable()
export class DeferredJobHandlerRegistry {
  private readonly handlers = new Map<string, DeferredJobHandler>();

  /**
   * Registering the same name twice is a programming error, not a
   * last-one-wins merge: two modules both believing they own `give-up` would
   * otherwise produce a system whose behaviour depends on module import
   * order, which is exactly the class of bug `app.module.ts` documents at
   * length for guards.
   */
  register(name: string, handler: DeferredJobHandler): void {
    if (this.handlers.has(name)) {
      throw new Error(`A handler for deferred job "${name}" is already registered`);
    }
    this.handlers.set(name, handler);
  }

  /** @throws UnknownDeferredJobError when nothing is registered for `name`. */
  resolve(name: string): DeferredJobHandler {
    const handler = this.handlers.get(name);
    if (handler === undefined) {
      throw new UnknownDeferredJobError(name);
    }
    return handler;
  }

  /** Registered job names, for the readiness/diagnostic surface and tests. */
  names(): readonly string[] {
    return [...this.handlers.keys()];
  }
}
