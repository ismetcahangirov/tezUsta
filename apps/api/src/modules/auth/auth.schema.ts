import { z } from 'zod';

/**
 * Validation for the authentication endpoints.
 *
 * Written as if it were already a package (ADR-0016): no Nest type, no
 * Fastify type and no Drizzle type appears below, so the day `apps/mobile`
 * reuses these shapes the move to `packages/validation` is a file move rather
 * than a rewrite.
 */

/**
 * `<uuid>.<43-character base64url secret>` — the exact shape
 * `TokenService.mintRefreshToken` emits.
 *
 * Bounded, not merely non-empty (`docs/engineering/security.md`: "bound every
 * string"). Without a ceiling a client can post a megabyte where a 79-character
 * token belongs, and every byte of it is hashed, compared and potentially
 * logged. The exact length is not asserted here on purpose — the authoritative
 * shape check lives in `TokenService.parseRefreshToken`, next to the code that
 * produces it, and duplicating the regular expression in two files is how the
 * two drift.
 */
export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1).max(256),
});

export type RefreshRequest = z.infer<typeof refreshRequestSchema>;
