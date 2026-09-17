import type { OnModuleInit } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyAdapter } from '@nestjs/platform-fastify';

import { ensureRequestId } from './request-context';

/**
 * Installs {@link ensureRequestId} as Fastify's `onRequest` hook, which is the
 * **only** place in the lifecycle that every response passes through.
 *
 * The interceptor this replaces (issue #19) ran inside Nest's interceptor
 * chain, and two classes of response never build one:
 *
 * - an unmatched route, which `routes-resolver.ts` answers through
 *   `registerNotFoundHandler`;
 * - an adapter-layer failure, answered through `registerExceptionHandler`.
 *
 * Both build a *filter* chain but no *interceptor* chain, so `request.requestId`
 * was never set on them: a 404 answered `"requestId": "unknown"` and carried no
 * `x-request-id` header at all — a correlation hole exactly where scanners,
 * misrouted clients and a mobile app on a stale route land (issue #47).
 *
 * `FastifyAdapter` registers one `onRequest` hook in its own constructor and
 * delegates it to whatever `setOnRequestHook` was last given, so this runs
 * before routing decides anything and cannot fail with Fastify's
 * "cannot add hook after ready" — the hook slot is filled, not added.
 *
 * Registered as an `AppModule` provider rather than from `main.ts` for the
 * reason written up there and in `app.module.ts`: nothing imports `main.ts`, so
 * anything wired only in it is exercised by no test at all. As a provider, every
 * `Test.createTestingModule({ imports: [AppModule] })` gets the real mechanism.
 */
@Injectable()
export class RequestIdHook implements OnModuleInit {
  constructor(private readonly adapterHost: HttpAdapterHost<FastifyAdapter>) {}

  onModuleInit(): void {
    const adapter = this.adapterHost.httpAdapter;

    // Fail at boot rather than per request. The only way to reach this is a
    // non-Fastify adapter, which would silently drop the request id from every
    // response — the failure this class exists to prevent, arriving quietly.
    if (typeof adapter?.setOnRequestHook !== 'function') {
      throw new Error(
        'RequestIdHook requires the Fastify adapter: no setOnRequestHook on the active HTTP adapter.',
      );
    }

    adapter.setOnRequestHook((request, reply, done) => {
      ensureRequestId(request, reply);
      done();
    });
  }
}
