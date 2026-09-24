import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import type { AdminCatalogue, AdminCatalogueCategory, AdminCatalogueService } from '@tezusta/types';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import type { DatabaseExecutor } from '../../infra/database/database.types';
import type { AuditRecorder } from '../services/catalogue-admin.service';
import { CatalogueAdminService } from '../services/catalogue-admin.service';
import { AdminRepository } from './admin.repository';
import type { AdminActor } from './admin.types';
import {
  catalogueIdParamsSchema,
  createCategorySchema,
  createServiceSchema,
  reorderSchema,
  updateCategorySchema,
  updateServiceSchema,
} from './admin-catalogue.schema';
import { RequireAdminPermission } from './admin-permission.decorator';
import { CurrentAdmin } from './current-admin.decorator';

class CatalogueIdParamsDto extends createZodDto(catalogueIdParamsSchema) {}
class CreateCategoryDto extends createZodDto(createCategorySchema) {}
class UpdateCategoryDto extends createZodDto(updateCategorySchema) {}
class CreateServiceDto extends createZodDto(createServiceSchema) {}
class UpdateServiceDto extends createZodDto(updateServiceSchema) {}
class ReorderDto extends createZodDto(reorderSchema) {}

/** The target id for a change to the order of the whole category list. */
const WHOLE_CATALOGUE_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The service catalogue, editable without an app release (EPIC 13, issue
 * #244) — `catalogue.manage`, which only `super_admin` holds at launch
 * (ADR-0043 § 1). Shape, never amounts a master charges (`admin-flow.md` § 2):
 * the reference price is what the app shows before a master quotes.
 *
 * Every write is audited with the fields it changed, inside the write's own
 * transaction. There is no delete: a service is deactivated.
 */
@Controller('admin/catalogue')
@RequireAdminPermission('catalogue.manage')
export class AdminCatalogueController {
  constructor(
    private readonly catalogue: CatalogueAdminService,
    private readonly admins: AdminRepository,
  ) {}

  @Get()
  read(): Promise<AdminCatalogue> {
    return this.catalogue.readAll();
  }

  @Post('categories')
  createCategory(
    @CurrentAdmin() admin: AdminActor,
    @Body() body: CreateCategoryDto,
  ): Promise<AdminCatalogueCategory> {
    return this.catalogue.createCategory(
      body,
      this.audit(admin, 'catalogue.category.create', 'service_category'),
    );
  }

  @Patch('categories/:id')
  updateCategory(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: CatalogueIdParamsDto,
    @Body() body: UpdateCategoryDto,
  ): Promise<AdminCatalogueCategory> {
    return this.catalogue.updateCategory(
      params.id,
      body,
      this.audit(admin, 'catalogue.category.update', 'service_category'),
    );
  }

  @Put('categories/order')
  reorderCategories(
    @CurrentAdmin() admin: AdminActor,
    @Body() body: ReorderDto,
  ): Promise<AdminCatalogue> {
    return this.catalogue.reorderCategories(
      body.ids,
      this.audit(admin, 'catalogue.category.reorder', 'catalogue', WHOLE_CATALOGUE_ID),
    );
  }

  @Put('categories/:id/services/order')
  reorderServices(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: CatalogueIdParamsDto,
    @Body() body: ReorderDto,
  ): Promise<AdminCatalogue> {
    return this.catalogue.reorderServices(
      params.id,
      body.ids,
      this.audit(admin, 'catalogue.service.reorder', 'service_category'),
    );
  }

  @Post('services')
  createService(
    @CurrentAdmin() admin: AdminActor,
    @Body() body: CreateServiceDto,
  ): Promise<AdminCatalogueService> {
    return this.catalogue.createService(
      body,
      this.audit(admin, 'catalogue.service.create', 'service'),
    );
  }

  @Patch('services/:id')
  updateService(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: CatalogueIdParamsDto,
    @Body() body: UpdateServiceDto,
  ): Promise<AdminCatalogueService> {
    return this.catalogue.updateService(
      params.id,
      body,
      this.audit(admin, 'catalogue.service.update', 'service'),
    );
  }

  private audit(
    admin: AdminActor,
    action: string,
    targetType: string,
    fixedTargetId?: string,
  ): AuditRecorder {
    return (tx: DatabaseExecutor, change) =>
      this.admins.appendAudit(
        {
          adminUserId: admin.adminUserId,
          action,
          targetType,
          targetId: fixedTargetId ?? change.targetId,
          before: change.before,
          after: change.after,
        },
        new Date(),
        tx,
      );
  }
}
