import { Injectable } from '@nestjs/common';
import type {
  AdminOrderDetail,
  AdminOrderParty,
  AdminOrderSummary,
  AdminOrderTranscript,
  CursorPage,
  OrderStatus,
} from '@tezusta/types';
import { z } from 'zod';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import { resolveLocalizedText } from '../../common/i18n/resolve-localized-text';
import type { LocalizedText } from '../../common/i18n/localized-text.types';
import { allowedNextStatuses } from './order-lifecycle';
import { OrdersAdminRepository } from './orders-admin.repository';

/** "Stuck" — engaged with no change for this long (ADR-0043, issue #245). */
export const STUCK_AFTER_MS = 2 * 60 * 60 * 1000;
/** The most recent messages shown per conversation in a dispute transcript. */
const TRANSCRIPT_MESSAGES_PER_CONVERSATION = 500;

/** Transcripts are read for disputes only — data minimisation (`admin-flow.md` § 4). */
const TRANSCRIPT_STATUSES: readonly OrderStatus[] = ['DISPUTED', 'RESOLVED', 'REFUNDED'];

const cursorSchema = z.object({ i: z.uuid() });

function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ i: id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): string | null {
  if (cursor === undefined || cursor === '') {
    return null;
  }
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    return parsed.success ? parsed.data.i : null;
  } catch {
    return null;
  }
}

/**
 * `+994 •• ••• •• 67` — the country code and the last two digits, enough to
 * tell two numbers apart on a call without disclosing either (ADR-0043 § 6).
 */
export function maskPhone(e164: string): string {
  const countryCode = e164.startsWith('+994') ? '+994' : e164.slice(0, 3);
  return `${countryCode} •• ••• •• ${e164.slice(-2)}`;
}

export class TranscriptNotAvailableError extends AppError {
  constructor() {
    super(
      ERROR_CODES.CONFLICT,
      'A conversation transcript is read only for a disputed order.',
      409,
    );
    this.name = 'TranscriptNotAvailableError';
    Object.setPrototypeOf(this, TranscriptNotAvailableError.prototype);
  }
}

export interface AdminOrderListQuery {
  readonly status?: readonly OrderStatus[] | undefined;
  readonly serviceId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly stuck?: boolean | undefined;
  readonly sort: 'newest' | 'oldest';
  readonly cursor?: string | undefined;
  readonly limit: number;
}

/**
 * The orders module's read surface for the admin panel (issue #245). Pure
 * reads: the admin module decides who may call them and writes the audit row.
 */
@Injectable()
export class OrdersAdminReadService {
  constructor(private readonly repository: OrdersAdminRepository) {}

  async list(
    query: AdminOrderListQuery,
    now: Date = new Date(),
  ): Promise<CursorPage<AdminOrderSummary>> {
    const { rows, hasMore } = await this.repository.list({
      statuses: query.status,
      serviceId: query.serviceId,
      from: query.from === undefined ? undefined : new Date(query.from),
      to: query.to === undefined ? undefined : new Date(query.to),
      stuckBefore: query.stuck === true ? new Date(now.getTime() - STUCK_AFTER_MS) : undefined,
      oldestFirst: query.sort === 'oldest',
      afterId: decodeCursor(query.cursor),
      limit: query.limit,
    });
    const items = rows.map((row): AdminOrderSummary => ({
      id: row.id,
      status: row.status,
      serviceName: resolveLocalizedText(row.serviceName as LocalizedText, []),
      customerName: row.customerName,
      masterName: row.masterName,
      priceMinor: row.priceMinor,
      redispatchCount: row.redispatchCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last !== undefined ? encodeCursor(last.id) : null };
  }

  async detail(orderId: string): Promise<AdminOrderDetail> {
    const row = await this.repository.findDetail(orderId);
    if (row === undefined) {
      throw new NotFoundError();
    }
    const [history, photos] = await Promise.all([
      this.repository.history(orderId),
      this.repository.photos(orderId),
    ]);
    const { order } = row;
    const master: AdminOrderParty | null =
      row.master === null || row.master.id === null
        ? null
        : {
            id: row.master.id,
            displayName: row.master.displayName ?? '',
            phoneMasked: row.master.phoneE164 === null ? '' : maskPhone(row.master.phoneE164),
          };
    return {
      id: order.id,
      status: order.status,
      serviceName: resolveLocalizedText(row.serviceName, []),
      customerName: row.customer.displayName,
      masterName: master?.displayName ?? null,
      priceMinor: order.priceMinor,
      redispatchCount: order.redispatchCount,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
      description: order.description,
      acceptedAt: order.acceptedAt?.toISOString() ?? null,
      address: row.address,
      customer: {
        id: row.customer.id,
        displayName: row.customer.displayName,
        phoneMasked: maskPhone(row.customer.phoneE164),
      },
      master,
      history: history.map((entry) => ({
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        actorKind: entry.actorKind,
        actorAdminName: entry.actorAdminName,
        reason: entry.reason,
        createdAt: entry.createdAt.toISOString(),
      })),
      photos: photos.map((photo) => ({
        id: photo.id,
        status: photo.status,
        createdAt: photo.createdAt.toISOString(),
      })),
      transitions: allowedNextStatuses(order.status).map((to) => ({
        to,
        // ADR-0043 § 5: no refund mechanism exists until EPIC 12.
        available: to !== 'REFUNDED',
      })),
      transcriptAvailable: TRANSCRIPT_STATUSES.includes(order.status),
    };
  }

  /** The full number of one party, for a reveal the admin module has authorised and audited. */
  async partyPhone(orderId: string, party: 'customer' | 'master'): Promise<string> {
    const row = await this.repository.findDetail(orderId);
    const phone = party === 'customer' ? row?.customer.phoneE164 : row?.master?.phoneE164;
    if (phone === undefined || phone === null) {
      throw new NotFoundError();
    }
    return phone;
  }

  async transcript(orderId: string): Promise<AdminOrderTranscript> {
    const row = await this.repository.findDetail(orderId);
    if (row === undefined) {
      throw new NotFoundError();
    }
    if (!TRANSCRIPT_STATUSES.includes(row.order.status)) {
      throw new TranscriptNotAvailableError();
    }
    const conversations = await this.repository.transcript(
      orderId,
      TRANSCRIPT_MESSAGES_PER_CONVERSATION,
    );
    return {
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        masterId: conversation.masterId,
        openedAt: conversation.createdAt.toISOString(),
        closedAt: conversation.closedAt?.toISOString() ?? null,
        messages: conversation.messages.map((message) => ({
          id: message.id,
          senderKind: message.senderKind,
          body: message.body,
          createdAt: message.createdAt.toISOString(),
        })),
      })),
    };
  }

  /** The order half of the dashboard, category names resolved to Azerbaijani. */
  async dashboardMetrics(input: {
    readonly from: Date;
    readonly to: Date;
    readonly cellDegrees: number;
    readonly topAreas: number;
  }) {
    const metrics = await this.repository.dashboardOrderMetrics(input);
    return {
      ...metrics,
      unfilledByCategory: metrics.unfilledByCategory.map((row) => ({
        categoryId: row.category_id,
        categoryName: resolveLocalizedText(row.name as LocalizedText, []),
        count: row.count,
      })),
    };
  }
}
