import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../errors/app-error';
import type { ErrorCode } from '../errors/error-codes.types';
import { ERROR_CODES } from '../errors/error-codes.types';
import type { ErrorEnvelope } from '../errors/error-envelope.types';
import { RETRY_AFTER_DETAIL_KEY } from '../errors/rate-limited.error';
import { requestLogContext } from '../request-context/request-context';

interface ResolvedError {
  status: number;
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

/**
 * What a 404 raised by the framework itself says. Nest's unmatched-route
 * handler throws `NotFoundException('Cannot GET /whatever/was/asked/for')`,
 * which reflects the raw request path straight back into the response body.
 * The JSON content type makes that harmless to a browser, but it is still
 * unfiltered request echo — an attacker-chosen string served from our origin —
 * and it tells a scanner nothing it did not already know (issue #47).
 *
 * A 404 the product raises on its own behalf is an `AppError`
 * (`common/errors/not-found.error.ts`) and keeps its own wording; only a
 * framework 404, which has nothing to say, is collapsed to this.
 */
const NOT_FOUND_MESSAGE = 'The requested resource was not found.';

function codeForHttpStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ERROR_CODES.BAD_REQUEST;
    case 401:
      return ERROR_CODES.UNAUTHORIZED;
    case 403:
      return ERROR_CODES.FORBIDDEN;
    case 404:
      return ERROR_CODES.NOT_FOUND;
    case 409:
      return ERROR_CODES.CONFLICT;
    case 422:
      return ERROR_CODES.VALIDATION_FAILED;
    case 429:
      return ERROR_CODES.RATE_LIMITED;
    default:
      return ERROR_CODES.INTERNAL_ERROR;
  }
}

function messageFromHttpException(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') {
    return response;
  }
  if (typeof response === 'object' && response !== null && 'message' in response) {
    const { message } = response;
    if (typeof message === 'string') {
      return message;
    }
  }
  return exception.message;
}

/**
 * The only message from a framework exception that a client is allowed to see.
 * A 5xx carries text we wrote for ourselves, not for a user —
 * `InternalServerErrorException('pool exhausted on 10.0.0.5')` would hand the
 * client our topology — and a 404 carries the request path back. Everything
 * else (400, 401, 403, 409, 422, 429) is text a caller can act on.
 */
function safeHttpExceptionMessage(exception: HttpException, status: number): string {
  if (status >= 500) {
    return GENERIC_MESSAGE;
  }
  if (status === 404) {
    return NOT_FOUND_MESSAGE;
  }
  return messageFromHttpException(exception);
}

function describeForLog(exception: unknown): string {
  if (exception instanceof Error) {
    return exception.stack ?? exception.message;
  }
  return String(exception);
}

/**
 * The single place every thrown error passes through on its way to a client.
 * Maps `AppError` to its own status/code, maps Nest's `HttpException` to the
 * envelope via the status table in
 * `docs/architecture/backend-architecture.md` § Error model, and collapses
 * anything else — a driver error, a programming bug — to a generic 500.
 *
 * Full detail is always logged server-side, correlated by `requestId` and — on
 * an authenticated request — by the actor id the authentication guard resolved
 * (issue #27), so a failure report can be tied to the user who hit it without
 * that user's phone number or token ever entering a log. Only the safe subset
 * ever reaches the response body: no stack trace, no SQL, no infrastructure
 * detail, and no actor id either, because the caller already knows who they are
 * and an id in an error body is one more thing to leak onward.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<FastifyRequest>();
    const reply = ctx.getResponse<FastifyReply>();
    const requestId = request.requestId ?? 'unknown';

    const resolved = this.resolve(exception);

    this.logger.error(
      `${requestLogContext(request)} ${resolved.status} ${resolved.code}: ${describeForLog(exception)}`,
    );

    const body: ErrorEnvelope = {
      error: {
        code: resolved.code,
        message: resolved.message,
        requestId,
        ...(resolved.details !== undefined ? { details: resolved.details } : {}),
      },
    };

    // `Retry-After` is set here rather than by whoever threw, because the
    // filter is the only code that touches the reply on an error path: a
    // guard that called `reply.header()` itself would be relying on this
    // filter not resetting headers later, which is an implementation detail
    // of Fastify's reply object and not a guarantee anyone wrote down. Doing
    // it here also means every future 429 — order creation, reviews, location
    // ingest (docs/engineering/security.md § Rate limiting and abuse) —
    // carries the hint by putting one number in `details`, rather than by
    // remembering to set a header.
    //
    // Restricted to 429 on purpose. RFC 9110 §10.2.3 also defines the header
    // for 503, and this filter has no idea when a 503 will clear; inventing
    // a number there would be worse than saying nothing.
    if (resolved.status === 429) {
      const hint = resolved.details?.[RETRY_AFTER_DETAIL_KEY];
      if (typeof hint === 'number' && Number.isFinite(hint)) {
        reply.header('Retry-After', String(Math.max(1, Math.ceil(hint))));
      }
    }

    reply.status(resolved.status).send(body);
  }

  private resolve(exception: unknown): ResolvedError {
    if (exception instanceof AppError) {
      return {
        status: exception.status,
        code: exception.code,
        message: exception.message,
        ...(exception.details !== undefined ? { details: exception.details } : {}),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        code: codeForHttpStatus(status),
        // The real message is in the log line above, keyed by the same
        // requestId, whenever this drops it.
        message: safeHttpExceptionMessage(exception, status),
      };
    }

    // Anything else (a driver error, a programming bug) is unexpected by
    // definition: never describe it to the client, only in the server log.
    return {
      status: 500,
      code: ERROR_CODES.INTERNAL_ERROR,
      message: GENERIC_MESSAGE,
    };
  }
}
