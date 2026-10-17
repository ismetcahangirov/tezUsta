import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The portfolio's tables (issue #307, ADR-0045) hold together whatever writes
 * to them: each CHECK refuses its illegal shape, the unique constraints bite,
 * and the feed and sweep queries have their indexes from day one.
 *
 * The queries are written here as SQL because their repositories do not exist
 * yet (#308, #310, #311). When they land, each probe moves into
 * `hot-path-plans.schema.test.ts`, run through its repository.
 */

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly Plans?: readonly PlanNode[];
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

describe('the portfolio schema (issue #307)', () => {
  let database: ThrowawayDatabase;
  let pool: Pool;
  let counter = 0;
  let masterId: string;
  let adminId: string;
  let serviceId: string;

  async function one<T>(text: string, params: unknown[] = []): Promise<T> {
    const { rows } = await pool.query(text, params);
    const row = rows[0] as T | undefined;
    if (row === undefined) {
      throw new Error(`No row from: ${text}`);
    }
    return row;
  }

  async function newMaster(): Promise<string> {
    counter += 1;
    const user = await one<{ id: string }>(
      `insert into users (id, phone_e164, status) values (gen_random_uuid(), $1, 'active') returning id`,
      [`+99455${String(counter).padStart(7, '0')}`],
    );
    const master = await one<{ id: string }>(
      `insert into masters (id, user_id, display_name) values (gen_random_uuid(), $1, 'Rəşad') returning id`,
      [user.id],
    );
    return master.id;
  }

  /** A post with any columns overridden; the default is a valid draft. */
  async function insertPost(columns: Record<string, unknown> = {}): Promise<string> {
    const values = { master_id: masterId, ...columns };
    const names = Object.keys(values);
    const row = await one<{ id: string }>(
      `insert into portfolio_posts (id, ${names.join(', ')})
       values (gen_random_uuid(), ${names.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
      Object.values(values),
    );
    return row.id;
  }

  /** A photo with any columns overridden; the default is a valid pending upload. */
  async function insertMedia(postId: string, columns: Record<string, unknown> = {}): Promise<void> {
    counter += 1;
    const values = {
      post_id: postId,
      position: 0,
      raw_storage_key: `portfolio-raw/${counter}`,
      declared_content_type: 'image/jpeg',
      presign_expires_at: new Date(Date.now() + 300_000),
      ...columns,
    };
    const names = Object.keys(values);
    await pool.query(
      `insert into portfolio_media (id, ${names.join(', ')})
       values (gen_random_uuid(), ${names.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(values),
    );
  }

  async function refusedBy(constraint: string, write: Promise<unknown>): Promise<void> {
    await expect(write).rejects.toMatchObject({ constraint });
  }

  const UPLOADED = {
    status: 'uploaded',
    verified_content_type: 'image/jpeg',
    raw_size_bytes: 900_000,
  };
  const READY = {
    ...UPLOADED,
    status: 'ready',
    thumb_key: 'portfolio/a/thumb.webp',
    display_key: 'portfolio/a/display.webp',
    width: 1440,
    height: 1080,
    bytes_total: 260_000,
  };

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);
    masterId = await newMaster();
    adminId = (
      await one<{ id: string }>(
        `insert into admin_users (id, email, display_name) values (gen_random_uuid(), 'moderator@tezusta.az', 'Nigar') returning id`,
      )
    ).id;
    serviceId = (await one<{ id: string }>(`select id from services limit 1`)).id;
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  describe('portfolio_posts', () => {
    it('starts a post as an empty draft', async () => {
      const id = await insertPost();
      const row = await one<{ status: string; media_count: number }>(
        `select status, media_count from portfolio_posts where id = $1`,
        [id],
      );
      expect(row).toEqual({ status: 'draft', media_count: 0 });
    });

    it('accepts a published, tagged, captioned post', async () => {
      await insertPost({
        status: 'published',
        published_at: new Date(),
        caption: 'Kranı dəyişdim.',
        service_id: serviceId,
        media_count: 3,
      });
    });

    it('refuses a published post with no publication time', async () => {
      await refusedBy('portfolio_posts_published_has_time', insertPost({ status: 'published' }));
    });

    it('refuses a deleted post with no deletion time', async () => {
      await refusedBy('portfolio_posts_deleted_has_time', insertPost({ status: 'deleted' }));
    });

    it('refuses a blank caption, and one over the 2000-character backstop', async () => {
      await refusedBy('portfolio_posts_caption_length', insertPost({ caption: '   ' }));
      await refusedBy('portfolio_posts_caption_length', insertPost({ caption: 'a'.repeat(2001) }));
      // The 500 cap is the env var's, enforced at the API, so raising it needs no migration.
      await insertPost({ caption: 'a'.repeat(2000) });
    });

    it('refuses a negative photo count', async () => {
      await refusedBy('portfolio_posts_media_count_non_negative', insertPost({ media_count: -1 }));
    });

    it('accepts a complete removal and refuses a partial one', async () => {
      const removal = {
        status: 'published',
        published_at: new Date(),
        removed_at: new Date(),
        removed_by_admin_id: adminId,
        removal_reason: 'Ev nömrəsi görünür.',
      };
      await insertPost(removal);
      await refusedBy(
        'portfolio_posts_removal_shape',
        insertPost({ ...removal, removal_reason: null }),
      );
      await refusedBy(
        'portfolio_posts_removal_shape',
        insertPost({ ...removal, removed_by_admin_id: null }),
      );
      await refusedBy(
        'portfolio_posts_removal_shape',
        insertPost({ ...removal, removed_at: null }),
      );
      await refusedBy(
        'portfolio_posts_removal_shape',
        insertPost({ ...removal, removal_reason: 'x'.repeat(601) }),
      );
    });

    it('refuses deleting a removed post, which would send its evidence to the sweep', async () => {
      await refusedBy(
        'portfolio_posts_removed_not_deleted',
        insertPost({
          status: 'deleted',
          deleted_at: new Date(),
          removed_at: new Date(),
          removed_by_admin_id: adminId,
          removal_reason: 'Sənəd görünür.',
        }),
      );
    });

    it('records evidence only on a removed post, and purges it whether or not it moved (#362)', async () => {
      const removal = {
        status: 'published',
        published_at: new Date(),
        removed_at: new Date(),
        removed_by_admin_id: adminId,
        removal_reason: 'Sənəd görünür.',
      };
      await insertPost({
        ...removal,
        evidence_moved_at: new Date(),
        evidence_purged_at: new Date(),
      });
      // Past retention, a move that never finished is purged where it is.
      await insertPost({
        ...removal,
        evidence_attempted_at: new Date(),
        evidence_purged_at: new Date(),
      });
      for (const column of ['evidence_moved_at', 'evidence_purged_at', 'evidence_attempted_at']) {
        await refusedBy(
          'portfolio_posts_evidence_shape',
          insertPost({ status: 'published', published_at: new Date(), [column]: new Date() }),
        );
      }
    });

    it('refuses a negative post count on the master', async () => {
      await refusedBy(
        'masters_portfolio_post_count_non_negative',
        pool.query(`update masters set portfolio_post_count = -1 where id = $1`, [masterId]),
      );
    });
  });

  describe('portfolio_media', () => {
    it('accepts each legal step of an upload', async () => {
      const postId = await insertPost();
      await insertMedia(postId, { position: 0 });
      await insertMedia(postId, { position: 1, ...UPLOADED });
      await insertMedia(postId, { position: 2, ...UPLOADED, status: 'processing' });
      await insertMedia(postId, { position: 3, ...READY });
      await insertMedia(postId, { position: 4, status: 'failed', failure_code: 'undecodable' });
      // Keys written ahead of their objects, while processing or after a failure.
      await insertMedia(postId, {
        position: 5,
        ...UPLOADED,
        status: 'processing',
        thumb_key: 'portfolio/w/thumb.webp',
        display_key: 'portfolio/w/display.webp',
      });
      await insertMedia(postId, {
        position: 6,
        status: 'failed',
        failure_code: 'undecodable',
        thumb_key: 'portfolio/f/thumb.webp',
        display_key: 'portfolio/f/display.webp',
      });
    });

    it('refuses a second photo in the same place, and a negative place', async () => {
      const postId = await insertPost();
      await insertMedia(postId, { position: 0 });
      await refusedBy('portfolio_media_post_position_unique', insertMedia(postId, { position: 0 }));
      await refusedBy(
        'portfolio_media_position_non_negative',
        insertMedia(postId, { position: -1 }),
      );
    });

    it('refuses a raw key used twice', async () => {
      const postId = await insertPost();
      await insertMedia(postId, { position: 0, raw_storage_key: 'portfolio-raw/same' });
      await refusedBy(
        'portfolio_media_raw_storage_key_unique',
        insertMedia(postId, { position: 1, raw_storage_key: 'portfolio-raw/same' }),
      );
    });

    it('refuses an upload shape that skips a step', async () => {
      const postId = await insertPost();
      // Pending, but already sized.
      await refusedBy(
        'portfolio_media_upload_shape',
        insertMedia(postId, { position: 0, raw_size_bytes: 10 }),
      );
      // Uploaded, with no sniffed type.
      await refusedBy(
        'portfolio_media_upload_shape',
        insertMedia(postId, { position: 0, status: 'uploaded', raw_size_bytes: 10 }),
      );
      // Uploaded, with an empty object.
      await refusedBy(
        'portfolio_media_upload_shape',
        insertMedia(postId, { position: 0, ...UPLOADED, raw_size_bytes: 0 }),
      );
      // Failed, with no reason.
      await refusedBy(
        'portfolio_media_upload_shape',
        insertMedia(postId, { position: 0, status: 'failed' }),
      );
    });

    it('refuses a ready photo without both renditions, and renditions on one that is not ready', async () => {
      const postId = await insertPost();
      await refusedBy(
        'portfolio_media_renditions_shape',
        insertMedia(postId, { position: 0, ...READY, display_key: null }),
      );
      await refusedBy(
        'portfolio_media_renditions_shape',
        insertMedia(postId, { position: 0, ...READY, width: 0 }),
      );
      // Null, not zero: `width > 0` alone would let these through, as a null CHECK passes.
      for (const missing of ['width', 'height', 'bytes_total']) {
        await refusedBy(
          'portfolio_media_renditions_shape',
          insertMedia(postId, { position: 0, ...READY, [missing]: null }),
        );
      }
      // Half a pair, written ahead while processing.
      await refusedBy(
        'portfolio_media_renditions_shape',
        insertMedia(postId, {
          position: 0,
          ...UPLOADED,
          status: 'processing',
          thumb_key: 'portfolio/h/thumb.webp',
        }),
      );
      await refusedBy(
        'portfolio_media_renditions_shape',
        insertMedia(postId, { position: 0, ...UPLOADED, thumb_key: 'portfolio/b/thumb.webp' }),
      );
    });
  });

  describe('the avatar', () => {
    async function insertAvatarUpload(master: string, columns: Record<string, unknown> = {}) {
      counter += 1;
      const values = {
        master_id: master,
        raw_storage_key: `avatar-raw/${counter}`,
        declared_content_type: 'image/jpeg',
        presign_expires_at: new Date(Date.now() + 300_000),
        ...columns,
      };
      const names = Object.keys(values);
      await pool.query(
        `insert into master_avatar_uploads (id, ${names.join(', ')})
         values (gen_random_uuid(), ${names.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(values),
      );
    }

    it('allows one upload in flight per master, and any number finished', async () => {
      const master = await newMaster();
      await insertAvatarUpload(master);
      await refusedBy('master_avatar_uploads_in_flight_unique', insertAvatarUpload(master));
      await refusedBy(
        'master_avatar_uploads_in_flight_unique',
        insertAvatarUpload(master, { ...UPLOADED, status: 'processing' }),
      );
      await insertAvatarUpload(master, {
        ...UPLOADED,
        status: 'ready',
        thumb_key: 'avatars/r/thumb.webp',
        display_key: 'avatars/r/display.webp',
      });
      await insertAvatarUpload(master, { status: 'failed', failure_code: 'too_large' });
    });

    it('refuses an avatar upload shape that skips a step', async () => {
      const master = await newMaster();
      await refusedBy(
        'master_avatar_uploads_upload_shape',
        insertAvatarUpload(master, { status: 'uploaded' }),
      );
    });

    it("records an upload's renditions as a pair, present once ready", async () => {
      const master = await newMaster();
      await refusedBy(
        'master_avatar_uploads_renditions_shape',
        insertAvatarUpload(master, { ...UPLOADED, status: 'ready' }),
      );
      await refusedBy(
        'master_avatar_uploads_renditions_shape',
        insertAvatarUpload(master, {
          ...UPLOADED,
          status: 'ready',
          thumb_key: 'avatars/s/thumb.webp',
        }),
      );
      await refusedBy(
        'master_avatar_uploads_renditions_shape',
        insertAvatarUpload(master, { renditions_deleted_at: new Date() }),
      );
    });

    it('keeps the two rendition keys on masters together', async () => {
      const master = await newMaster();
      await pool.query(
        `update masters set avatar_thumb_key = 'avatars/a/thumb.webp', avatar_display_key = 'avatars/a/display.webp' where id = $1`,
        [master],
      );
      await refusedBy(
        'masters_avatar_pair',
        pool.query(`update masters set avatar_display_key = null where id = $1`, [master]),
      );
      await refusedBy(
        'masters_avatar_pair',
        pool.query(
          `update masters set avatar_thumb_key = null, avatar_display_key = 'avatars/b/display.webp' where id = $1`,
          [master],
        ),
      );
    });
  });

  /**
   * The feed and the sweep at a realistic size: many masters, most posts
   * published, a sliver in the sweep's states. `ANALYZE`d, then planned with
   * the planner's own choice (`enable_seqscan` left on).
   */
  describe('query plans', () => {
    beforeAll(async () => {
      await pool.query(`
        with m as (
          select gen_random_uuid() as user_id, gen_random_uuid() as master_id, n
          from generate_series(1, 400) as n
        ), u as (
          insert into users (id, phone_e164, status)
          select user_id, '+99470' || lpad(n::text, 7, '0'), 'active' from m
        ), ms as (
          insert into masters (id, user_id, display_name)
          select master_id, user_id, 'Usta ' || n from m
          returning id
        )
        insert into portfolio_posts (id, master_id, status, published_at, deleted_at, updated_at)
        select gen_random_uuid(), ms.id,
               case when p % 40 = 0 then 'deleted'::portfolio_post_status
                    when p % 41 = 0 then 'draft'::portfolio_post_status
                    else 'published'::portfolio_post_status end,
               now() - make_interval(hours => p),
               case when p % 40 = 0 then now() else null end,
               now() - make_interval(hours => p)
        from ms, generate_series(1, 60) as p
      `);
      // Most photos ready, a sliver still awaiting upload: the sweep's index
      // must pick that sliver out of a table of finished rows.
      await pool.query(`
        insert into portfolio_media (id, post_id, position, raw_storage_key, declared_content_type,
                                     verified_content_type, raw_size_bytes, status, presign_expires_at,
                                     thumb_key, display_key, width, height, bytes_total)
        select gen_random_uuid(), id, 0, 'raw/' || id, 'image/jpeg', 'image/jpeg', 900000, 'ready',
               now() - interval '1 day', 'portfolio/' || id || '/thumb.webp',
               'portfolio/' || id || '/display.webp', 1440, 1080, 260000
        from portfolio_posts p where status = 'published'
          and not exists (select 1 from portfolio_media m where m.post_id = p.id)
      `);
      await pool.query(`
        insert into portfolio_media (id, post_id, position, raw_storage_key, declared_content_type, status, presign_expires_at)
        select gen_random_uuid(), id, 0, 'raw/' || id, 'image/jpeg', 'awaiting_upload', now() - interval '1 hour'
        from portfolio_posts p where status = 'draft'
          and not exists (select 1 from portfolio_media m where m.post_id = p.id)
      `);
      // About one published post in thirty removed by an admin, nearly all of
      // them kept as evidence and a few still waiting to move: the move's
      // index must pick those few out of the removals awaiting their purge.
      await pool.query(
        `update portfolio_posts
            set removed_at = published_at, removed_by_admin_id = $1, removal_reason = 'Qayda',
                evidence_moved_at = case when abs(hashtext(id::text || 'move')) % 20 = 0
                                         then null else published_at end
          where status = 'published' and abs(hashtext(id::text)) % 30 = 0`,
        [adminId],
      );
      await pool.query('analyze portfolio_posts; analyze portfolio_media;');
    }, 60_000);

    async function indexesUsed(sqlText: string, params: unknown[]): Promise<string[]> {
      const { rows } = await pool.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
        `explain (format json) ${sqlText}`,
        params,
      );
      const plan = rows[0]?.['QUERY PLAN'][0].Plan;
      if (plan === undefined) {
        throw new Error('EXPLAIN returned no plan.');
      }
      const nodes = flatten(plan);
      expect(
        nodes
          .filter((node) => node['Node Type'] === 'Seq Scan')
          .map((node) => node['Relation Name']),
      ).toEqual([]);
      return nodes.flatMap((node) => [
        ...(node['Index Name'] === undefined ? [] : [node['Index Name']]),
        ...(node['Node Type'] === 'Sort' ? ['(sort)'] : []),
      ]);
    }

    it('serves a profile feed page from the feed index, with no sort', async () => {
      const { id } = await one<{ id: string }>(
        `select id from masters where display_name = 'Usta 7'`,
      );
      const used = await indexesUsed(
        `select id from portfolio_posts
          where master_id = $1 and status = 'published' and removed_at is null
          order by published_at desc, id desc
          limit 30`,
        [id],
      );
      expect(used).toContain('portfolio_posts_feed_idx');
      // The index's order is the feed's order, so nothing sorts the page.
      expect(used).not.toContain('(sort)');
    });

    it('serves the post sweep from its partial index', async () => {
      const used = await indexesUsed(
        `select id from portfolio_posts
          where status in ('draft', 'failed', 'deleted') and updated_at < $1
          order by updated_at
          limit 100`,
        [new Date()],
      );
      expect(used).toContain('portfolio_posts_sweep_idx');
    });

    it("serves an admin's list across every master, newest first, with no sort", async () => {
      const used = await indexesUsed(
        `select id from portfolio_posts order by created_at desc, id desc limit 50`,
        [],
      );
      expect(used).toContain('portfolio_posts_created_idx');
      expect(used).not.toContain('(sort)');
    });

    it("serves an admin's list of one master's posts from the master's index", async () => {
      const { id } = await one<{ id: string }>(
        `select id from masters where display_name = 'Usta 7'`,
      );
      const used = await indexesUsed(
        `select id from portfolio_posts where master_id = $1
          order by created_at desc, id desc limit 50`,
        [id],
      );
      // One master's posts are few, so the planner may bitmap-scan and sort
      // them; what matters is that it never reads other masters' rows.
      expect(used).toContain('portfolio_posts_master_created_idx');
    });

    it('finds removed posts whose photos are still public from the removal index (#362)', async () => {
      const used = await indexesUsed(
        `select id from portfolio_posts
          where removed_at is not null and evidence_moved_at is null and evidence_purged_at is null
            and removed_at >= $1 and removed_at < $2
          order by evidence_attempted_at nulls first, removed_at
          limit 100`,
        [new Date(Date.now() - 30 * 86_400_000), new Date()],
      );
      // Sorted by last attempt after the index finds them: one retention
      // window's removals, a few rows.
      expect(used).toContain('portfolio_posts_removed_idx');
    });

    it('serves the evidence sweep from its partial index', async () => {
      const used = await indexesUsed(
        `select id from portfolio_posts
          where removed_at is not null and evidence_purged_at is null and removed_at < $1
          order by evidence_attempted_at nulls first, removed_at
          limit 100`,
        [new Date()],
      );
      expect(used).toContain('portfolio_posts_removed_idx');
    });

    it('serves the abandoned-upload sweep from its partial index', async () => {
      const used = await indexesUsed(
        `select id from portfolio_media
          where status = 'awaiting_upload' and presign_expires_at < $1
          order by presign_expires_at
          limit 100`,
        [new Date()],
      );
      expect(used).toContain('portfolio_media_awaiting_upload_idx');
    });
  });
});
