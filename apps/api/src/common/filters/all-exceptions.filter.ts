import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../errors/app-error';
import type { ErrorCode } from '../errors/error-codes.types';
import { ERROR_CODES } from '../errors/error-codes.types';
import type { ErrorEnvelope } from '../errors/error-envelope.types';

interface ResolvedError {
  status: number;
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

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
 * Full detail is always logged server-side, correlated by `requestId`
 * (attached upstream by {@link RequestIdInterceptor}). Only the safe subset
 * ever reaches the response body: no stack trace, no SQL, no infrastructure
 * detail.
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
      `[${requestId}] ${resolved.status} ${resolved.code}: ${describeForLog(exception)}`,
    );

    const body: ErrorEnvelope = {
      error: {
        code: resolved.code,
        message: resolved.message,
        requestId,
        ...(resolved.details !== undefined ? { details: resolved.details } : {}),
      },
    };

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
        // A 5xx HttpException carries a message we wrote for ourselves, not
        // for a user — `InternalServerErrorException('pool exhausted on
        // 10.0.0.5')` would hand the client our topology. Anything at or above
        // 500 answers with the generic message; the real one is in the log
        // line above, keyed by the same requestId.
        message: status >= 500 ? GENERIC_MESSAGE : messageFromHttpException(exception),
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
