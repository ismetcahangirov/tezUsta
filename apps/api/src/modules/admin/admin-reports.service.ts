import { Injectable } from '@nestjs/common';
import type {
  AdminReportDetail,
  AdminReportParty,
  AdminReportSummary,
  CursorPage,
} from '@tezusta/types';
import { z } from 'zod';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import { resolveLocalizedText } from '../../common/i18n/resolve-localized-text';
import type { ReportRow, ReportStatusName } from '../../infra/database/schema/reports';
import { ReportsRepository } from '../reports/reports.repository';
import { AdminRepository } from './admin.repository';
import type { AdminActor } from './admin.types';
import type { CloseReportInput, ListReportsQuery } from './admin-reports.schema';

/** How far back "reported more than once" looks (#330). */
export const REPEAT_REPORT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export class ReportStatusConflictError extends AppError {
  constructor(status: ReportStatusName) {
    super(ERROR_CODES.CONFLICT, `The report is ${status}.`, 409, { status });
    this.name = 'ReportStatusConflictError';
    Object.setPrototypeOf(this, ReportStatusConflictError.prototype);
  }
}

export class ReportOutcomeNotTakenError extends AppError {
  constructor() {
    super(
      ERROR_CODES.REPORT_OUTCOME_NOT_TAKEN,
      'That suspension is not on the reported party’s account. Suspend them from their page first.',
      409,
    );
    this.name = 'ReportOutcomeNotTakenError';
    Object.setPrototypeOf(this, ReportOutcomeNotTakenError.prototype);
  }
}

const cursorSchema = z.object({ i: z.uuid() });

function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ i: id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    return parsed.success ? parsed.data.i : null;
  } catch {
    return null;
  }
}

/** The reporter and the reported party, from the stored side. */
function partiesOf(
  report: ReportRow,
  names: { customerName: string; masterName: string },
): { reporter: AdminReportParty; reported: AdminReportParty } {
  const customer: AdminReportParty = {
    role: 'customer',
    profileId: report.customerId,
    displayName: names.customerName,
  };
  const master: AdminReportParty = {
    role: 'master',
    profileId: report.masterId,
    displayName: names.masterName,
  };
  return report.reporterRole === 'customer'
    ? { reporter: customer, reported: master }
    : { reporter: master, reported: customer };
}

function toSummary(
  report: ReportRow,
  names: { customerName: string; masterName: string },
): AdminReportSummary {
  return {
    id: report.id,
    orderId: report.orderId,
    reasonCode: report.reasonCode,
    status: report.status,
    ...partiesOf(report, names),
    createdAt: report.createdAt.toISOString(),
  };
}

/**
 * The admin queue of reports (#330, ADR-0053). An admin claims a report, reads
 * it with its order, and closes it with an outcome and a reason. Reading one
 * is audited — it carries a person's account of another — and so is every
 * change. Closing changes nobody's account: a suspension outcome records one
 * the admin already made on the reported party's page, and is refused when
 * that page shows none.
 */
@Injectable()
export class AdminReportsService {
  constructor(
    private readonly reports: ReportsRepository,
    private readonly admins: AdminRepository,
  ) {}

  /** Oldest first: the queue is worked from the front. Names only — not audited. */
  async list(query: ListReportsQuery): Promise<CursorPage<AdminReportSummary>> {
    const { rows, hasMore } = await this.reports.list({
      status: query.status,
      reasonCode: query.reason,
      afterId: decodeCursor(query.cursor),
      limit: query.limit,
    });
    const items = rows.map((row) => toSummary(row.report, row));
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last !== undefined ? encodeCursor(last.id) : null };
  }

  async detail(
    admin: AdminActor,
    reportId: string,
    now: Date = new Date(),
  ): Promise<AdminReportDetail> {
    const row = await this.reports.findDetail(reportId);
    if (row === undefined) {
      throw new NotFoundError();
    }
    const { report } = row;
    const summary = toSummary(report, row);
    const about = await this.reports.countAbout(
      summary.reported,
      new Date(now.getTime() - REPEAT_REPORT_WINDOW_MS),
    );

    await this.admins.appendAudit({
      adminUserId: admin.adminUserId,
      action: 'report.read',
      targetType: 'report',
      targetId: report.id,
    });

    return {
      ...summary,
      text: report.text,
      order: {
        id: row.order.id,
        status: row.order.status,
        serviceName: resolveLocalizedText(row.serviceName, []),
        createdAt: row.order.createdAt.toISOString(),
      },
      handledBy:
        report.handledByAdminId === null
          ? null
          : { id: report.handledByAdminId, displayName: row.handlerName ?? '' },
      claimedAt: report.claimedAt?.toISOString() ?? null,
      closedAt: report.closedAt?.toISOString() ?? null,
      outcome: report.outcome,
      outcomeReason: report.outcomeReason,
      reportsAboutReportedLast30Days: about,
    };
  }

  /** Takes a report off the open queue, as this admin. */
  /** Takes a report off the open queue, as this admin; the change and its audit row commit together. */
  async claim(admin: AdminActor, reportId: string, now: Date = new Date()): Promise<void> {
    const claimed = await this.admins.transaction(async (tx) => {
      const row = await this.reports.claim(reportId, admin.adminUserId, now, tx);
      if (row === undefined) {
        return false;
      }
      await this.admins.appendAudit(
        {
          adminUserId: admin.adminUserId,
          action: 'report.claim',
          targetType: 'report',
          targetId: reportId,
          before: { status: 'open' },
          after: { status: 'in_review' },
        },
        now,
        tx,
      );
      return true;
    });
    if (!claimed) {
      throw await this.conflictFor(reportId);
    }
  }

  async close(
    admin: AdminActor,
    reportId: string,
    input: CloseReportInput,
    now: Date = new Date(),
  ): Promise<void> {
    const row = await this.reports.findDetail(reportId);
    if (row === undefined) {
      throw new NotFoundError();
    }
    if (row.report.status !== 'in_review') {
      // The status first: an outcome check on a report nobody is handling
      // would answer the wrong question.
      throw new ReportStatusConflictError(row.report.status);
    }
    const { reported } = partiesOf(row.report, row);
    const claimsSuspension =
      input.outcome === 'master_suspended' || input.outcome === 'customer_suspended';
    if (claimsSuspension) {
      const named = input.outcome === 'master_suspended' ? 'master' : 'customer';
      if (reported.role !== named) {
        throw new ReportOutcomeNotTakenError();
      }
    }

    const closed = await this.admins.transaction(async (tx) => {
      // Inside the close's transaction, so the suspension the outcome records
      // is still in force when the close commits.
      if (claimsSuspension && !(await this.reports.isSuspended(reported, tx))) {
        throw new ReportOutcomeNotTakenError();
      }
      const updated = await this.reports.close(
        { reportId, outcome: input.outcome, reason: input.reason, now },
        tx,
      );
      if (updated === undefined) {
        return false;
      }
      // Who closed it, which may not be who claimed it.
      await this.admins.appendAudit(
        {
          adminUserId: admin.adminUserId,
          action: 'report.close',
          targetType: 'report',
          targetId: reportId,
          reason: input.reason,
          before: { status: 'in_review' },
          after: { status: 'closed', outcome: input.outcome },
        },
        now,
        tx,
      );
      return true;
    });
    if (!closed) {
      throw await this.conflictFor(reportId);
    }
  }

  /** A 404 for a report that does not exist, a 409 naming its status for one that moved. */
  private async conflictFor(reportId: string): Promise<AppError> {
    const row = await this.reports.findDetail(reportId);
    return row === undefined
      ? new NotFoundError()
      : new ReportStatusConflictError(row.report.status);
  }
}
