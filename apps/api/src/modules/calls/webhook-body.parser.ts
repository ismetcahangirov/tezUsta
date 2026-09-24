import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyAdapter } from '@nestjs/platform-fastify';

/**
 * LiveKit's webhook content type, from its documentation: *"The Content-Type
 * header of the request is application/webhook+json."*
 * (docs.livekit.io/home/server/webhooks, read 24 September 2026.)
 */
export const WEBHOOK_CONTENT_TYPE = 'application/webhook+json';

/**
 * The largest webhook body accepted, in bytes.
 *
 * A LiveKit event is one room and at most one participant — a few kilobytes.
 * 64 KiB is an order of magnitude of headroom over that and a sixteenth of
 * Fastify's 1 MiB default, which matters because the route is public: until
 * the signature is checked, every byte of the body was chosen by whoever sent
 * it, and verifying it means hashing all of them.
 */
export const WEBHOOK_BODY_LIMIT_BYTES = 64 * 1024;

/**
 * Hands `application/webhook+json` bodies to the route **as the string that
 * arrived**, unparsed (issue #186).
 *
 * The signature LiveKit sends is a SHA-256 of the exact bytes of the body
 * (`call-media.types.ts` § `WebhookDelivery`). Fastify's JSON parser would
 * turn them into an object, and no re-serialisation of that object is
 * guaranteed to reproduce the bytes — key order, whitespace and number
 * formatting all differ — so a genuine delivery would fail verification. A
 * parser registered for this one content type leaves every other route's
 * JSON handling exactly as it was.
 *
 * Registered from a provider, as `RequestIdHook` installs its hook, so that
 * every `Test.createTestingModule({ imports: [AppModule] })` gets the real
 * mechanism rather than one only `main.ts` sets up.
 */
@Injectable()
export class WebhookBodyParser implements OnModuleInit {
  constructor(private readonly adapterHost: HttpAdapterHost<FastifyAdapter>) {}

  onModuleInit(): void {
    const fastify = this.adapterHost.httpAdapter.getInstance();

    if (fastify.hasContentTypeParser(WEBHOOK_CONTENT_TYPE)) {
      // A second application in the same process shares nothing with this
      // one; the same instance initialising twice would be a Nest bug. Either
      // way the parser that is there is this one.
      return;
    }

    fastify.addContentTypeParser(
      WEBHOOK_CONTENT_TYPE,
      { parseAs: 'string', bodyLimit: WEBHOOK_BODY_LIMIT_BYTES },
      (_request, body, done) => {
        done(null, body);
      },
    );
  }
}
