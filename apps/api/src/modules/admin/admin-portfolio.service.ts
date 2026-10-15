import { Injectable } from '@nestjs/common';
import type { AdminPortfolioPost, AdminPortfolioPostDetail, CursorPage } from '@tezusta/types';

import { MasterAvatarService } from '../masters/master-avatar.service';
import { PortfolioModerationService } from '../portfolio/portfolio-moderation.service';
import { AdminRepository } from './admin.repository';
import type { AdminActor } from './admin.types';
import type { ListAdminPortfolioQuery, RemovalReasonBody } from './admin-portfolio.schema';

/**
 * Portfolio moderation from the panel (#312, ADR-0045 § 6, § 8). The policy
 * — who may, what is audited — is here; the tables are the portfolio's and
 * the masters' own, reached through their services, as review moderation
 * reaches `ReviewsAdminService`.
 *
 * Both removals write their audit row inside the removal's own transaction:
 * a removal nobody can account for never commits, and an audit row for a
 * removal that did not happen is never written.
 */
@Injectable()
export class AdminPortfolioService {
  constructor(
    private readonly moderation: PortfolioModerationService,
    private readonly avatars: MasterAvatarService,
    private readonly admins: AdminRepository,
  ) {}

  async list(query: ListAdminPortfolioQuery): Promise<CursorPage<AdminPortfolioPost>> {
    return this.moderation.list({
      masterId: query.masterId,
      status: query.status,
      from: query.from === undefined ? undefined : new Date(query.from),
      to: query.to === undefined ? undefined : new Date(query.to),
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  async get(postId: string): Promise<AdminPortfolioPostDetail> {
    return this.moderation.get(postId);
  }

  async removePost(
    admin: AdminActor,
    postId: string,
    body: RemovalReasonBody,
  ): Promise<AdminPortfolioPostDetail> {
    return this.moderation.remove({
      postId,
      adminId: admin.adminUserId,
      reason: body.reason,
      record: (tx, before) =>
        this.admins.appendAudit(
          {
            adminUserId: admin.adminUserId,
            action: 'portfolio_post.remove',
            targetType: 'portfolio_post',
            targetId: postId,
            reason: body.reason,
            before: { removed: false, status: before.status, masterId: before.masterId },
            after: { removed: true, status: before.status, masterId: before.masterId },
          },
          new Date(),
          tx,
        ),
    });
  }

  async removeAvatar(admin: AdminActor, masterId: string, body: RemovalReasonBody): Promise<void> {
    await this.avatars.removeByAdmin(masterId, (tx) =>
      this.admins.appendAudit(
        {
          adminUserId: admin.adminUserId,
          action: 'master_avatar.remove',
          targetType: 'master',
          targetId: masterId,
          reason: body.reason,
          before: { avatar: true },
          after: { avatar: false },
        },
        new Date(),
        tx,
      ),
    );
  }
}
