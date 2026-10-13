import { Inject, Injectable } from '@nestjs/common';
import type { OwnReport } from '@tezusta/types';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import type { ReportPartyRoleName, ReportRow } from '../../infra/database/schema/reports';
import type { Actor } from '../auth/auth.types';
import { CustomersService } from '../customers/customers.service';
import { MastersService } from '../masters/masters.service';
import type { ReportOrderContext } from './reports.repository';
import { ReportsRepository } from './reports.repository';
import type { SubmitReportInput } from './reports.schema';

const HOUR_MS = 3_600_000;

export class ReportWindowClosedError extends AppError {
  constructor(closedAt: Date) {
    super(
      ERROR_CODES.REPORT_WINDOW_CLOSED,
      'Reports on this order were accepted for the review window after it ended.',
      409,
      { closedAt: closedAt.toISOString() },
    );
    this.name = 'ReportWindowClosedError';
    Object.setPrototypeOf(this, ReportWindowClosedError.prototype);
  }
}

export class ReportNoOtherPartyError extends AppError {
  constructor() {
    super(ERROR_CODES.REPORT_NO_OTHER_PARTY, 'No master has taken this order yet.', 409);
    this.name = 'ReportNoOtherPartyError';
    Object.setPrototypeOf(this, ReportNoOtherPartyError.prototype);
  }
}

export class ReportAlreadyFiledError extends AppError {
  constructor() {
    super(
      ERROR_CODES.REPORT_ALREADY_FILED,
      'You have already reported this order. Edit that report instead.',
      409,
    );
    this.name = 'ReportAlreadyFiledError';
    Object.setPrototypeOf(this, ReportAlreadyFiledError.prototype);
  }
}

export class ReportNotEditableError extends AppError {
  constructor() {
    super(
      ERROR_CODES.REPORT_NOT_EDITABLE,
      'This report is being reviewed and can no longer be changed.',
      409,
    );
    this.name = 'ReportNotEditableError';
    Object.setPrototypeOf(this, ReportNotEditableError.prototype);
  }
}

/**
 * A party's report about the other party on one order (#330, ADR-0053).
 *
 * Only the two parties to the order may report, each about the other, while
 * the order runs and for the review window after it ends. A stranger gets the
 * same 404 a missing order gets, so an order id cannot be probed. Nothing is
 * sent to anyone: the reported party is never told, and no endpoint lets them
 * read a report about themselves.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly reports: ReportsRepository,
    private readonly customers: CustomersService,
    private readonly masters: MastersService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async submit(actor: Actor, orderId: string, input: SubmitReportInput): Promise<OwnReport> {
    const { context, role } = await this.requireReporter(actor, orderId);
    this.assertWindowOpen(context);
    if (context.masterId === null) {
      // Only a customer can be here: a master is a party only once assigned.
      throw new ReportNoOtherPartyError();
    }
    const created = await this.reports.insert({
      orderId: context.id,
      customerId: context.customerId,
      masterId: context.masterId,
      reporterRole: role,
      reasonCode: input.reasonCode,
      text: input.text,
    });
    if (created === undefined) {
      throw new ReportAlreadyFiledError();
    }
    return present(created);
  }

  /** Changes the caller's report while no admin has claimed it. */
  async editOwn(actor: Actor, orderId: string, input: SubmitReportInput): Promise<OwnReport> {
    const { context, role } = await this.requireReporter(actor, orderId);
    this.assertWindowOpen(context);
    if (context.masterId === null) {
      // No master now, so no pairing this caller could have reported.
      throw new NotFoundError();
    }
    const updated = await this.reports.updateOwn(context.id, context.masterId, role, {
      reasonCode: input.reasonCode,
      text: input.text,
    });
    if (updated !== undefined) {
      return present(updated);
    }
    if ((await this.reports.findOwn(context.id, context.masterId, role)) === undefined) {
      throw new NotFoundError();
    }
    throw new ReportNotEditableError();
  }

  /** The caller's own report on the order, or 404 when they filed none. */
  async getOwn(actor: Actor, orderId: string): Promise<OwnReport> {
    const { context, role } = await this.requireReporter(actor, orderId);
    const own =
      context.masterId === null
        ? undefined
        : await this.reports.findOwn(context.id, context.masterId, role);
    if (own === undefined) {
      throw new NotFoundError();
    }
    return present(own);
  }

  /**
   * Open while the order runs; once it has ended, for the review window from
   * the moment it last ended (ADR-0053 § 1).
   */
  private assertWindowOpen(context: ReportOrderContext, now: Date = new Date()): void {
    if (context.endedAt === null) {
      return;
    }
    const closesAt = new Date(
      context.endedAt.getTime() + this.config.reviews.windowHours * HOUR_MS,
    );
    if (now.getTime() >= closesAt.getTime()) {
      throw new ReportWindowClosedError(closesAt);
    }
  }

  /**
   * The order and which side of it the caller is on — or 404. The assigned
   * master is asked about first, as everywhere else: one account may hold both
   * roles, and on its own order it is the customer.
   */
  private async requireReporter(
    actor: Actor,
    orderId: string,
  ): Promise<{ context: ReportOrderContext; role: ReportPartyRoleName }> {
    const context = await this.reports.findOrderContext(orderId);
    if (context === undefined) {
      throw new NotFoundError();
    }
    if (context.masterId !== null) {
      const master = await this.masters.findOwn(actor);
      if (master !== undefined && master.id === context.masterId) {
        return { context, role: 'master' };
      }
    }
    const customer = await this.customers.findOwn(actor);
    if (customer !== undefined && customer.id === context.customerId) {
      return { context, role: 'customer' };
    }
    throw new NotFoundError();
  }
}

function present(row: ReportRow): OwnReport {
  return {
    id: row.id,
    orderId: row.orderId,
    reasonCode: row.reasonCode,
    text: row.text,
    status: row.status,
    editable: row.status === 'open',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
