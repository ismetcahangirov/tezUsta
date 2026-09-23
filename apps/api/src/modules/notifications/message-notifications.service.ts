import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { MessageSenderKind } from '@tezusta/types';
import { z } from 'zod';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { DeferredJobHandlerRegistry } from '../../infra/queue/deferred-job-handler.registry';
import { DeferredWorkService } from '../../infra/queue/deferred-work.service';
import type { DeferredJobPayload } from '../../infra/queue/queue.types';
import { CustomersService } from '../customers/customers.service';
import { MastersService } from '../masters/masters.service';
import { ConversationEventsRegistry } from '../orders/conversation-events.registry';
import type { MessageCreatedEvent } from '../orders/conversation-events.registry';
import { ConversationsRepository } from '../orders/conversations.repository';
import { NotificationsService } from './notifications.service';

/** The deferred job that decides, later, whether a message still needs a push. */
export const MESSAGE_PUSH_JOB = 'message-push';

/**
 * The job carries ids and the recipient's side, never the message (ADR-0025,
 * CLAUDE.md §11). Validated on the way out of the queue like every payload.
 */
const messagePushPayloadSchema = z
  .object({
    orderId: z.uuid(),
    conversationId: z.uuid(),
    /** `conversations.master_id` or `orders.customer_id` — whichever side is being told. */
    recipientProfileId: z.uuid(),
    recipientKind: z.enum(['customer', 'master']),
  })
  .strict();

type MessagePushPayload = z.infer<typeof messagePushPayloadSchema>;

/**
 * The job id for one recipient's window on one conversation.
 *
 * **The window is in the id, and that is the coalescing.** BullMQ enqueues one
 * job per id and ignores the rest, so every message written to this recipient
 * inside one window lands on the job the first one scheduled — a burst of ten
 * raises one push, not ten. The window has to be in the id rather than the id
 * being the pair alone, because a completed job is retained (`removeOnComplete`
 * keeps the last hundred) and a bare pair id would then refuse every later
 * window's job for as long as the old one was kept.
 *
 * Aligned to wall-clock buckets, so two instances writing into one
 * conversation compute the same id without talking to each other. A burst
 * that straddles a boundary costs two pushes rather than one, which is the
 * cheap direction to be wrong in.
 *
 * Dots rather than colons: BullMQ refuses a custom id containing `:`, which
 * it reserves for its own Redis key layout.
 */
export function messagePushJobId(
  conversationId: string,
  recipientKind: MessageSenderKind,
  nowMs: number,
  windowMs: number,
): string {
  return `${MESSAGE_PUSH_JOB}.${conversationId}.${recipientKind}.${String(Math.floor(nowMs / windowMs))}`;
}

/**
 * What turns a message the recipient did not see into a push (issue #180,
 * ADR-0033 § 5).
 *
 * **"No live socket" is answered by the database, not by the socket.** The
 * question the issue asks is cluster-wide — the connection registry is
 * per-instance, and a socket on another instance is invisible here — and it
 * races delivery in both directions: a socket that is present when asked can
 * be gone before the frame reaches it, which is a message nobody is told
 * about. What matters is whether the recipient *saw* the message, and the
 * conversation screen reports exactly that with a read receipt once the
 * message is on screen (#182). So the push is scheduled for
 * `MESSAGE_PUSH_DELAY_SECONDS` later, and the job asks whether the recipient
 * still has anything unread; every instance agrees on the answer.
 *
 * **The trade is stated rather than hidden.** A recipient whose app is open on
 * a different screen receives the socket frame *and*, a few seconds later, a
 * push — a duplicate. The issue names the choice: a duplicate is a minor
 * annoyance, a silent drop is a lost message, and this design cannot silently
 * drop one that went unread.
 *
 * Nothing here sends. The job hands a `message-received` notification to
 * `NotificationsService`, which queues it like every other kind, so the
 * preference filter, the Android channel, device retirement and receipt
 * handling are the ones the order notifications already use.
 */
@Injectable()
export class MessageNotificationsService implements OnModuleInit {
  constructor(
    private readonly events: ConversationEventsRegistry,
    private readonly handlers: DeferredJobHandlerRegistry,
    private readonly work: DeferredWorkService,
    private readonly conversations: ConversationsRepository,
    private readonly notifications: NotificationsService,
    private readonly customers: CustomersService,
    private readonly masters: MastersService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.events.register('notifications', {
      messageCreated: (event) => this.schedule(event),
    });
    this.handlers.register(MESSAGE_PUSH_JOB, (payload) => this.decide(payload));
  }

  /**
   * One committed message becomes, at most, one pending decision for the
   * other party. Off the request path: it is one `ZADD`, and the registry
   * swallows its failure because the message is written either way.
   */
  private async schedule(event: MessageCreatedEvent): Promise<void> {
    const recipientKind: MessageSenderKind =
      event.senderKind === 'customer' ? 'master' : 'customer';
    const windowMs = this.config.conversations.pushDelaySeconds * 1_000;

    const payload: MessagePushPayload = {
      orderId: event.orderId,
      conversationId: event.conversationId,
      recipientProfileId: recipientKind === 'customer' ? event.customerId : event.masterId,
      recipientKind,
    };

    await this.work.schedule(MESSAGE_PUSH_JOB, payload, {
      delayMs: windowMs,
      jobId: messagePushJobId(event.conversationId, recipientKind, Date.now(), windowMs),
    });
  }

  /**
   * The window has passed: push if the recipient still has something unread
   * from the other side, otherwise do nothing.
   *
   * The unread count is read from the conversation the message was written
   * to, closed or not — a message written just before a re-dispatch still
   * deserves to be seen, and the transcript stays readable (ADR-0033 § 2).
   */
  private async decide(rawPayload: DeferredJobPayload): Promise<void> {
    const parsed = messagePushPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) {
      // A deploy boundary, not an attack — see `NotificationDeliveryService#parse`.
      throw new Error(`A "${MESSAGE_PUSH_JOB}" job carried a payload this release cannot read`);
    }
    const payload = parsed.data;

    const unread = await this.conversations.countUnreadFor(
      payload.conversationId,
      payload.recipientKind,
    );
    if (unread === 0) {
      return;
    }

    const userId =
      payload.recipientKind === 'customer'
        ? await this.customers.findUserId(payload.recipientProfileId)
        : (await this.masters.findUserIds([payload.recipientProfileId])).get(
            payload.recipientProfileId,
          );
    if (userId === undefined) {
      return;
    }

    await this.notifications.notify({
      userId,
      kind: 'message-received',
      orderId: payload.orderId,
      senderKind: payload.recipientKind === 'customer' ? 'master' : 'customer',
    });
  }
}
