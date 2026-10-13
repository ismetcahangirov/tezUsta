import { Inject, Injectable } from '@nestjs/common';
import type { OwnReport, ReportableParty } from '@tezusta/types';

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
    super(ERROR_CODES.REPORT_NO_OTHER_PARTY, 'No master has taken this order.', 409);
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
    const pairing = await this.requirePairing(context, role, input.masterId);
    this.assertOpen(pairing);
    const created = await this.reports.insert({
      orderId: context.id,
      customerId: context.customerId,
      masterId: pairing.masterId,
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
    const pairing = await this.requirePairing(context, role, input.masterId);
    this.assertOpen(pairing);
    const updated = await this.reports.updateOwn(context.id, pairing.masterId, role, {
      reasonCode: input.reasonCode,
      text: input.text,
    });
    if (updated !== undefined) {
      return present(updated);
    }
    if ((await this.reports.findOwn(context.id, pairing.masterId, role)) === undefined) {
      throw new NotFoundError();
    }
    throw new ReportNotEditableError();
  }

  /** The caller's own report about the default party (see `requirePairing`). */
  async getOwn(actor: Actor, orderId: string): Promise<OwnReport> {
    const { context, role } = await this.requireReporter(actor, orderId);
    const pairing = defaultPairing(await this.pairingsOf(context, role));
    const own =
      pairing === undefined
        ? undefined
        : await this.reports.findOwn(context.id, pairing.masterId, role);
    if (own === undefined) {
      throw new NotFoundError();
    }
    return present(own);
  }

  /**
   * Everyone the caller may report on this order, with each one's window and
   * the caller's own report about them (ADR-0053 § 1). The app's report form
   * is drawn from this.
   */
  async parties(actor: Actor, orderId: string, now: Date = new Date()): Promise<ReportableParty[]> {
    const { context, role } = await this.requireReporter(actor, orderId);
    const pairings = await this.pairingsOf(context, role);
    return Promise.all(
      pairings.map(async (pairing): Promise<ReportableParty> => {
        const own = await this.reports.findOwn(context.id, pairing.masterId, role);
        return {
          role: role === 'customer' ? 'master' : 'customer',
          profileId: role === 'customer' ? pairing.masterId : context.customerId,
          displayName: pairing.displayName,
          current: pairing.current,
          open: isOpen(pairing, now),
          closesAt: pairing.closesAt === null ? null : pairing.closesAt.toISOString(),
          report: own === undefined ? null : present(own),
        };
      }),
    );
  }

  /**
   * The pairings this caller has on the order. For a customer: every master
   * who accepted it, the one on it now and any who gave it up. For the master
   * on it: the customer. The current pairing's window is the order's; a
   * master who left is reportable for the review window from when they left.
   */
  private async pairingsOf(
    context: ReportOrderContext,
    role: ReportPartyRoleName,
  ): Promise<Pairing[]> {
    const orderClosesAt = this.closesAt(context.endedAt);
    if (role === 'master') {
      // Only the current master reaches here (`requireReporter`).
      const customer = await this.reports.customerOf(context.customerId);
      return context.masterId === null || customer === undefined
        ? []
        : [
            {
              masterId: context.masterId,
              displayName: customer.displayName,
              current: true,
              closesAt: orderClosesAt,
            },
          ];
    }
    const masters = await this.reports.listOrderMasters(context.id);
    const pairings: Pairing[] = masters.map((master) => {
      const current = master.masterId === context.masterId;
      return {
        masterId: master.masterId,
        displayName: master.displayName,
        current,
        closesAt: current || master.leftAt === null ? orderClosesAt : this.closesAt(master.leftAt),
      };
    });
    // A current master with no conversation row is still the order's master.
    if (context.masterId !== null && !pairings.some((pairing) => pairing.current)) {
      const current = await this.reports.masterOf(context.masterId);
      if (current !== undefined) {
        pairings.push({
          masterId: current.id,
          displayName: current.displayName,
          current: true,
          closesAt: orderClosesAt,
        });
      }
    }
    return pairings;
  }

  /**
   * The pairing a request means. A master reports the customer and names no
   * master. A customer may name any master who accepted the order; with none
   * named, it is the master on the order now, or else the one who left last.
   */
  private async requirePairing(
    context: ReportOrderContext,
    role: ReportPartyRoleName,
    masterId: string | undefined,
  ): Promise<Pairing> {
    if (role === 'master' && masterId !== undefined && masterId !== context.masterId) {
      throw new NotFoundError();
    }
    const pairings = await this.pairingsOf(context, role);
    const pairing =
      role === 'customer' && masterId !== undefined
        ? pairings.find((candidate) => candidate.masterId === masterId)
        : defaultPairing(pairings);
    if (pairing === undefined) {
      if (masterId !== undefined) {
        // A master who never accepted this order: no such pairing.
        throw new NotFoundError();
      }
      throw new ReportNoOtherPartyError();
    }
    return pairing;
  }

  private assertOpen(pairing: Pairing, now: Date = new Date()): void {
    if (pairing.closesAt !== null && !isOpen(pairing, now)) {
      throw new ReportWindowClosedError(pairing.closesAt);
    }
  }

  /** The review window from `from`; `null` (still open) when there is no end yet. */
  private closesAt(from: Date | null): Date | null {
    return from === null
      ? null
      : new Date(from.getTime() + this.config.reviews.windowHours * HOUR_MS);
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

interface Pairing {
  readonly masterId: string;
  /** The counterpart's name: the master for a customer, the customer for a master. */
  readonly displayName: string;
  readonly current: boolean;
  /** `null` while the order runs. */
  readonly closesAt: Date | null;
}

function isOpen(pairing: Pairing, now: Date): boolean {
  return pairing.closesAt === null || now.getTime() < pairing.closesAt.getTime();
}

/** The master on the order now, or else the one who left it last. */
function defaultPairing(pairings: readonly Pairing[]): Pairing | undefined {
  const current = pairings.find((pairing) => pairing.current);
  if (current !== undefined) return current;
  return [...pairings].sort(
    (a, b) => (b.closesAt?.getTime() ?? 0) - (a.closesAt?.getTime() ?? 0),
  )[0];
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
