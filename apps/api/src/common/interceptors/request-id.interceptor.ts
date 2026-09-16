import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';

import { ensureRequestId } from '../request-context/request-context';

/**
 * Attaches a request id to every request (reusing a well-formed inbound
 * `x-request-id`, generating one otherwise) so the global exception filter can
 * log with it and the client can correlate a response with a support ticket.
 * Set on both the request (for the filter to read) and the response header (for
 * the client).
 *
 * The work itself lives in {@link ensureRequestId} because guards run *before*
 * interceptors and a guard that rejects a request short-circuits this one
 * entirely — see the comment there. This interceptor remains the path for
 * everything a guard lets through, and for the day the global guards are
 * unregistered.
 */
@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    ensureRequestId(http.getRequest<FastifyRequest>(), http.getResponse<FastifyReply>());

    return next.handle();
  }
}
