import { randomUUID } from 'node:crypto';

import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by {@link RequestIdInterceptor} before the route handler runs. */
    requestId: string;
  }
}

/**
 * An inbound `x-request-id` is untrusted input: logged verbatim, it is a
 * log-injection vector, so it is accepted only when it matches this safe
 * pattern. Anything else — including no header at all — gets a fresh id.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Attaches a request id to every request (reusing a well-formed inbound
 * `x-request-id`, generating one otherwise) so the global exception filter
 * can log with it and the client can correlate a response with a support
 * ticket. Set on both the request (for the filter to read) and the response
 * header (for the client).
 */
@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const inbound = request.headers['x-request-id'];
    const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
    const requestId =
      candidate !== undefined && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();

    request.requestId = requestId;
    reply.header('x-request-id', requestId);

    return next.handle();
  }
}
