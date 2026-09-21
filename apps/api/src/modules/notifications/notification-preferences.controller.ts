import { Body, Controller, Get, Put } from '@nestjs/common';
import type { NotificationPreference } from '@tezusta/types';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { NotificationPreferencesService } from './notification-preferences.service';
import { updateNotificationPreferencesSchema } from './notification-preferences.schema';

class UpdateNotificationPreferencesDto extends createZodDto(updateNotificationPreferencesSchema) {}

/**
 * Where a user says what they want to be told about.
 *
 * **No route here is `@Public()`, and none of them names a user.** The owner
 * is always the authenticated actor, so there is no id a client could send and
 * therefore no ownership check to forget — the same shape `/devices` has, for
 * the same reason.
 *
 * **The enforcement is not here.** This is where a preference is recorded; the
 * filter that acts on it runs in the notification worker, immediately before a
 * push leaves (`NotificationPreferencesService.wants`). A preference honoured
 * only by a client that declines to display what already arrived is not a
 * preference — the phone has already lit up. CLAUDE.md §11's rule about
 * frontend checks is the same argument.
 */
@Controller('notification-preferences')
export class NotificationPreferencesController {
  constructor(private readonly preferences: NotificationPreferencesService) {}

  /**
   * Every category, not just the stored ones — a settings screen renders the
   * whole list and should never have to know what a missing row means.
   *
   * A plain array rather than a cursor page: the set is closed and short, and
   * paginating a fixed list would add a cursor to every render for nothing.
   */
  @Get()
  async read(@CurrentActor() actor: Actor): Promise<NotificationPreference[]> {
    return this.preferences.read(actor);
  }

  /**
   * Replace this caller's preferences with the complete set in the body.
   *
   * `PUT` rather than `PATCH` because the body *is* the state: a category it
   * does not name goes back to its default. That makes a retry on a flaky
   * mobile network land the same result as the first attempt, which is what
   * this endpoint needs far more than it needs partial updates.
   *
   * Answers with the resolved list, so a client re-renders from the server's
   * view rather than from what it hoped it had sent.
   */
  @Put()
  async replace(
    @CurrentActor() actor: Actor,
    @Body() body: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreference[]> {
    return this.preferences.replace(actor, body);
  }
}
