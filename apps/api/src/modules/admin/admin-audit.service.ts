import { Injectable } from '@nestjs/common';
import type { AdminAuditEntry, CursorPage } from '@tezusta/types';
import { z } from 'zod';

import { AdminRepository } from './admin.repository';
import type { ListAdminAuditLogQuery } from './admin-audit.schema';

const cursorSchema = z.object({ i: z.uuid() });

function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ i: id }), 'utf8').toString('base64url');
}

/** A cursor that does not decode starts from the top, like the review cursors. */
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

@Injectable()
export class AdminAuditService {
  constructor(private readonly admins: AdminRepository) {}

  async list(query: ListAdminAuditLogQuery): Promise<CursorPage<AdminAuditEntry>> {
    const { rows, hasMore } = await this.admins.listAudit({
      actorId: query.actorId,
      targetType: query.targetType,
      targetId: query.targetId,
      actionPrefix: query.action,
      from: query.from === undefined ? undefined : new Date(query.from),
      to: query.to === undefined ? undefined : new Date(query.to),
      afterId: decodeCursor(query.cursor),
      limit: query.limit,
    });
    const items = rows.map(({ entry, actor }): AdminAuditEntry => ({
      id: entry.id,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      reason: entry.reason,
      before: entry.before,
      after: entry.after,
      createdAt: entry.createdAt.toISOString(),
      actor,
    }));
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last !== undefined ? encodeCursor(last.id) : null };
  }
}
