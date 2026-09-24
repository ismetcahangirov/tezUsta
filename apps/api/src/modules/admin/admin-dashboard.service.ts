import { Inject, Injectable } from '@nestjs/common';
import type { AdminDashboard } from '@tezusta/types';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { MasterLocationRepository } from '../masters/master-location.repository';
import { OrdersAdminReadService } from '../orders/orders-admin-read.service';
import type { AdminDashboardQuery } from './admin-dashboard.schema';

/** ADR-0043 § 7: "area" is a 0.02° grid cell until a districts dataset exists. */
export const DASHBOARD_CELL_DEGREES = 0.02;
const TOP_AREAS = 15;

function rate(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 1000) / 1000;
}

/**
 * "Is the marketplace working?" (`admin-flow.md` § 6, issue #246). The order
 * numbers come from the orders module and the supply numbers from the masters
 * module; this class only puts them side by side.
 */
@Injectable()
export class AdminDashboardService {
  constructor(
    private readonly orders: OrdersAdminReadService,
    private readonly locations: MasterLocationRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async read(query: AdminDashboardQuery): Promise<AdminDashboard> {
    const [metrics, available] = await Promise.all([
      this.orders.dashboardMetrics({
        from: query.from,
        to: query.to,
        cellDegrees: DASHBOARD_CELL_DEGREES,
        topAreas: TOP_AREAS,
      }),
      this.locations.countAvailableByCell({
        maxPositionAgeSeconds: this.config.dispatch.maxPositionAgeSeconds,
        cellDegrees: DASHBOARD_CELL_DEGREES,
        topAreas: TOP_AREAS,
      }),
    ]);
    const { totals } = metrics;
    return {
      from: query.from.toISOString(),
      to: query.to.toISOString(),
      cellDegrees: DASHBOARD_CELL_DEGREES,
      orders: {
        created: totals.created,
        filled: totals.filled,
        unfilled: totals.unfilled,
        searching: totals.searching,
        cancelled: totals.cancelled,
        cancelledAfterAccept: metrics.cancelledAfterAccept,
        cancelledBy: metrics.cancelledBy.map((row) => ({
          actorKind: row.actor_kind,
          count: row.count,
        })),
        fillRate: rate(totals.filled, totals.created),
        unfilledRate: rate(totals.unfilled, totals.created),
        cancellationRate: rate(totals.cancelled, totals.created),
      },
      unfilledByCategory: metrics.unfilledByCategory,
      unfilledByArea: metrics.unfilledByArea,
      mastersAvailable: { total: available.total, byArea: available.cells },
      openDisputes: {
        count: metrics.disputes.count,
        // A raw query hands timestamps back as text; normalised here.
        oldestDisputedAt:
          metrics.disputes.oldest === null ? null : new Date(metrics.disputes.oldest).toISOString(),
      },
    };
  }
}
