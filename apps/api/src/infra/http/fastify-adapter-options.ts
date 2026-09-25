import { FastifyAdapter } from '@nestjs/platform-fastify';

/**
 * The two options this module sets, and nothing else. Deliberately **not**
 * `fastify`'s own `FastifyServerOptions`, and deliberately not derived from
 * `FastifyAdapter`'s constructor either: this repository resolves two
 * different versions of `fastify` on disk (root and `apps/api`, under
 * `nodeLinker: hoisted` — see CLAUDE.md §14), and both of those routes pull in
 * `FastifyServerOptions`'s full surface — including fields whose types (a
 * request-logging predicate typed over `FastifyRequest`, in particular)
 * genuinely differ between the two installed versions and fail to typecheck
 * against each other. A minimal object literal carrying only the two fields
 * this function sets is structurally assignable to whichever
 * `FastifyServerOptions` `@nestjs/platform-fastify` expects without ever
 * comparing the fields this file does not touch.
 */
interface HardenedFastifyOptions {
  readonly bodyLimit: number;
  readonly trustProxy: SafeTrustProxyOption;
}

/**
 * The body limit applied to every route that does not set its own.
 *
 * This is Fastify's own implicit default (issue #275) — reviewed and kept
 * rather than raised. Nothing in the API accepts a legitimate body anywhere
 * near 1 MiB: JSON payloads carry a handful of fields, and file uploads
 * bypass this route entirely via presigned R2 URLs whose size cap is
 * enforced at confirm (ADR-0024). The LiveKit webhook, the one route that
 * genuinely needs a smaller ceiling because it is public and unauthenticated
 * until its signature is checked, sets its own 64 KiB limit ahead of this one
 * (`modules/calls/webhook-body.parser.ts`).
 */
export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * `trustProxy` values this application will ever accept from configuration.
 *
 * Deliberately excludes `true`: see the comment in
 * `common/guards/rate-limit.guard.ts`. Turning `trustProxy` on without a
 * specific list of trusted hops makes `X-Forwarded-For` client-controlled,
 * which makes every per-IP rate limit spoofable — a client that can choose
 * its own key can give itself a fresh budget on every request. `false` (the
 * default, and the only value in use today) keeps Fastify reading `request.ip`
 * from the socket peer. When EPIC 17 puts a reverse proxy in front of the API,
 * the value here becomes that proxy's own address or CIDR list — never `true`.
 */
export type SafeTrustProxyOption = false | string | string[];

export interface FastifyAdapterOptionsInput {
  readonly trustProxy?: SafeTrustProxyOption;
}

/**
 * Builds the Fastify adapter options used everywhere this application starts
 * a Fastify instance — `main.ts` for the running service and every
 * integration test that wants to exercise the real HTTP-level defaults rather
 * than Fastify's own (issue #275). A test asserting the body limit or the
 * `trustProxy` guard through `new FastifyAdapter()` directly would prove
 * nothing about what `main.ts` actually configures.
 *
 * The `trustProxy` type above already makes `trustProxy: true` a compile
 * error for any caller in this repository. The runtime check below exists
 * for the caller that reaches in through `unknown` anyway — a config value
 * parsed from the environment, or a future refactor that loosens the type —
 * so the refusal holds even when the type system has been routed around.
 */
export function createFastifyAdapterOptions(
  input: FastifyAdapterOptionsInput = {},
): HardenedFastifyOptions {
  const trustProxy = input.trustProxy ?? false;

  if ((trustProxy as unknown) === true) {
    throw new Error(
      'trustProxy: true is refused (issue #275). Configure an explicit proxy ' +
        'address or CIDR list instead — see the comment in rate-limit.guard.ts.',
    );
  }

  return {
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
    trustProxy,
  };
}

/** Builds the `FastifyAdapter` every entry point (real or test) constructs. */
export function createFastifyAdapter(input: FastifyAdapterOptionsInput = {}): FastifyAdapter {
  return new FastifyAdapter(createFastifyAdapterOptions(input));
}
