import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { infer as ZodInfer, ZodType } from 'zod';

import { AppError } from '../errors/app-error';
import { ERROR_CODES } from '../errors/error-codes.types';

/**
 * A metatype that carries its own Zod schema, produced by {@link createZodDto}.
 * A controller parameter typed as `InstanceType<typeof SomeDto>` is validated
 * by {@link ZodValidationPipe} once it runs as a global pipe.
 */
interface ZodDtoMetatype {
  zodSchema: ZodType;
}

function hasZodSchema(metatype: unknown): metatype is ZodDtoMetatype {
  return (
    typeof metatype === 'function' &&
    'zodSchema' in metatype &&
    typeof (metatype as { zodSchema?: unknown }).zodSchema === 'object'
  );
}

/**
 * Global validation pipe (`docs/architecture/backend-architecture.md` §
 * Validation): validates a value against the Zod schema attached to its
 * parameter type and passes the value through untouched when none is
 * attached. No route uses this yet — issue #19 requires it wired, not
 * exercised.
 *
 * On failure, throws `AppError` with `VALIDATION_FAILED` / 422 and per-field
 * detail derived from the Zod issues — field paths and messages only, never
 * the submitted value (which may be a password or an OTP).
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const { metatype } = metadata;
    if (!hasZodSchema(metatype)) {
      return value;
    }

    const result = metatype.zodSchema.safeParse(value);
    if (!result.success) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Validation failed.', 422, {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      });
    }

    return result.data;
  }
}

/**
 * Builds a class whose instances `ZodValidationPipe` validates against
 * `schema`. The schema itself stays Nest-free (`*.schema.ts`, per ADR-0016)
 * — this is the only place a schema touches a Nest concept, and only to ride
 * along as a static property on the metatype Nest already inspects.
 */
export function createZodDto<T extends ZodType>(schema: T): new () => ZodInfer<T> {
  class ZodDto {
    static readonly zodSchema = schema;
  }
  return ZodDto as unknown as new () => ZodInfer<T>;
}
