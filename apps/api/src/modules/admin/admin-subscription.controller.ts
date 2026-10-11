import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import type {
  AdminMasterSubscription,
  AdminSubscription,
  MasterSubscription,
} from '@tezusta/types';

import { NotFoundError } from '../../common/errors/not-found.error';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import type { DatabaseExecutor } from '../../infra/database/database.types';
import { MastersService } from '../masters/masters.service';
import { SubscriptionOfferService } from '../subscriptions/subscription-offer.service';
import type { SubscriptionAuditRecorder } from '../subscriptions/subscriptions.repository';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { AdminRepository } from './admin.repository';
import type { AdminActor } from './admin.types';
import { masterIdParamsSchema } from './admin-masters.schema';
import { RequireAdminPermission } from './admin-permission.decorator';
import {
  changeSubscriptionPricesSchema,
  grantSubscriptionSchema,
  priceIdParamsSchema,
  subscriptionReasonSchema,
  updateSubscriptionSettingsSchema,
} from './admin-subscription.schema';
import { CurrentAdmin } from './current-admin.decorator';

class ChangePricesDto extends createZodDto(changeSubscriptionPricesSchema) {}
class UpdateSettingsDto extends createZodDto(updateSubscriptionSettingsSchema) {}
class ReasonDto extends createZodDto(subscriptionReasonSchema) {}
class GrantDto extends createZodDto(grantSubscriptionSchema) {}
class PriceIdParamsDto extends createZodDto(priceIdParamsSchema) {}
class MasterIdParamsDto extends createZodDto(masterIdParamsSchema) {}

/**
 * Writes the admin audit row inside the subscription change's own transaction
 * (#324, ADR-0043 § 6): who, what, the reason, and before/after.
 */
function auditRecorder(
  admins: AdminRepository,
  admin: AdminActor,
  action: string,
  targetType: string,
  reason: string,
): SubscriptionAuditRecorder {
  return (tx: DatabaseExecutor, change) =>
    admins.appendAudit(
      {
        adminUserId: admin.adminUserId,
        action,
        targetType,
        targetId: change.targetId,
        reason,
        before: change.before,
        after: change.after,
      },
      new Date(),
      tx,
    );
}

/**
 * The subscription offer (ADR-0046 § 5, #324): both prices, trial, grace and
 * whether purchases are open. Every role reads it; editing it is
 * `subscriptions.manage` — finance and super_admin.
 */
@Controller('admin/subscription')
export class AdminSubscriptionController {
  constructor(
    private readonly offer: SubscriptionOfferService,
    private readonly admins: AdminRepository,
  ) {}

  @RequireAdminPermission('subscriptions.read')
  @Get()
  read(): Promise<AdminSubscription> {
    return this.offer.read();
  }

  @RequireAdminPermission('subscriptions.manage')
  @Put('prices')
  changePrices(
    @CurrentAdmin() admin: AdminActor,
    @Body() body: ChangePricesDto,
  ): Promise<AdminSubscription> {
    return this.offer.changePrices(
      {
        monthlyMinor: body.monthlyMinor,
        yearlyMinor: body.yearlyMinor,
        effectiveFrom: body.effectiveFrom,
        confirmLargeChange: body.confirmLargeChange,
        adminUserId: admin.adminUserId,
      },
      auditRecorder(this.admins, admin, 'subscription.prices.change', 'subscription', body.reason),
    );
  }

  @RequireAdminPermission('subscriptions.manage')
  @HttpCode(200)
  @Post('prices/:id/withdraw')
  withdrawPrice(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: PriceIdParamsDto,
    @Body() body: ReasonDto,
  ): Promise<AdminSubscription> {
    return this.offer.withdrawPrice(
      params.id,
      admin.adminUserId,
      auditRecorder(
        this.admins,
        admin,
        'subscription.prices.withdraw',
        'subscription',
        body.reason,
      ),
    );
  }

  @RequireAdminPermission('subscriptions.manage')
  @Put('settings')
  updateSettings(
    @CurrentAdmin() admin: AdminActor,
    @Body() body: UpdateSettingsDto,
  ): Promise<AdminSubscription> {
    return this.offer.updateSettings(
      {
        trialDays: body.trialDays,
        graceDays: body.graceDays,
        purchasesOpen: body.purchasesOpen,
        adminUserId: admin.adminUserId,
      },
      auditRecorder(
        this.admins,
        admin,
        'subscription.settings.change',
        'subscription',
        body.reason,
      ),
    );
  }
}

/**
 * One master's subscription (#324): read by every role, granted or cancelled
 * by `subscriptions.manage`. A grant is, until a billing provider is live, the
 * only way to give a master a period (ADR-0046 § 5).
 *
 * Audited against the master, so the grant shows in that master's trail.
 */
@Controller('admin/masters/:id/subscription')
export class AdminMasterSubscriptionController {
  constructor(
    private readonly masters: MastersService,
    private readonly subscriptions: SubscriptionsService,
    private readonly admins: AdminRepository,
  ) {}

  @RequireAdminPermission('subscriptions.read')
  @Get()
  async read(@Param() params: MasterIdParamsDto): Promise<AdminMasterSubscription> {
    await this.requireMaster(params.id);
    return this.subscriptions.adminView(params.id);
  }

  @RequireAdminPermission('subscriptions.manage')
  @HttpCode(200)
  @Post('grant')
  async grant(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: MasterIdParamsDto,
    @Body() body: GrantDto,
  ): Promise<MasterSubscription> {
    await this.requireMaster(params.id);
    return this.subscriptions.grantPeriod(
      { masterId: params.id, adminUserId: admin.adminUserId, days: body.days, reason: body.reason },
      auditRecorder(this.admins, admin, 'subscription.grant', 'master', body.reason),
    );
  }

  @RequireAdminPermission('subscriptions.manage')
  @HttpCode(200)
  @Post('cancel')
  async cancel(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: MasterIdParamsDto,
    @Body() body: ReasonDto,
  ): Promise<MasterSubscription> {
    await this.requireMaster(params.id);
    return this.subscriptions.cancel(
      params.id,
      { kind: 'admin', adminUserId: admin.adminUserId },
      {
        reason: body.reason,
        record: auditRecorder(this.admins, admin, 'subscription.cancel', 'master', body.reason),
      },
    );
  }

  /** A soft-deleted or unknown master answers 404, never a subscription for nobody. */
  private async requireMaster(masterId: string): Promise<void> {
    const master = await this.masters.findForModeration(masterId);
    if (master === undefined || master.deletedAt !== null) {
      throw new NotFoundError();
    }
  }
}
