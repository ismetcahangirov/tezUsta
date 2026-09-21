import { Injectable } from '@nestjs/common';
import type { NotificationPreference } from '@tezusta/types';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import type { Actor } from '../auth/auth.types';
import { isCategoryChangeable, isKindEnabled, resolvePreferences } from './notification-categories';
import type { NotificationCategory } from './notification-categories';
import { NotificationPreferencesRepository } from './notification-preferences.repository';
import type { StoredPreference } from './notification-preferences.repository';
import type { UpdateNotificationPreferencesRequest } from './notification-preferences.schema';
import type { NotificationKind } from './notification.types';

/**
 * Asked for when a user tries to silence something they asked for.
 *
 * A named code rather than a bare 409: the settings screen shows a different
 * thing for "this one cannot be switched off" than for every other conflict,
 * and a client that saw `CONFLICT` would have to guess which.
 */
export class CategoryNotChangeableError extends AppError {
  constructor(category: NotificationCategory) {
    super(
      ERROR_CODES.NOTIFICATION_CATEGORY_NOT_CHANGEABLE,
      'This kind of notification cannot be switched off.',
      409,
      { category },
    );
  }
}

/**
 * Per-user notification preferences: the read and write surface, and the
 * question the worker asks before it sends (issue #143).
 *
 * **The owner is always the caller's own account.** No route in this module
 * names a user, so there is no id to check — the actor is the only source of
 * one, which is the ownership guarantee CLAUDE.md §11 asks for made structural
 * rather than remembered.
 *
 * Like `devices`, nothing here resolves a role profile first. A preference is
 * user-scoped: one binary carries both customer and master (CLAUDE.md §2), so
 * a person's answer holds whichever role the event concerns.
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(private readonly preferences: NotificationPreferencesRepository) {}

  /** Every category with this caller's current value and whether it may change. */
  async read(actor: Actor): Promise<NotificationPreference[]> {
    const stored = await this.preferences.findByUser(actor.userId);
    return resolvePreferences(stored);
  }

  /**
   * Set this caller's preferences to exactly what the body says.
   *
   * **Every entry is checked before any of them is written.** A body that
   * switches one category off and tries to silence a transactional one must
   * apply neither — a partial write leaves the user looking at a settings
   * screen that agrees with neither what they asked for nor what they had.
   *
   * A non-changeable category named with `enabled: true` is **accepted and not
   * stored**. It asks for the state the user already has, so refusing it would
   * make a client that echoes the whole read back unable to write at all,
   * while storing it would put a row in the table that nothing ever reads —
   * `isCategoryEnabled` resolves a non-changeable category from the policy,
   * never from a row.
   */
  async replace(
    actor: Actor,
    request: UpdateNotificationPreferencesRequest,
  ): Promise<NotificationPreference[]> {
    for (const entry of request.preferences) {
      if (!entry.enabled && !isCategoryChangeable(entry.category)) {
        throw new CategoryNotChangeableError(entry.category);
      }
    }

    const storable: StoredPreference[] = request.preferences
      .filter((entry) => isCategoryChangeable(entry.category))
      .map((entry) => ({ category: entry.category, isEnabled: entry.enabled }));

    await this.preferences.replaceForUser(actor.userId, storable);

    return resolvePreferences(new Map(storable.map((entry) => [entry.category, entry.isEnabled])));
  }

  /**
   * Does this user still want to hear about this kind? (#143, the send-time
   * filter.)
   *
   * **Takes a user id rather than an `Actor`**, the signature of something a
   * request must never reach: the caller is a queued job, and there is no
   * caller to own the answer. It is exported through this module's service so
   * the one method the worker uses is visible where every reviewer reads.
   *
   * **It is called in the worker, immediately before the push leaves — never
   * at enqueue.** The gap between an order event and its delivery is a retry
   * and a backoff wide, and a user who switched a category off inside that
   * window would still get the push if the filter had run earlier. The cost is
   * one lookup on a primary key, per job.
   */
  async wants(userId: string, kind: NotificationKind): Promise<boolean> {
    const stored = await this.preferences.findByUser(userId);
    return isKindEnabled(kind, stored);
  }
}
