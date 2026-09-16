import type { ZodIssue } from 'zod';

import type { AppConfig } from './app-config.types';
import { findExpoPublicSecretViolations } from './env-guard';
import { rawEnvSchema, toAppConfig } from './env.schema';

/**
 * Thrown by {@link parseEnv} exactly once, at process start, carrying every
 * offending variable found — never a partial list, and never a submitted
 * value (`docs/engineering/security.md` § Environment validation: "Never log
 * a value"). Only the Nest bootstrap path in `main.ts` is expected to catch
 * this; `parseEnv` itself stays a pure function so it is trivial to test.
 */
export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
    Object.setPrototypeOf(this, EnvValidationError.prototype);
  }
}

/**
 * Turns one Zod issue into an operator-facing sentence naming the variable
 * (`issue.path`) and what was wrong — and nothing else. Every branch below is
 * built only from issue metadata (allowed values, a minimum length, a format
 * name) that Zod already keeps free of the submitted value; none of them ever
 * read `issue.input`.
 */
function describeIssue(issue: ZodIssue): string {
  const variable = issue.path.length > 0 ? issue.path.map(String).join('.') : '(configuration)';

  switch (issue.code) {
    case 'invalid_type':
      // After the empty-string-to-undefined normalisation in env.schema.ts,
      // "missing" and "type mismatch" both surface as `invalid_type` against
      // `undefined` input — which is exactly the "is required" case for this
      // schema, since every field that accepts other JS types is optional.
      return `${variable} is required`;

    case 'invalid_format':
      // Every format-checked field in env.schema.ts supplies its own message,
      // so this carries the specific expectation ("must be a postgresql:// URL")
      // rather than flattening every format failure into one sentence. The
      // message is schema-authored text, never the submitted value.
      return `${variable} ${issue.message}`;

    case 'too_small':
      return issue.origin === 'string'
        ? `${variable} must be at least ${String(issue.minimum)} characters long`
        : `${variable} must be at least ${String(issue.minimum)}`;

    case 'too_big':
      return issue.origin === 'string'
        ? `${variable} must be at most ${String(issue.maximum)} characters long`
        : `${variable} must be at most ${String(issue.maximum)}`;

    case 'invalid_value':
      return `${variable} must be one of: ${issue.values.map(String).join(', ')}`;

    case 'custom':
      // Named like every other branch. A `.refine()`/`.superRefine()` issue
      // carries a correctly attributed `path`, but returning the bare message
      // dropped it — so "is still the .env.example placeholder" reached the
      // operator without saying WHICH variable, which is the one thing the
      // message exists to tell them. Every custom message in env.schema.ts is
      // therefore written as a predicate with no variable name of its own.
      return `${variable} ${issue.message}`;

    default:
      return `${variable} is invalid`;
  }
}

/**
 * Parses and validates the process environment into a typed, frozen
 * {@link AppConfig}. Pure function: it takes the environment as an argument
 * instead of reading `process.env` itself, so it needs no real environment
 * and no Turborepo env plumbing to unit test — the Nest provider in
 * `config.module.ts` is the only caller that ever passes `process.env`.
 *
 * Throws {@link EnvValidationError} listing every problem at once (Zod's
 * `safeParse` already collects every issue; this never stops at the first)
 * and never includes a submitted value in that list.
 */
export function parseEnv(source: Readonly<Record<string, string | undefined>>): AppConfig {
  // Runs over the WHOLE source environment, independent of the schema below,
  // so a secret smuggled behind EXPO_PUBLIC_ under a name the schema never
  // declared is still caught.
  const expoPublicIssues = findExpoPublicSecretViolations(source).map(
    (offendingKey) =>
      `${offendingKey} must not be prefixed with EXPO_PUBLIC_ — it would ship inside the app bundle and is readable by any user`,
  );

  const result = rawEnvSchema.safeParse(source);
  const schemaIssues = result.success ? [] : result.error.issues.map(describeIssue);

  const issues = [...expoPublicIssues, ...schemaIssues];
  if (issues.length > 0) {
    throw new EnvValidationError(issues);
  }

  if (!result.success) {
    // Unreachable: `issues.length === 0` above already proved `schemaIssues`
    // was empty, which only happens when `result.success` is `true`. This
    // exists purely so TypeScript can narrow `result` to its success branch
    // below without an unsafe cast.
    throw new EnvValidationError([]);
  }

  return toAppConfig(result.data);
}
