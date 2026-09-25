import type { OnModuleInit } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyAdapter } from '@nestjs/platform-fastify';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';

/**
 * One year, with subdomains covered — the usual conservative HSTS ceiling.
 * `preload` is deliberately omitted: submitting to the preload list is an
 * infrastructure decision (it is very hard to reverse), not one this hook
 * should make unilaterally.
 */
const HSTS_HEADER_VALUE = 'max-age=31536000; includeSubDomains';

/**
 * Installs a handful of security response headers on **every** response —
 * including the two classes of response that never build a Nest interceptor
 * chain (an unmatched route and an adapter-layer failure, issue #47) — by
 * filling Fastify's `onSend` hook rather than registering a Nest interceptor.
 *
 * Registered as an `AppModule` provider, not from `main.ts`, for the same
 * reason as `RequestIdHook` and `WebhookBodyParser`: nothing imports
 * `main.ts`, so a hook installed only there is exercised by no test at all
 * (see the docblock on `app.module.ts`). As a provider, every
 * `Test.createTestingModule({ imports: [AppModule] })` gets the real
 * mechanism.
 *
 * The admin SPA (`apps/admin`) is served as static files by its own host, not
 * by this API (ADR-0043 § 4), so these headers do not constrain it — they
 * apply only to this API's own JSON responses.
 */
@Injectable()
export class SecurityHeadersHook implements OnModuleInit {
  constructor(
    private readonly adapterHost: HttpAdapterHost<FastifyAdapter>,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    const fastify = this.adapterHost.httpAdapter.getInstance();
    const isProduction = this.config.runtime.nodeEnv === 'production';

    fastify.addHook('onSend', (_request, reply, payload, done) => {
      // MIME-sniffing off: a client that ignores our declared Content-Type
      // and guesses from the body cannot turn a JSON error envelope into
      // something it will execute.
      reply.header('X-Content-Type-Options', 'nosniff');
      // This API is never meant to be framed — there is no legitimate embed
      // use case, so clickjacking via an invisible iframe is refused outright
      // rather than scoped with a CSP frame-ancestors directive.
      reply.header('X-Frame-Options', 'DENY');
      // Never leak this API's URLs (which can carry order or master ids) to
      // a third-party Referer target.
      reply.header('Referrer-Policy', 'no-referrer');
      // Same-origin only: nothing served by this API is meant to be loaded
      // as a subresource (image, script, etc.) by another origin.
      reply.header('Cross-Origin-Resource-Policy', 'same-origin');
      // HSTS only in production: sending it over plain HTTP in development
      // would pin a browser to HTTPS for `localhost`, which is not served
      // over HTTPS locally and would leave a developer's browser refusing to
      // load the dev server at all until the policy expired.
      if (isProduction) {
        reply.header('Strict-Transport-Security', HSTS_HEADER_VALUE);
      }
      done(null, payload);
    });
  }
}
