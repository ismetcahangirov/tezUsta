import type { ArgumentMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AppError } from '../errors/app-error';
import { createZodDto, ZodValidationPipe } from './zod-validation.pipe';

const bodyMetadata: ArgumentMetadata = { type: 'body', metatype: undefined, data: undefined };

describe('ZodValidationPipe', () => {
  it('passes a value through untouched when the parameter carries no Zod schema', () => {
    const pipe = new ZodValidationPipe();
    const value = { anything: 'goes', because: 'no schema is attached yet' };

    expect(pipe.transform(value, bodyMetadata)).toBe(value);
  });

  it('returns the parsed value when the attached schema accepts the input', () => {
    const schema = z.object({ name: z.string().min(1) }).strict();
    const Dto = createZodDto(schema);
    const pipe = new ZodValidationPipe();

    const result = pipe.transform(
      { name: 'Ismat' },
      { type: 'body', metatype: Dto, data: undefined },
    );

    expect(result).toEqual({ name: 'Ismat' });
  });

  it('throws a 422 AppError with field-level detail — and never the submitted value — when the schema rejects the input', () => {
    const schema = z.object({ password: z.string().min(8) }).strict();
    const Dto = createZodDto(schema);
    const pipe = new ZodValidationPipe();

    let caught: unknown;
    try {
      pipe.transform({ password: 'short' }, { type: 'body', metatype: Dto, data: undefined });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppError);
    const appError = caught as AppError;
    expect(appError.status).toBe(422);
    expect(appError.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(appError.details)).not.toContain('short');
  });
});
