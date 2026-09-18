import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import {
  listMastersQuerySchema,
  masterDocumentParamsSchema,
  masterIdParamsSchema,
  reasonedActionSchema,
  reasonlessActionSchema,
} from './admin-masters.schema';
import { AdminMastersService } from './admin-masters.service';
import type { AdminMasterDetail, AdminMasterSummary } from './admin-masters.types';
import type { AdminActor } from './admin.types';
import { CurrentAdmin } from './current-admin.decorator';

class ListMastersQueryDto extends createZodDto(listMastersQuerySchema) {}
class MasterIdParamsDto extends createZodDto(masterIdParamsSchema) {}
class MasterDocumentParamsDto extends createZodDto(masterDocumentParamsSchema) {}
class ReasonedActionDto extends createZodDto(reasonedActionSchema) {}
class ReasonlessActionDto extends createZodDto(reasonlessActionSchema) {}

/**
 * Admin review of master verification — a **separate, separately-guarded
 * surface** (`docs/product/admin-flow.md`, non-negotiable 6).
 *
 * There is no `@Roles()` here and no `@Public()`. Every route under `/admin`
 * is authenticated by `AdminAuthenticationGuard` because of its **path**, not
 * because of a decorator somebody remembered: a consumer access token fails
 * the audience check, and the consumer guard steps aside for this prefix
 * entirely. `admin-verification.e2e.test.ts` walks the live route table and
 * asserts that every `/admin` route refuses an ordinary customer's token.
 *
 * `POST` for every action rather than `PATCH /masters/:id { status }`. A
 * verification decision is a named event with a reason and an audit entry, not
 * a field assignment — and a status column a client can set to an arbitrary
 * value is a state machine with no transitions.
 */
@Controller('admin/masters')
export class AdminMastersController {
  constructor(private readonly masters: AdminMastersService) {}

  @Get()
  async list(
    @Query() query: ListMastersQueryDto,
  ): Promise<{ items: AdminMasterSummary[]; nextCursor: string | null }> {
    return this.masters.list(query);
  }

  @Get(':id')
  async detail(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: MasterIdParamsDto,
  ): Promise<AdminMasterDetail> {
    return this.masters.getDetail(admin, params.id);
  }

  @Get(':id/documents/:documentId/download')
  async download(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: MasterDocumentParamsDto,
  ): Promise<{ url: string; expiresAt: string }> {
    return this.masters.presignDocument(admin, params.id, params.documentId);
  }

  /**
   * `verify` and `reinstate` still take a body DTO, an empty strict object.
   *
   * It is not ceremony: `.strict()` means a client that sends
   * `{ "reason": "..." }` to `verify` gets a 422 rather than having the field
   * silently ignored. An admin who typed a reason should be told it was not
   * recorded, not left believing it was.
   */
  @Post(':id/verify')
  async verify(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: MasterIdParamsDto,
    @Body() _body: ReasonlessActionDto,
  ): Promise<AdminMasterSummary> {
    return this.masters.act(admin, params.id, 'verify');
  }

  @Post(':id/reject')
  async reject(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: MasterIdParamsDto,
    @Body() body: ReasonedActionDto,
  ): Promise<AdminMasterSummary> {
    return this.masters.act(admin, params.id, 'reject', body.reason);
  }

  @Post(':id/request-more')
  async requestMore(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: MasterIdParamsDto,
    @Body() body: ReasonedActionDto,
  ): Promise<AdminMasterSummary> {
    return this.masters.act(admin, params.id, 'request_more', body.reason);
  }

  @Post(':id/suspend')
  async suspend(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: MasterIdParamsDto,
    @Body() body: ReasonedActionDto,
  ): Promise<AdminMasterSummary> {
    return this.masters.act(admin, params.id, 'suspend', body.reason);
  }

  @Post(':id/reinstate')
  async reinstate(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: MasterIdParamsDto,
    @Body() _body: ReasonlessActionDto,
  ): Promise<AdminMasterSummary> {
    return this.masters.act(admin, params.id, 'reinstate');
  }
}
