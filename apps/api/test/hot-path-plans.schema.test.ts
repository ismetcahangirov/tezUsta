import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppConfig } from '../src/infra/config/app-config.types';
import { parseEnv } from '../src/infra/config/parse-env';
import type { Database } from '../src/infra/database/database.types';
import { runMigrations } from '../src/infra/database/migrate';
import * as schema from '../src/infra/database/schema';
import { runSeed } from '../src/infra/database/seed';
import { GeocodeCacheRepository } from '../src/infra/geo/geocode-cache.repository';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { OtpRepository } from '../src/modules/auth/otp.repository';
import { SessionsRepository } from '../src/modules/auth/sessions.repository';
import { CallsRepository } from '../src/modules/calls/calls.repository';
import { DevicesRepository } from '../src/modules/devices/devices.repository';
import { MasterLocationRepository } from '../src/modules/masters/master-location.repository';
import { MasterVerificationRepository } from '../src/modules/masters/master-verification.repository';
import { MasterOffersRepository } from '../src/modules/masters/offers/master-offers.repository';
import { PushTicketsRepository } from '../src/modules/notifications/push-tickets.repository';
import { ConversationsRepository } from '../src/modules/orders/conversations.repository';
import { MessageAttachmentsRepository } from '../src/modules/orders/message-attachments.repository';
import { OrderOffersRepository } from '../src/modules/orders/order-offers.repository';
import { OrderPhotosRepository } from '../src/modules/orders/order-photos.repository';
import { OrdersRepository } from '../src/modules/orders/orders.repository';
import { ReviewsRepository } from '../src/modules/reviews/reviews.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Issue #289 — every hot-path query, planned at a realistic row count.
 *
 * **Why this file exists next to the plan assertions that were already
 * there.** Those (`ordered-indexes.schema.test.ts`, `order-offers.schema.test.ts`,
 * the `explain` blocks in several e2e suites) run a hand-copied SQL string with
 * `enable_seqscan = off` over a handful of rows. That answers "can this index
 * serve a query shaped like this", which is worth knowing — but it is a claim
 * about a string in a test, not about the statement the repository sends, and
 * it is silent about whether the planner would actually pick the index when
 * it has a choice. The two drift apart the day somebody edits the repository
 * and not the copy.
 *
 * So every probe below:
 *
 * 1. **Runs the repository method itself**, against a Drizzle client whose
 *    `logger` records each statement and its bound parameters exactly as
 *    `pg` receives them. Nothing here restates the SQL; the statement that
 *    is `EXPLAIN`ed is the one the repository built, including the raw
 *    `sql\`\`` fragments and the transactions around them.
 * 2. **Plans it against a seeded database**, set-based (`generate_series`) and
 *    shaped like production rather than like a test: tens of thousands of
 *    orders spread over thousands of customers, a live minority among a
 *    finished majority, a maintenance backlog that is a sliver of its table.
 *    `ANALYZE` runs after seeding so the planner is costing real statistics.
 * 3. **Walks `EXPLAIN (FORMAT JSON)`** instead of matching text, and fails on
 *    any `Seq Scan` over a table that grows, naming the index it expected.
 *
 * Each probe says which of the two claims it makes:
 *
 * - **planner chooses it** — `enable_seqscan` left on, realistic rows,
 *   `ANALYZE`d. The strong claim: this is the plan production gets.
 * - **index can serve it** — `enable_seqscan` turned off. Used only where the
 *   realistic data would make a sequential scan the honest choice, and the
 *   comment on that probe says why.
 *
 * Seeding takes a few seconds; the probes themselves are milliseconds each.
 */

/**
 * Tables that do not grow with usage. A sequential scan over the catalogue is
 * the correct plan — it is a few dozen rows and every catalogue read wants
 * most of them. Every other table is a growing one for this file's purposes.
 */
const STATIC_TABLES: ReadonlySet<string> = new Set(['services', 'service_categories']);

/**
 * Either unique index leading on `orders.id` answers a lookup by id in one
 * probe; which one the planner picks is a coin toss between equals.
 */
const ORDER_BY_ID = ['orders_pkey', 'orders_id_parties_unique'];

const CUSTOMERS = 2_000;
const MASTERS = 1_000;
/** Ten orders per customer — a customer with some history, not a new one. */
const ORDERS = 20_000;
/** Orders `1..ENGAGED` hold a master; `ENGAGED+1..ENGAGED+SEARCHING` are searching. */
const ENGAGED = 300;
const SEARCHING = 300;

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly 'Index Cond'?: string;
  readonly Plans?: readonly PlanNode[];
}

interface CapturedStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

type Claim = 'planner chooses it' | 'index can serve it';

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

function describeNode(node: PlanNode): string {
  const on = node['Relation Name'] === undefined ? '' : ` on ${node['Relation Name']}`;
  const using = node['Index Name'] === undefined ? '' : ` using ${node['Index Name']}`;
  return `${node['Node Type']}${on}${using}`;
}

describe('every hot-path query uses an index at a realistic row count (issue #289)', () => {
  let database: ThrowawayDatabase;
  let pool: Pool;
  let config: AppConfig;
  const captured: CapturedStatement[] = [];

  let orders: OrdersRepository;
  let conversations: ConversationsRepository;
  let masterOffers: MasterOffersRepository;
  let orderOffers: OrderOffersRepository;
  let locations: MasterLocationRepository;
  let devices: DevicesRepository;
  let sessions: SessionsRepository;
  let admins: AdminRepository;
  let otp: OtpRepository;
  let geocodeCache: GeocodeCacheRepository;
  let orderPhotos: OrderPhotosRepository;
  let messagePhotos: MessageAttachmentsRepository;
  let documents: MasterVerificationRepository;
  let calls: CallsRepository;
  let pushTickets: PushTicketsRepository;
  let reviews: ReviewsRepository;

  /** The deterministic ids the seed below mints: `md5('<kind>-<n>')::uuid`. */
  async function idOf(kind: string, n: number): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(`select md5($1)::uuid::text as id`, [
      `${kind}-${String(n)}`,
    ]);
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error(`Could not derive the ${kind} id.`);
    }
    return id;
  }

  /**
   * Runs `work` and returns the one statement it sent that matches `pattern`.
   * Exactly one — a pattern that matches two statements is a probe that does
   * not know which query it is asserting on.
   */
  async function statementOf(
    work: () => Promise<unknown>,
    pattern: RegExp,
  ): Promise<CapturedStatement> {
    captured.length = 0;
    await work();
    const matching = captured.filter((statement) => pattern.test(statement.sql));
    expect(
      matching.map((statement) => statement.sql),
      `statements sent:\n${captured.map((statement) => statement.sql).join('\n---\n')}`,
    ).toHaveLength(1);
    const [statement] = matching;
    if (statement === undefined) {
      throw new Error('Unreachable: the length was just asserted.');
    }
    return statement;
  }

  async function planOf(statement: CapturedStatement, claim: Claim): Promise<PlanNode[]> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      if (claim === 'index can serve it') {
        await client.query('set local enable_seqscan = off');
      }
      const { rows } = await client.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
        `explain (format json) ${statement.sql}`,
        [...statement.params],
      );
      const plan = rows[0]?.['QUERY PLAN'][0].Plan;
      if (plan === undefined) {
        throw new Error('EXPLAIN returned no plan.');
      }
      return flatten(plan);
    } finally {
      await client.query('rollback');
      client.release();
    }
  }

  /**
   * The assertion every probe makes:
   *
   * - **no sequential scan** over a growing table;
   * - **no full index scan** either — an index node with no `Index Cond`
   *   reads the whole index, which is a sequential scan in a different
   *   costume (and exactly what `enable_seqscan = off` produces when no index
   *   actually fits). `fullScansAllowed` names the partial indexes whose whole
   *   content *is* the answer — a sweep's backlog, which the predicate keeps
   *   to a sliver of the table;
   * - **each expected index is in the plan.** An entry that is a list means
   *   "any of these", for a query two indexes serve equally well.
   */
  async function expectIndexed(
    statement: CapturedStatement,
    claim: Claim,
    indexes: readonly (string | readonly string[])[],
    options: { readonly fullScansAllowed?: readonly string[] } = {},
  ): Promise<void> {
    const nodes = await planOf(statement, claim);
    const summary = `${claim}; plan:\n  ${nodes.map(describeNode).join('\n  ')}\nfor:\n${statement.sql}`;

    const seqScans = nodes
      .filter((node) => node['Node Type'] === 'Seq Scan')
      .map((node) => node['Relation Name'] ?? '(unnamed)')
      .filter((relation) => !STATIC_TABLES.has(relation));
    expect(seqScans, summary).toEqual([]);

    const fullIndexScans = nodes
      .filter((node) => node['Index Name'] !== undefined && node['Index Cond'] === undefined)
      .filter((node) => !STATIC_TABLES.has(node['Relation Name'] ?? ''))
      .map((node) => node['Index Name'] ?? '')
      .filter((index) => !(options.fullScansAllowed ?? []).includes(index));
    expect(fullIndexScans, summary).toEqual([]);

    const used = nodes.map((node) => node['Index Name']).filter((name) => name !== undefined);
    for (const expected of indexes) {
      const acceptable = typeof expected === 'string' ? [expected] : expected;
      expect(
        used.some((index) => acceptable.includes(index)),
        `expected one of ${acceptable.join(', ')}; ${summary}`,
      ).toBe(true);
    }
  }

  beforeAll(async () => {
    config = parseEnv(process.env);
    database = await createThrowawayDatabase(config.database.url);
    await runMigrations(database.url);
    await runSeed(database.url);
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);

    await seed(pool);
    await pool.query('analyze');

    const db: Database = drizzle(pool, {
      schema,
      logger: {
        logQuery: (sql: string, params: unknown[]) => {
          captured.push({ sql, params });
        },
      },
    });

    messagePhotos = new MessageAttachmentsRepository(db);
    conversations = new ConversationsRepository(db, messagePhotos);
    orderOffers = new OrderOffersRepository(db);
    orders = new OrdersRepository(db, orderOffers, conversations);
    masterOffers = new MasterOffersRepository(db, orders, conversations);
    locations = new MasterLocationRepository(db, config);
    devices = new DevicesRepository(db);
    sessions = new SessionsRepository(db);
    admins = new AdminRepository(db);
    otp = new OtpRepository(db);
    geocodeCache = new GeocodeCacheRepository(db);
    orderPhotos = new OrderPhotosRepository(db);
    documents = new MasterVerificationRepository(db);
    calls = new CallsRepository(db);
    pushTickets = new PushTicketsRepository(db);
    reviews = new ReviewsRepository(db);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  describe('per request on a frequently called endpoint', () => {
    it("the customer's order list — OrdersRepository.listForCustomer", async () => {
      const customerId = await idOf('customer', 7);
      // planner chooses it: ten orders out of twenty thousand. Either
      // customer-leading index is a correct answer — for ten rows the planner
      // may well read `(customer_id, status)` and sort them, which costs
      // nothing. That the ordered index can serve the page with no sort at all
      // is `ordered-indexes.schema.test.ts`'s claim, not this one.
      const byCustomer = ['orders_customer_created_idx', 'orders_customer_status_idx'];
      await expectIndexed(
        await statementOf(
          () => orders.listForCustomer({ customerId, limit: 20, after: null }),
          /from "orders"/,
        ),
        'planner chooses it',
        [byCustomer],
      );

      // The second page, through the keyset row comparison.
      const after = { createdAt: new Date(), id: await idOf('order', 7) };
      await expectIndexed(
        await statementOf(
          () => orders.listForCustomer({ customerId, limit: 20, after }),
          /from "orders"/,
        ),
        'planner chooses it',
        [byCustomer],
      );
    });

    it("the unread badges on the customer's order list — OrdersRepository.countUnreadMessagesForCustomer", async () => {
      const orderIds = await Promise.all([1, 2, 3, 3_001, 6_001].map((n) => idOf('order', n)));
      // planner chooses it: a page of order ids against ~20k conversations and
      // ~40k messages, of which a few hundred are unread.
      await expectIndexed(
        await statementOf(
          () => orders.countUnreadMessagesForCustomer(orderIds),
          /from "conversations"/,
        ),
        'planner chooses it',
        ['conversations_one_open_per_order', 'messages_unread_idx'],
      );
    });

    it('one order, for its customer — OrdersRepository.findByIdForCustomer', async () => {
      const id = await idOf('order', 1);
      const customerId = await idOf('customer', 1);
      // planner chooses it: a primary-key probe, and the master joined by its own.
      await expectIndexed(
        await statementOf(() => orders.findByIdForCustomer(id, customerId), /from "orders"/),
        'planner chooses it',
        [ORDER_BY_ID, 'masters_pkey'],
      );
    });

    it('one order, unscoped (the photo path) — OrdersRepository.findById', async () => {
      const id = await idOf('order', 11);
      // planner chooses it.
      await expectIndexed(
        await statementOf(() => orders.findById(id), /from "orders"/),
        'planner chooses it',
        [ORDER_BY_ID],
      );
    });

    it('the open-order count at creation (#273) — inside OrdersRepository.createSearching', async () => {
      // `maxOpenOrders: 0` stops the transaction right after the count, so
      // the probe writes nothing — it only needs the statements sent.
      const fields = {
        customerId: await idOf('customer', 5),
        addressId: await idOf('address', 5),
        serviceId: await firstServiceId(),
        description: 'Kran sızır.',
        idempotencyKey: 'hot-path-probe',
        maxOpenOrders: 0,
      };
      const count = await statementOf(() => orders.createSearching(fields), /count\(\*\)/);
      // planner chooses it: an index-only count over one customer's rows.
      await expectIndexed(count, 'planner chooses it', ['orders_customer_status_idx']);

      // The idempotency lookup that runs before it, in the same transaction.
      const lookup = await statementOf(
        () => orders.createSearching(fields),
        /"idempotency_key" = \$2/,
      );
      await expectIndexed(lookup, 'planner chooses it', ['orders_customer_idempotency_key_unique']);
    });

    it("the master's live offer feed — MasterOffersRepository.listLiveForMaster", async () => {
      const masterId = await idOf('master', 42);
      // planner chooses it: one master's handful of live offers out of ~60k.
      await expectIndexed(
        await statementOf(
          () => masterOffers.listLiveForMaster(masterId, 20),
          /from "order_offers"/,
        ),
        'planner chooses it',
        ['order_offers_master_status_created_idx'],
      );
    });

    it("the master's current job — MasterOffersRepository.findEngagedJob", async () => {
      const masterId = await idOf('master', 42);
      // planner chooses it.
      await expectIndexed(
        await statementOf(() => masterOffers.findEngagedJob(masterId), /from "orders"/),
        'planner chooses it',
        ['orders_one_active_per_master', 'order_offers_order_master_unique'],
      );
    });

    it("one conversation's messages — ConversationsRepository.listMessages", async () => {
      const conversationId = await idOf('conversation', 1);
      // planner chooses it: two messages out of ~40k, first page and next.
      await expectIndexed(
        await statementOf(
          () => conversations.listMessages({ conversationId, limit: 30, afterMessageId: null }),
          /from "messages"/,
        ),
        'planner chooses it',
        ['messages_conversation_created_idx'],
      );
      const afterMessageId = await idOf('message', 1_002);
      await expectIndexed(
        await statementOf(
          () => conversations.listMessages({ conversationId, limit: 30, afterMessageId }),
          /from "messages"/,
        ),
        'planner chooses it',
        ['messages_conversation_created_idx'],
      );
    });

    it("a conversation's unread count — ConversationsRepository.countUnreadFor", async () => {
      const conversationId = await idOf('conversation', 1);
      // planner chooses it: the partial index holds only unread rows.
      await expectIndexed(
        await statementOf(
          () => conversations.countUnreadFor(conversationId, 'customer'),
          /from "messages"/,
        ),
        'planner chooses it',
        ['messages_unread_idx'],
      );
    });

    it("an order's open conversation — ConversationsRepository.findOpenByOrderId", async () => {
      const orderId = await idOf('order', 1);
      // planner chooses it.
      await expectIndexed(
        await statementOf(() => conversations.findOpenByOrderId(orderId), /from "conversations"/),
        'planner chooses it',
        ['conversations_one_open_per_order'],
      );
    });
  });

  describe('per socket event or position report', () => {
    it('which order a reporting master is on — OrdersRepository.findEngagedOrderIdForMaster', async () => {
      const masterId = await idOf('master', 42);
      // planner chooses it.
      await expectIndexed(
        await statementOf(() => orders.findEngagedOrderIdForMaster(masterId), /from "orders"/),
        'planner chooses it',
        ['orders_one_active_per_master'],
      );
    });

    it('the same question from the location path — MasterLocationRepository.findEngagedOrderId', async () => {
      const masterId = await idOf('master', 42);
      // planner chooses it.
      await expectIndexed(
        await statementOf(() => locations.findEngagedOrderId(masterId), /from "orders"/),
        'planner chooses it',
        ['orders_one_active_per_master'],
      );
    });

    it("the master's latest position and the trail prune (#274) — MasterLocationRepository.record", async () => {
      const masterId = await idOf('master', 42);
      const record = (): Promise<unknown> =>
        locations.record({ masterId, latitude: 40.4093, longitude: 49.8671 });

      // planner chooses it: twenty rows for this master out of ~20k.
      await expectIndexed(
        await statementOf(record, /order by ml\.recorded_at desc/),
        'planner chooses it',
        ['master_locations_master_recent_idx'],
      );
      await expectIndexed(
        await statementOf(record, /delete from "master_locations"/),
        'planner chooses it',
        ['master_locations_master_recent_idx'],
      );
    });

    it("a user's devices for push fan-out — DevicesRepository.listAddressableByUser", async () => {
      const userId = await idOf('user', 9);
      // planner chooses it.
      await expectIndexed(
        await statementOf(() => devices.listAddressableByUser(userId), /from "devices"/),
        'planner chooses it',
        ['devices_user_id_live_idx'],
      );
    });
  });

  describe('per dispatch round', () => {
    it("an order's dispatch state and search start — OrdersRepository.findDispatchState", async () => {
      const orderId = await idOf('order', ENGAGED + 1);
      // planner chooses it: a primary-key probe with a correlated read of the
      // order's status history, which is ~40k rows.
      await expectIndexed(
        await statementOf(() => orders.findDispatchState(orderId), /from orders o/),
        'planner chooses it',
        [ORDER_BY_ID, 'order_status_history_order_idx'],
      );
    });

    it("closing an order's live offers — OrderOffersRepository.expireLiveOffers", async () => {
      const orderId = await idOf('order', ENGAGED + 2);
      // planner chooses it.
      await expectIndexed(
        await statementOf(() => orderOffers.expireLiveOffers(orderId), /update order_offers/),
        'planner chooses it',
        ['order_offers_order_master_unique'],
      );
    });
  });

  describe('per sweep tick', () => {
    it('dispatch reconciler — OrdersRepository.listStaleSearching', async () => {
      const cutoff = new Date(Date.now() - 10 * 60_000);
      // planner chooses it: a few hundred SEARCHING orders among twenty thousand.
      await expectIndexed(
        await statementOf(() => orders.listStaleSearching({ cutoff, limit: 100 }), /from orders o/),
        'planner chooses it',
        ['orders_status_created_idx'],
      );
    });

    it('auth retention, refresh tokens — SessionsRepository.deleteExpiredRefreshTokens', async () => {
      const { authRetentionDays, authIncidentRetentionDays, batchSize } = config.maintenance;
      const now = Date.now();
      // index can serve it — one of the two places this file settles for that.
      // The candidate tokens come off `refresh_tokens_expires_at_idx` with
      // the planner on (it is in the plan either way); what it will not do at
      // twelve thousand sessions is look each candidate's session up by key,
      // because hashing a 150-page table once is cheaper than a hundred
      // random probes. That stops being true as the table grows, and seeding
      // it to the size where it does would cost this file most of its
      // runtime. What is asserted is that the keyed path exists — no scan of
      // either table, whole-index or otherwise, is the only plan left.
      await expectIndexed(
        await statementOf(
          () =>
            sessions.deleteExpiredRefreshTokens({
              cutoff: new Date(now - authRetentionDays * 86_400_000),
              incidentCutoff: new Date(now - authIncidentRetentionDays * 86_400_000),
              limit: batchSize,
            }),
          /delete from "refresh_tokens"/,
        ),
        'index can serve it',
        ['refresh_tokens_expires_at_idx', 'sessions_pkey'],
      );
    });

    it('auth retention, sessions — SessionsRepository.deleteRetiredSessions', async () => {
      const { authRetentionDays, authIncidentRetentionDays, batchSize } = config.maintenance;
      const now = Date.now();
      // planner chooses it.
      await expectIndexed(
        await statementOf(
          () =>
            sessions.deleteRetiredSessions({
              cutoff: new Date(now - authRetentionDays * 86_400_000),
              incidentCutoff: new Date(now - authIncidentRetentionDays * 86_400_000),
              limit: batchSize,
            }),
          /delete from "sessions"/,
        ),
        'planner chooses it',
        ['sessions_expires_at_idx', 'sessions_revoked_at_idx', 'refresh_tokens_session_id_idx'],
      );
    });

    it('admin session retention, refresh tokens — AdminRepository.deleteExpiredRefreshTokens', async () => {
      const cutoff = new Date(Date.now() - config.maintenance.authRetentionDays * 86_400_000);
      // index can serve it — the same trade as the consumer refresh-token
      // sweep above: nine thousand token rows are cheaper to hash than to
      // probe a handful of times, and the claim that matters is that the
      // probe exists for when they are not.
      await expectIndexed(
        await statementOf(
          () => admins.deleteExpiredRefreshTokens(cutoff, config.maintenance.batchSize),
          /delete from "admin_refresh_tokens"/,
        ),
        'index can serve it',
        [
          'admin_sessions_expires_at_idx',
          'admin_sessions_revoked_at_idx',
          'admin_refresh_tokens_session_idx',
        ],
      );
    });

    it('admin session retention, sessions — AdminRepository.deleteRetiredSessions', async () => {
      const cutoff = new Date(Date.now() - config.maintenance.authRetentionDays * 86_400_000);
      // planner chooses it.
      await expectIndexed(
        await statementOf(
          () => admins.deleteRetiredSessions(cutoff, config.maintenance.batchSize),
          /delete from "admin_sessions"/,
        ),
        'planner chooses it',
        [
          'admin_sessions_expires_at_idx',
          'admin_sessions_revoked_at_idx',
          'admin_refresh_tokens_session_idx',
        ],
      );
    });

    it('OTP retention — OtpRepository.deleteExpired', async () => {
      const cutoff = new Date(Date.now() - config.maintenance.otpRetentionHours * 3_600_000);
      // planner chooses it.
      await expectIndexed(
        await statementOf(
          () => otp.deleteExpired(cutoff, config.maintenance.batchSize),
          /delete from "otp_challenges"/,
        ),
        'planner chooses it',
        ['otp_challenges_expires_at_idx'],
      );
    });

    it('geocode cache expiry — GeocodeCacheRepository.deleteExpired', async () => {
      // planner chooses it.
      await expectIndexed(
        await statementOf(
          () => geocodeCache.deleteExpired(config.maintenance.batchSize),
          /delete from "geocode_cache"/,
        ),
        'planner chooses it',
        ['geocode_cache_expires_at_idx'],
      );
    });

    it('abandoned order photos — OrderPhotosRepository.listAbandoned', async () => {
      const cutoff = new Date(
        Date.now() - config.maintenance.orderPhotoAbandonedAfterHours * 3_600_000,
      );
      // planner chooses it.
      await expectIndexed(
        await statementOf(
          () => orderPhotos.listAbandoned(cutoff, config.maintenance.batchSize),
          /from "order_photos"/,
        ),
        'planner chooses it',
        ['order_photos_abandoned_idx'],
      );
    });

    it('unsent message photos — MessageAttachmentsRepository.listUnsent', async () => {
      const cutoff = new Date(
        Date.now() - config.maintenance.orderPhotoAbandonedAfterHours * 3_600_000,
      );
      // planner chooses it.
      await expectIndexed(
        await statementOf(
          () => messagePhotos.listUnsent(cutoff, config.maintenance.batchSize),
          /from "message_attachments"/,
        ),
        'planner chooses it',
        ['message_attachments_unsent_created_idx'],
      );
    });

    it('abandoned verification uploads — MasterVerificationRepository.listAbandonedUploads', async () => {
      const cutoff = new Date(
        Date.now() - config.maintenance.masterDocumentAbandonedAfterHours * 3_600_000,
      );
      // planner chooses it.
      await expectIndexed(
        await statementOf(
          () => documents.listAbandonedUploads(cutoff, config.maintenance.batchSize),
          /from "master_documents"/,
        ),
        'planner chooses it',
        ['master_documents_abandoned_idx', 'master_documents_master_activity_idx'],
      );
    });

    it('expired position trails — MasterLocationRepository.sweepExpiredTrails', async () => {
      // planner chooses it.
      await expectIndexed(
        await statementOf(
          () => locations.sweepExpiredTrails(config.maintenance.batchSize),
          /delete from master_locations/,
        ),
        'planner chooses it',
        ['master_locations_retention_idx'],
      );
    });

    it('overdue ringing calls — CallsRepository.listRingingBefore', async () => {
      // planner chooses it.
      await expectIndexed(
        await statementOf(
          () => calls.listRingingBefore(new Date(Date.now() - 60_000), 100),
          /from "calls"/,
        ),
        'planner chooses it',
        ['calls_ringing_started_idx'],
      );
    });

    it('answered calls whose room is gone — CallsRepository.listAnsweredBefore', async () => {
      // planner chooses it.
      await expectIndexed(
        await statementOf(
          () => calls.listAnsweredBefore(new Date(Date.now() - 60_000), 100, ['call-x']),
          /from "calls"/,
        ),
        'planner chooses it',
        ['calls_accepted_answered_idx'],
      );
    });

    it('push receipts due for checking — PushTicketsRepository.findDue', async () => {
      const readyBefore = new Date(Date.now() - config.notifications.receiptMinAgeSeconds * 1_000);
      // planner chooses it.
      await expectIndexed(
        await statementOf(
          () => pushTickets.findDue(readyBefore, config.notifications.receiptMaxPerRun),
          /from "push_tickets"/,
        ),
        'planner chooses it',
        ['push_tickets_created_at_idx'],
      );
    });

    it('push receipts past retention — PushTicketsRepository.deleteOlderThan', async () => {
      const cutoff = new Date(Date.now() - config.notifications.receiptRetentionHours * 3_600_000);
      // planner chooses it.
      await expectIndexed(
        await statementOf(() => pushTickets.deleteOlderThan(cutoff), /delete from "push_tickets"/),
        'planner chooses it',
        ['push_tickets_created_at_idx'],
      );
    });

    it('sealed reviews past their window — ReviewsRepository.listOrdersPastWindow', async () => {
      // planner chooses it.
      await expectIndexed(
        await statementOf(
          () =>
            reviews.listOrdersPastWindow(config.reviews.windowHours, config.maintenance.batchSize),
          /from "reviews"/,
        ),
        'planner chooses it',
        ['reviews_sealed_order_idx', 'order_status_history_order_idx'],
        // The partial index holds sealed reviews only — the sweep's whole
        // backlog, a sliver of the table — so reading all of it is the query.
        { fullScansAllowed: ['reviews_sealed_order_idx'] },
      );
    });
  });

  async function firstServiceId(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `select id from services where is_active order by id limit 1`,
    );
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error('The seed should provide an active service.');
    }
    return id;
  }
});

/**
 * The production-shaped seed, set-based throughout so it costs seconds.
 *
 * Ids are `md5('<kind>-<n>')::uuid`, which is what lets one table refer to
 * another's rows without a join: order `n` belongs to customer
 * `((n - 1) % CUSTOMERS) + 1`, and so on. The proportions are the point, not
 * the absolute sizes: a live minority (searching orders, unread messages,
 * awaiting uploads, ringing calls) against a finished majority, and a
 * maintenance backlog that is a sliver of the table it lives in — which is
 * what a sweep running on schedule leaves behind.
 */
async function seed(pool: Pool): Promise<void> {
  const statements = [
    // People.
    `insert into users (id, phone_e164)
     select md5('user-' || g)::uuid, '+99450' || lpad(g::text, 7, '0')
       from generate_series(1, ${String(CUSTOMERS + MASTERS)}) g`,
    `insert into customers (id, user_id, display_name)
     select md5('customer-' || g)::uuid, md5('user-' || g)::uuid, 'Aygün'
       from generate_series(1, ${String(CUSTOMERS)}) g`,
    `insert into masters (id, user_id, display_name, verification_status, is_available)
     select md5('master-' || g)::uuid, md5('user-' || (${String(CUSTOMERS)} + g))::uuid, 'Rəşad',
            'active', true
       from generate_series(1, ${String(MASTERS)}) g`,
    `insert into addresses (id, customer_id, formatted_address, position, is_default)
     select md5('address-' || g)::uuid, md5('customer-' || g)::uuid, 'Bakı, Nizami küçəsi 1',
            ST_SetSRID(ST_MakePoint(49.80 + (g % 100) * 0.002, 40.35 + (g / 100) * 0.002), 4326),
            true
       from generate_series(1, ${String(CUSTOMERS)}) g`,
    `insert into master_services (master_id, service_id, price_minor)
     select md5('master-' || g)::uuid, s.id, 5000
       from generate_series(1, ${String(MASTERS)}) g
       cross join services s
      where s.is_active`,

    // Orders: 1..ENGAGED hold a master, the next SEARCHING are searching, the
    // rest are finished. Newest first by n, so the live ones are the recent ones.
    `insert into orders (id, customer_id, address_id, service_id, master_id, status, description,
                         price_minor, idempotency_key, accepted_at, created_at, updated_at)
     select md5('order-' || g)::uuid,
            md5('customer-' || ((g - 1) % ${String(CUSTOMERS)} + 1))::uuid,
            md5('address-' || ((g - 1) % ${String(CUSTOMERS)} + 1))::uuid,
            svc.ids[1 + g % array_length(svc.ids, 1)],
            case when g between ${String(ENGAGED + 1)} and ${String(ENGAGED + SEARCHING)} then null
                 else md5('master-' || ((g - 1) % ${String(MASTERS)} + 1))::uuid end,
            (case when g <= ${String(ENGAGED)} then 'ACCEPTED'
                  when g <= ${String(ENGAGED + SEARCHING)} then 'SEARCHING'
                  else 'COMPLETED' end)::order_status,
            'Kran sızır.',
            case when g between ${String(ENGAGED + 1)} and ${String(ENGAGED + SEARCHING)} then null
                 else 5000 end,
            'key-' || g,
            case when g between ${String(ENGAGED + 1)} and ${String(ENGAGED + SEARCHING)} then null
                 else now() - g * interval '10 minutes' + interval '1 minute' end,
            now() - g * interval '10 minutes',
            now() - g * interval '10 minutes'
       from generate_series(1, ${String(ORDERS)}) g
       cross join (select array_agg(id order by id) as ids from services where is_active) svc`,
    `insert into order_status_history (id, order_id, from_status, to_status, actor_kind, created_at)
     select md5('history-' || g || '-1')::uuid, md5('order-' || g)::uuid, 'DRAFT', 'SEARCHING',
            'system', now() - g * interval '10 minutes'
       from generate_series(1, ${String(ORDERS)}) g`,
    `insert into order_status_history (id, order_id, from_status, to_status, actor_kind, created_at)
     select md5('history-' || g || '-2')::uuid, md5('order-' || g)::uuid, 'SEARCHING',
            (case when g <= ${String(ENGAGED)} then 'ACCEPTED' else 'COMPLETED' end)::order_status,
            'system', now() - g * interval '10 minutes' + interval '1 minute'
       from generate_series(1, ${String(ORDERS)}) g
      where g not between ${String(ENGAGED + 1)} and ${String(ENGAGED + SEARCHING)}`,

    // Offers: the winning one for every order with a master, and two more per
    // order — live on a searching order, lost on every other.
    `insert into order_offers (id, order_id, master_id, round, radius_m, distance_m, status,
                               expires_at, responded_at, created_at)
     select md5('offer-' || g || '-0')::uuid, md5('order-' || g)::uuid,
            md5('master-' || ((g - 1) % ${String(MASTERS)} + 1))::uuid, 1, 3000, 900, 'accepted',
            now() - g * interval '10 minutes' + interval '5 minutes',
            now() - g * interval '10 minutes' + interval '1 minute',
            now() - g * interval '10 minutes'
       from generate_series(1, ${String(ORDERS)}) g
      where g not between ${String(ENGAGED + 1)} and ${String(ENGAGED + SEARCHING)}`,
    `insert into order_offers (id, order_id, master_id, round, radius_m, distance_m, status,
                               expires_at, responded_at, created_at)
     select md5('offer-' || g || '-' || k)::uuid, md5('order-' || g)::uuid,
            md5('master-' || ((g - 1 + k * 337) % ${String(MASTERS)} + 1))::uuid, 1, 3000, 1200,
            (case when searching then 'offered' else 'lost' end)::order_offer_status,
            case when searching then now() + interval '5 minutes'
                 else now() - g * interval '10 minutes' + interval '5 minutes' end,
            case when searching then null
                 else now() - g * interval '10 minutes' + interval '1 minute' end,
            now() - g * interval '10 minutes'
       from generate_series(1, ${String(ORDERS)}) g
       cross join generate_series(1, 2) k
       cross join lateral (select g between ${String(ENGAGED + 1)} and ${String(ENGAGED + SEARCHING)}
                                  as searching) s`,

    // Conversations for every order that had a master; open only while engaged.
    `insert into conversations (id, order_id, master_id, closed_at, created_at)
     select md5('conversation-' || g)::uuid, md5('order-' || g)::uuid,
            md5('master-' || ((g - 1) % ${String(MASTERS)} + 1))::uuid,
            case when g <= ${String(ENGAGED)} then null
                 else now() - g * interval '10 minutes' + interval '1 hour' end,
            now() - g * interval '10 minutes' + interval '1 minute'
       from generate_series(1, ${String(ORDERS)}) g
      where g not between ${String(ENGAGED + 1)} and ${String(ENGAGED + SEARCHING)}`,
    // Two messages each; the last of an engaged order's is still unread.
    `insert into messages (id, conversation_id, sender_kind, body, read_at, created_at)
     select md5('message-' || (g * 1000 + j))::uuid, md5('conversation-' || g)::uuid,
            (case when j % 2 = 0 then 'customer' else 'master' end)::message_sender_kind,
            'Salam',
            case when g <= ${String(ENGAGED)} and j = 2 then null
                 else now() - g * interval '10 minutes' + j * interval '2 minutes' end,
            now() - g * interval '10 minutes' + j * interval '1 minute'
       from generate_series(1, ${String(ORDERS)}) g
       cross join generate_series(1, 2) j
      where g not between ${String(ENGAGED + 1)} and ${String(ENGAGED + SEARCHING)}`,

    // Positions: every master reporting inside the trail window, and a small
    // expired remainder for the ones who stopped.
    `insert into master_locations (id, master_id, position, recorded_at)
     select md5('location-' || m || '-' || k)::uuid, md5('master-' || m)::uuid,
            ST_SetSRID(ST_MakePoint(49.80 + (m % 100) * 0.002, 40.35 + (m / 100) * 0.002), 4326),
            now() - k * interval '90 seconds'
       from generate_series(1, ${String(MASTERS)}) m
       cross join generate_series(1, 20) k`,
    `insert into master_locations (id, master_id, position, recorded_at)
     select md5('stale-location-' || m || '-' || k)::uuid, md5('master-' || m)::uuid,
            ST_SetSRID(ST_MakePoint(49.85, 40.40), 4326),
            now() - interval '3 hours' - k * interval '1 minute'
       from generate_series(1, 50) m
       cross join generate_series(1, 5) k`,

    // Devices: two per user, one of them unregistered.
    `insert into devices (id, user_id, platform, expo_push_token, revoked_at, revoked_reason)
     select md5('device-' || u || '-' || k)::uuid, md5('user-' || u)::uuid, 'android',
            'ExponentPushToken[' || u || '-' || k || ']',
            case when k = 2 then now() - interval '1 day' end,
            (case when k = 2 then 'unregistered' end)::device_revoked_reason
       from generate_series(1, ${String(CUSTOMERS + MASTERS)}) u
       cross join generate_series(1, 2) k`,

    // Consumer sessions: three per user, live, plus a sliver past retention.
    `insert into sessions (id, user_id, expires_at, revoked_at, revoked_reason)
     select md5('session-' || u || '-' || k)::uuid, md5('user-' || u)::uuid,
            case when u <= 40 and k = 1 then now() - interval '400 days'
                 else now() + (u % 30) * interval '1 day' end,
            case when k = 3 then now() - (u % 20) * interval '1 day' end,
            (case when k = 3 then 'logout' end)::session_revoked_reason
       from generate_series(1, ${String(CUSTOMERS + MASTERS)}) u
       cross join generate_series(1, 3) k`,
    `insert into refresh_tokens (id, session_id, token_hash, expires_at, used_at)
     select md5('refresh-' || u || '-' || k || '-' || t)::uuid,
            md5('session-' || u || '-' || k)::uuid, md5('refresh-' || u || '-' || k || '-' || t),
            case when u <= 40 and k = 1 then now() - interval '400 days'
                 else now() + (u % 30) * interval '1 day' end,
            case when t < 3 then now() - interval '1 day' end
       from generate_series(1, ${String(CUSTOMERS + MASTERS)}) u
       cross join generate_series(1, 3) k
       cross join generate_series(1, 3) t`,

    // Admins: twenty people, a month of sessions each, and a sliver past retention.
    `insert into admin_users (id, email, display_name)
     select md5('admin-' || g)::uuid, 'admin' || g || '@tezusta.az', 'Admin'
       from generate_series(1, 20) g`,
    `insert into admin_sessions (id, admin_user_id, created_at, last_used_at, expires_at, revoked_at)
     select md5('admin-session-' || g)::uuid, md5('admin-' || (g % 20 + 1))::uuid,
            now() - g * interval '15 minutes', now() - g * interval '15 minutes',
            now() - g * interval '15 minutes' + interval '12 hours',
            case when g % 3 = 0 then now() - g * interval '15 minutes' + interval '1 hour' end
       from generate_series(1, 3000) g`,
    `insert into admin_sessions (id, admin_user_id, created_at, last_used_at, expires_at)
     select md5('old-admin-session-' || g)::uuid, md5('admin-' || (g % 20 + 1))::uuid,
            now() - interval '400 days', now() - interval '400 days', now() - interval '399 days'
       from generate_series(1, 20) g`,
    `insert into admin_refresh_tokens (id, session_id, token_hash, rotated_at)
     select md5('admin-refresh-' || g || '-' || t)::uuid, md5('admin-session-' || g)::uuid,
            md5('admin-refresh-' || g || '-' || t) || md5('admin-refresh-' || g || '-' || t),
            case when t < 3 then now() end
       from generate_series(1, 3000) g
       cross join generate_series(1, 3) t`,
    `insert into admin_refresh_tokens (id, session_id, token_hash)
     select md5('old-admin-refresh-' || g)::uuid, md5('old-admin-session-' || g)::uuid,
            md5('old-admin-refresh-' || g) || md5('old-admin-refresh-' || g)
       from generate_series(1, 20) g`,

    // OTP challenges: a day's worth, spent, and a sliver past retention.
    `insert into otp_challenges (id, phone_e164, code_hash, created_at, expires_at, consumed_at)
     select md5('otp-' || g)::uuid, '+99455' || lpad(g::text, 7, '0'), md5('otp-' || g),
            now() - g * interval '8 seconds',
            now() - g * interval '8 seconds' + interval '5 minutes',
            now() - g * interval '8 seconds' + interval '1 minute'
       from generate_series(1, 10000) g`,
    `insert into otp_challenges (id, phone_e164, code_hash, created_at, expires_at, consumed_at)
     select md5('old-otp-' || g)::uuid, '+99456' || lpad(g::text, 7, '0'), md5('old-otp-' || g),
            now() - interval '30 days', now() - interval '30 days', now() - interval '30 days'
       from generate_series(1, 50) g`,

    // Geocode cache: live rows, and a few whose licence has run out.
    `insert into geocode_cache (normalised_address, latitude, longitude, expires_at, updated_at)
     select 'address ' || g, 40.40, 49.86,
            case when g <= 50 then now() - interval '1 day' else now() + (g % 29) * interval '1 day' end,
            case when g <= 50 then now() - interval '2 days' else now() end
       from generate_series(1, 10000) g`,

    // Order photos: attached to finished orders, and a few abandoned.
    `insert into order_photos (id, customer_id, order_id, storage_key, declared_content_type,
                               verified_content_type, size_bytes, status, presign_expires_at,
                               submitted_at, attached_at)
     select md5('photo-' || g)::uuid, md5('customer-' || ((g - 1) % ${String(CUSTOMERS)} + 1))::uuid,
            md5('order-' || g)::uuid, 'orders/photo-' || g, 'image/jpeg', 'image/jpeg', 1000,
            'attached', now() - g * interval '10 minutes',
            now() - g * interval '10 minutes', now() - g * interval '10 minutes'
       from generate_series(${String(ENGAGED + SEARCHING + 1)}, 10600) g`,
    `insert into order_photos (id, customer_id, storage_key, declared_content_type,
                               verified_content_type, size_bytes, status, presign_expires_at,
                               submitted_at)
     select md5('abandoned-photo-' || g)::uuid, md5('customer-' || g)::uuid,
            'orders/abandoned-' || g, 'image/jpeg', 'image/jpeg', 1000, 'confirmed',
            now() - interval '10 days', now() - interval '10 days'
       from generate_series(1, 50) g`,

    // Message photos: sent on messages of finished orders, and a few never sent.
    `insert into message_attachments (id, conversation_id, uploader_kind, message_id, storage_key,
                                      declared_content_type, verified_content_type, size_bytes,
                                      status, presign_expires_at, submitted_at, attached_at,
                                      created_at)
     select md5('attachment-' || g)::uuid, md5('conversation-' || g)::uuid, 'master',
            md5('message-' || (g * 1000 + 1))::uuid, 'messages/photo-' || g, 'image/jpeg',
            'image/jpeg', 1000, 'attached', now() - g * interval '10 minutes',
            now() - g * interval '10 minutes', now() - g * interval '10 minutes',
            now() - g * interval '10 minutes'
       from generate_series(${String(ENGAGED + SEARCHING + 1)}, 10600) g`,
    `insert into message_attachments (id, conversation_id, uploader_kind, storage_key,
                                      declared_content_type, verified_content_type, size_bytes,
                                      status, presign_expires_at, submitted_at, created_at)
     select md5('unsent-attachment-' || g)::uuid, md5('conversation-' || g)::uuid, 'customer',
            'messages/unsent-' || g, 'image/jpeg', 'image/jpeg', 1000, 'confirmed',
            now() - interval '10 days', now() - interval '10 days', now() - interval '10 days'
       from generate_series(1, 50) g`,

    // Verification documents: three reviewed per master, and a few presigns
    // nobody confirmed.
    `insert into master_documents (id, master_id, document_type, storage_key, declared_content_type,
                                   verified_content_type, size_bytes, status, presign_expires_at,
                                   submitted_at, reviewed_by_admin_id, reviewed_at, created_at,
                                   updated_at)
     select md5('document-' || m || '-' || t)::uuid, md5('master-' || m)::uuid,
            t::master_document_type, 'documents/' || m || '-' || t, 'image/jpeg', 'image/jpeg',
            1000, 'accepted', now() - interval '60 days', now() - interval '60 days',
            md5('admin-1')::uuid, now() - interval '59 days', now() - interval '60 days',
            now() - interval '59 days'
       from generate_series(1, ${String(MASTERS)}) m
       cross join unnest(array['id_card_front', 'id_card_back', 'selfie_with_id']) t`,
    `insert into master_documents (id, master_id, document_type, storage_key, declared_content_type,
                                   status, presign_expires_at, created_at, updated_at)
     select md5('awaiting-document-' || m)::uuid, md5('master-' || m)::uuid, 'id_card_front',
            'documents/awaiting-' || m, 'image/jpeg', 'awaiting_upload',
            now() - interval '10 days', now() - interval '10 days', now() - interval '10 days'
       from generate_series(${String(MASTERS - 20)}, ${String(MASTERS)}) m`,

    // Calls: finished ones on finished orders; a few live.
    `insert into calls (id, order_id, caller_kind, caller_id, caller_user_id, callee_kind, callee_id,
                        callee_user_id, status, room_name, started_at, answered_at, ended_at,
                        end_reason)
     select md5('call-' || g)::uuid, md5('order-' || g)::uuid,
            'customer', md5('customer-' || c)::uuid, md5('user-' || c)::uuid,
            'master', md5('master-' || m)::uuid, md5('user-' || (${String(CUSTOMERS)} + m))::uuid,
            (case when g <= 20 then 'ACCEPTED' when g <= 40 then 'RINGING' else 'ENDED' end)::call_status,
            'call-' || md5('call-' || g)::uuid,
            now() - g * interval '10 minutes',
            case when g <= 20 or g > 40 then now() - g * interval '10 minutes' + interval '10 seconds' end,
            case when g > 40 then now() - g * interval '10 minutes' + interval '5 minutes' end,
            (case when g > 40 then 'hangup' end)::call_end_reason
       from generate_series(1, 10000) g
       cross join lateral (select (g - 1) % ${String(CUSTOMERS)} + 1 as c,
                                  (g - 1) % ${String(MASTERS)} + 1 as m) p
      where g not between ${String(ENGAGED + 1)} and ${String(ENGAGED + SEARCHING)}`,

    // Push tickets: the half hour of receipts the worklist holds.
    `insert into push_tickets (id, device_id, receipt_id, created_at)
     select md5('ticket-' || g)::uuid,
            md5('device-' || ((g - 1) % ${String(CUSTOMERS + MASTERS)} + 1) || '-1')::uuid,
            'receipt-' || g, now() - g * interval '180 milliseconds'
       from generate_series(1, 10000) g`,

    // Reviews: revealed on finished orders, and a few still sealed.
    `insert into reviews (id, order_id, customer_id, master_id, author_role, rating, revealed_at,
                          created_at)
     select md5('review-' || g)::uuid, md5('order-' || g)::uuid,
            md5('customer-' || ((g - 1) % ${String(CUSTOMERS)} + 1))::uuid,
            md5('master-' || ((g - 1) % ${String(MASTERS)} + 1))::uuid,
            'customer', 5,
            case when g > 650 then now() - g * interval '10 minutes' + interval '1 day' end,
            now() - g * interval '10 minutes' + interval '2 hours'
       from generate_series(${String(ENGAGED + SEARCHING + 1)}, 20000) g`,
  ];

  // One transaction, with foreign-key triggers off for its duration. The
  // per-row FK checks were half the seeding time, and they have nothing to
  // prove here: every reference above is built from the same `md5` formula as
  // the row it names. `replica` needs a superuser, which the throwaway
  // database's owner is — locally and in CI alike. The constraints themselves
  // are proved by the schema tests that own them.
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
