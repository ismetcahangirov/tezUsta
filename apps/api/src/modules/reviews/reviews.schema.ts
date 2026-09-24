import { z } from 'zod';

/**
 * Validation for the review endpoints (issue #222).
 * Pre-`packages/validation` code (ADR-0016): no Nest, Fastify or Drizzle type
 * appears below.
 */

/**
 * The longest comment the API accepts, in characters (ADR-0042 § 5), matching
 * the `reviews_comment_length` CHECK. Two copies of one number for the reason
 * `MAX_MESSAGE_BODY_LENGTH` gives: Zod guards the request path and the CHECK
 * guards the table against everything else.
 */
export const MAX_REVIEW_COMMENT_LENGTH = 500;

/**
 * The most raw characters read before cleaning. Stripping and trimming can
 * only shorten a string, so a comment longer than this could never clean down
 * to a legal one it was not already close to — and bounding the input before
 * the regex runs is what stops a megabyte of whitespace costing a scan.
 */
const MAX_RAW_COMMENT_LENGTH = 4 * MAX_REVIEW_COMMENT_LENGTH;

/**
 * C0 and C1 control characters other than line feed (ADR-0042 § 5). Tab and
 * carriage return go too: a review is shown in a `Text` on a phone, where a
 * tab is a rendering accident and `\r\n` from a hardware keyboard should read
 * as the newline it means.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the whole point of this pattern
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;

/**
 * Cleans a comment the way ADR-0042 § 5 specifies — control characters other
 * than newline stripped, then trimmed, empty becoming null.
 *
 * Exported so the unit test states the rule against the function rather than
 * through HTTP.
 */
export function cleanReviewComment(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const cleaned = raw.replace(CONTROL_EXCEPT_NEWLINE, '').trim();
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * Length in **code points**, which is what Postgres's `char_length` counts. A
 * JavaScript `length` counts UTF-16 units, so an emoji would count twice here
 * and once in the CHECK — harmless in that direction, but the two bounds
 * should measure the same thing.
 */
function codePointLength(value: string): number {
  return Array.from(value).length;
}

export const submitReviewSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    comment: z
      .string()
      .max(MAX_RAW_COMMENT_LENGTH)
      .nullish()
      .transform(cleanReviewComment)
      .refine((value) => value === null || codePointLength(value) <= MAX_REVIEW_COMMENT_LENGTH, {
        message: `A comment may be at most ${String(MAX_REVIEW_COMMENT_LENGTH)} characters.`,
      }),
  })
  .strict();

export const reviewOrderIdParamsSchema = z.object({ orderId: z.uuid() }).strict();

/** What the service receives: the rating, and the comment already cleaned. */
export type SubmitReviewInput = z.infer<typeof submitReviewSchema>;
export type ReviewOrderIdParams = z.infer<typeof reviewOrderIdParamsSchema>;
