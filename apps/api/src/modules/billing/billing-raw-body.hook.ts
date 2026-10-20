import { Readable } from 'node:stream';

import { Injectable, PayloadTooLargeException } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyAdapter } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

import { BILLING_WEBHOOK_BODY_LIMIT_BYTES, BILLING_WEBHOOK_ROUTE } from './billing.constants';

/** The bytes each billing webhook request arrived with. Weak, so it holds nothing past the request. */
const rawBodies = new WeakMap<FastifyRequest, Buffer>();

/** The exact bytes a billing webhook arrived with, or `undefined` if none were captured. */
export function rawBodyOf(request: FastifyRequest): Buffer | undefined {
  return rawBodies.get(request);
}

/**
 * Keeps the **exact bytes** of a billing webhook for its signature check
 * (issue #323), and caps them at 64 KiB while they are still being read.
 *
 * A provider signs the body it sent, and no re-serialisation of a parsed
 * object is guaranteed to reproduce it. LiveKit's webhook solved that with a
 * content type of its own (`webhook-body.parser.ts`); payment providers send
 * plain `application/json`, and a parser for that type would change every
 * route. So this is a `preParsing` hook scoped to the one URL: it reads the
 * body into a buffer, keeps it, and hands Fastify's ordinary parser a stream
 * of the same bytes. Every other route is untouched.
 *
 * A provider that sends something other than JSON — a form post, say — gets
 * the parser it needs with its adapter, in that adapter's ADR.
 *
 * Registered from a provider, as `WebhookBodyParser` is, so every
 * `Test.createTestingModule({ imports: [AppModule] })` gets it too.
 */
@Injectable()
export class BillingRawBodyHook implements OnModuleInit {
  constructor(private readonly adapterHost: HttpAdapterHost<FastifyAdapter>) {}

  onModuleInit(): void {
    const fastify = this.adapterHost.httpAdapter.getInstance();

    fastify.addHook('preParsing', (request, _reply, payload, done) => {
      if (request.routeOptions.url !== BILLING_WEBHOOK_ROUTE) {
        done(null, payload);
        return;
      }
      const declared = Number(request.headers['content-length']);
      if (Number.isFinite(declared) && declared > BILLING_WEBHOOK_BODY_LIMIT_BYTES) {
        done(new PayloadTooLargeException());
        return;
      }

      const chunks: Buffer[] = [];
      let seen = 0;
      let finished = false;
      const finish = (error: Error | null, body?: Buffer): void => {
        if (finished) {
          return;
        }
        finished = true;
        if (error !== null) {
          payload.destroy();
          done(error);
          return;
        }
        const bytes = body ?? Buffer.alloc(0);
        rawBodies.set(request, bytes);
        done(null, Readable.from([bytes], { objectMode: false }));
      };

      payload.on('data', (chunk: Buffer) => {
        seen += chunk.length;
        if (seen > BILLING_WEBHOOK_BODY_LIMIT_BYTES) {
          finish(new PayloadTooLargeException());
          return;
        }
        chunks.push(chunk);
      });
      payload.on('end', () => {
        finish(null, Buffer.concat(chunks));
      });
      payload.on('error', (error: Error) => {
        finish(error);
      });
    });
  }
}
