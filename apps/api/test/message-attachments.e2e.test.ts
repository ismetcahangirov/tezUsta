import { randomUUID } from 'node:crypto';

import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type {
  ConfirmedMessageAttachment,
  CursorPage,
  Message,
  MessageAttachmentUpload,
} from '@tezusta/types';
import { Worker } from 'bullmq';
import type { Queue } from 'bullmq';
import { Pool } from 'pg';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { MediaPipelineService } from '../src/infra/media/media-pipeline.service';
import { MasterPresenceService } from '../src/infra/presence/master-presence.service';
import { DeferredJobHandlerRegistry } from '../src/infra/queue/deferred-job-handler.registry';
import { MEDIA_QUEUE } from '../src/infra/queue/queue.constants';
import type { DeferredJobPayload } from '../src/infra/queue/queue.types';
import { createBullmqRedisClient } from '../src/infra/redis/bullmq-connection.provider';
import { STORAGE_PROVIDER } from '../src/infra/storage/storage.types';
import type { StubStorageProvider } from '../src/infra/storage/stub-storage.provider';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { ORDER_PHOTO_SWEEP_JOB } from '../src/modules/maintenance/maintenance.constants';
import { MAX_ATTACHMENTS_PER_MESSAGE } from '../src/modules/orders/conversations.schema';
import {
  MESSAGE_ATTACHMENT_PURPOSE,
  MessageAttachmentsMediaTarget,
} from '../src/modules/orders/message-attachments-media.target';
import { UsersRepository } from '../src/modules/users/users.repository';
import { hasGpsIfd, orientedPhoto, solidImage } from './support/image-fixtures';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';
import { grantTestSubscription } from './support/subscriptions';

/**
 * Photos in the conversation on an order (issue #181, ADR-0033 § 4), over real
 * HTTP against real Postgres and Redis.
 *
 * **The upload leg goes through the stub provider**, for the reason
 * `order-photos.e2e.test.ts` gives: `STORAGE_PROVIDER` defaults to `stub`, so
 * the app is wired to a real in-process `StubStorageProvider`, and `putObject`
 * stands in for the client's PUT to the presigned URL. It accepts any size and
 * any bytes on purpose — the refusals asserted below are the service's, not
 * the fake's.
 *
 * **The conversation is a real one**: a real master really accepts a really
 * broadcast order, because a conversation only exists inside the transaction
 * that claims an order (`order-conversation.e2e.test.ts` says why that is not
 * incidental).
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99458${String(phoneCounter).padStart(7, '0')}`;
}

const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };
const DESCRIPTION = 'Vanna otağında boru sızır.';

/** The schema's own floor for `ORDER_PHOTO_MAX_BYTES`, so "oversized" is cheap to build. */
const TEST_MAX_BYTES = 64 * 1024;

const ABANDONED_AFTER_HOURS = 24;

type ContentType = 'image/jpeg' | 'image/png' | 'image/webp';

function jpegBytes(size = 16): Uint8Array {
  const buffer = new Uint8Array(size);
  buffer.set([0xff, 0xd8, 0xff, 0xe0]);
  return buffer;
}

function htmlBytes(): Uint8Array {
  return new TextEncoder().encode('<html><body>salam</body></html>');
}

interface SeededMaster {
  readonly masterId: string;
  readonly accessToken: string;
}

interface AcceptedOrder {
  readonly orderId: string;
  readonly customerToken: string;
  readonly master: SeededMaster;
}

async function eventually<T>(
  produce: () => Promise<T>,
  satisfied: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await produce();
    if (satisfied(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Condition still false after ${String(timeoutMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('photo attachments in a conversation (issue #181)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let presence: MasterPresenceService;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let handlers: DeferredJobHandlerRegistry;
  let storage: StubStorageProvider;
  let serviceId: string;

  const seededMasterIds: string[] = [];
  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  function post(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).post(path);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  function get(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).get(path);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  async function signIn(): Promise<{ userId: string; accessToken: string }> {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    return { userId: created.user.id, accessToken: pair.accessToken };
  }

  async function seedMaster(): Promise<SeededMaster> {
    const caller = await signIn();
    const created = await post('/masters', caller.accessToken).send({ displayName: 'Usta Elçin' });
    expect(created.status).toBe(201);
    const masterId = (created.body as { id: string }).id;

    await pool.query(
      `update masters
          set verification_status = 'active', is_available = true
        where id = $1`,
      [masterId],
    );
    // The dispatch gate needs a running subscription too (#322).
    await grantTestSubscription(pool, masterId);
    await pool.query(
      `insert into master_services (master_id, service_id, price_minor, is_active)
       values ($1, $2, 6700, true)`,
      [masterId, serviceId],
    );
    await pool.query(
      `insert into master_locations (id, master_id, position, recorded_at)
       values ($1, $2,
         ST_Project(ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, 400, radians(90))::geometry,
         now())`,
      [randomUUID(), masterId, SEARCH_POINT.longitude, SEARCH_POINT.latitude],
    );
    await presence.refresh(masterId);

    seededMasterIds.push(masterId);
    return { masterId, accessToken: caller.accessToken };
  }

  /** A signed-in customer with a profile and one saved address. */
  async function seedCustomer(): Promise<{ accessToken: string; addressId: string }> {
    const caller = await signIn();
    expect(
      (await post('/customers', caller.accessToken).send({ displayName: 'Müştəri' })).status,
    ).toBe(201);

    const address = await post('/addresses', caller.accessToken).send({
      formattedAddress: 'Nizami küçəsi 203',
      latitude: SEARCH_POINT.latitude,
      longitude: SEARCH_POINT.longitude,
    });
    expect(address.status).toBe(201);
    return { accessToken: caller.accessToken, addressId: (address.body as { id: string }).id };
  }

  async function acceptedOrder(): Promise<AcceptedOrder> {
    const master = await seedMaster();
    const customer = await seedCustomer();

    const order = await post('/orders', customer.accessToken).send({
      serviceId,
      addressId: customer.addressId,
      description: DESCRIPTION,
      idempotencyKey: randomUUID(),
    });
    expect(order.status).toBe(201);
    const orderId = (order.body as { id: string }).id;

    const offer = await eventually(
      async () => {
        const { rows } = await pool.query<{ id: string; status: string }>(
          `select id::text as id, status from order_offers where order_id = $1 and master_id = $2`,
          [orderId, master.masterId],
        );
        return rows[0];
      },
      (value) => value !== undefined && value.status === 'offered',
    );
    if (offer === undefined) {
      throw new Error('unreachable: the poll only returns a defined row');
    }

    const accepted = await post(`/masters/me/offers/${offer.id}/accept`, master.accessToken).send(
      {},
    );
    expect(accepted.status).toBe(200);

    return { orderId, customerToken: customer.accessToken, master };
  }

  async function presign(
    orderId: string,
    token: string,
    contentType: ContentType = 'image/jpeg',
  ): Promise<MessageAttachmentUpload> {
    const response = await post(`/orders/${orderId}/messages/attachments`, token).send({
      contentType,
    });
    expect(response.status).toBe(201);
    return response.body as MessageAttachmentUpload;
  }

  async function storageKeyFor(attachmentId: string): Promise<string> {
    const { rows } = await pool.query<{ storage_key: string }>(
      'select storage_key from message_attachments where id = $1',
      [attachmentId],
    );
    const key = rows[0]?.storage_key;
    if (key === undefined) {
      throw new Error(`no message_attachments row for ${attachmentId}`);
    }
    return key;
  }

  function confirm(orderId: string, token: string, attachmentId: string) {
    return post(`/orders/${orderId}/messages/attachments/${attachmentId}/confirm`, token);
  }

  /** Runs the photo's re-encoding job (#318), as the `media` worker would. */
  async function sanitize(attachmentId: string): Promise<void> {
    await app
      .get(MediaPipelineService)
      .run({ purpose: MESSAGE_ATTACHMENT_PURPOSE, itemId: attachmentId });
  }

  /**
   * Presign, PUT a real image through the stub, confirm, and re-encode it, so
   * that it can be sent. Returns the id and the key of the stored copy.
   */
  async function uploadPhoto(
    orderId: string,
    token: string,
  ): Promise<{ attachmentId: string; key: string }> {
    const upload = await presign(orderId, token);
    storage.putObject(await storageKeyFor(upload.attachmentId), await solidImage('jpeg', 64, 48));
    const confirmed = await confirm(orderId, token, upload.attachmentId);
    expect(confirmed.status).toBe(201);
    await sanitize(upload.attachmentId);
    return { attachmentId: upload.attachmentId, key: await storageKeyFor(upload.attachmentId) };
  }

  async function sanitizeState(attachmentId: string): Promise<
    | {
        storage_key: string;
        sanitized_key: string | null;
        size_bytes: number;
        verified_content_type: string;
        sanitized_at: Date | null;
        sanitize_failure: string | null;
      }
    | undefined
  > {
    const { rows } = await pool.query<{
      storage_key: string;
      sanitized_key: string | null;
      size_bytes: number;
      verified_content_type: string;
      sanitized_at: Date | null;
      sanitize_failure: string | null;
    }>(
      `select storage_key, sanitized_key, size_bytes, verified_content_type, sanitized_at,
              sanitize_failure
         from message_attachments where id = $1`,
      [attachmentId],
    );
    return rows[0];
  }

  function send(orderId: string, token: string, payload: object) {
    return post(`/orders/${orderId}/messages`, token).send(payload);
  }

  async function attachmentRow(
    attachmentId: string,
  ): Promise<{ status: string; message_id: string | null } | undefined> {
    const { rows } = await pool.query<{ status: string; message_id: string | null }>(
      'select status::text as status, message_id::text as message_id from message_attachments where id = $1',
      [attachmentId],
    );
    return rows[0];
  }

  async function messageCount(orderId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text as count from messages
        where conversation_id in (select id from conversations where order_id = $1)`,
      [orderId],
    );
    return Number(rows[0]?.count ?? '0');
  }

  /** Moves a photo's presign back in time, as if it had been started `hours` ago. */
  async function age(attachmentId: string, hours: number): Promise<void> {
    await pool.query(
      `update message_attachments
          set created_at = now() - ($2 || ' hours')::interval,
              presign_expires_at = now() - ($2 || ' hours')::interval + interval '5 minutes'
        where id = $1`,
      [attachmentId, String(hours)],
    );
  }

  async function runSweep(): Promise<void> {
    await handlers.resolve(ORDER_PHOTO_SWEEP_JOB)({});
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);

    set('DATABASE_URL', database.url);
    set('PRESENCE_TTL_SECONDS', '60');
    set('PRESENCE_HEARTBEAT_SECONDS', '10');
    set('DISPATCH_MAX_POSITION_AGE_SECONDS', '120');
    set('ORDER_PHOTO_MAX_BYTES', String(TEST_MAX_BYTES));
    set('ORDER_PHOTO_ABANDONED_AFTER_HOURS', String(ABANDONED_AFTER_HOURS));
    // The re-encoding job (#318) is run by the tests themselves, at the
    // moment each one needs it, rather than by a worker racing them.
    set('MEDIA_WORKER_MODE', 'off');
    // The shortest backoff, so a job made to fail (#374) runs out of attempts
    // in well under a second, without taking the other queues' retries away.
    set('QUEUE_JOB_BACKOFF_MS', '100');

    // Budgets other suites own; here they are only an obstacle.
    set('ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('MESSAGE_SEND_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('MESSAGE_SEND_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('UPLOAD_PRESIGN_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('UPLOAD_PRESIGN_RATE_LIMIT_PER_IP_HOUR', '9000');

    set('DISPATCH_INITIAL_RADIUS_M', '1000');
    set('DISPATCH_MAX_RADIUS_M', '4000');
    set('DISPATCH_RADIUS_STEP_SECONDS', '2');
    set('DISPATCH_TOTAL_TIMEOUT_SECONDS', '20');
    set('DISPATCH_MAX_MASTERS_PER_BROADCAST', '10');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    await new Promise<void>((resolve, reject) => {
      const server = app.getHttpServer();
      server.once('error', reject);
      server.listen(0, () => {
        resolve();
      });
    });

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    presence = app.get(MasterPresenceService);
    handlers = app.get(DeferredJobHandlerRegistry);
    storage = app.get<StubStorageProvider>(STORAGE_PROVIDER);

    pool = new Pool({ connectionString: database.url });

    const catalogue = await pool.query<{ id: string }>('select id from services limit 1');
    const found = catalogue.rows[0]?.id;
    if (found === undefined) {
      throw new Error('the seeded catalogue should contain at least one service');
    }
    serviceId = found;
  }, 120_000);

  beforeEach(async () => {
    // Every broadcast reaches only the nearest few masters, so one left
    // available by a finished test crowds out the fresh one the next test is
    // waiting for — the hazard `order-conversation.e2e.test.ts` documents.
    if (seededMasterIds.length === 0) {
      return;
    }
    await pool.query('update masters set is_available = false where id = any($1::uuid[])', [
      seededMasterIds,
    ]);
    seededMasterIds.length = 0;
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
    await database.drop();

    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  describe('the happy path', () => {
    it('a party presigns, uploads, confirms and sends a photo, and the other party sees it', async () => {
      const { orderId, customerToken, master } = await acceptedOrder();

      const upload = await presign(orderId, customerToken, 'image/png');
      expect(upload.contentType).toBe('image/png');
      expect(upload.maxBytes).toBe(TEST_MAX_BYTES);
      expect(Object.keys(upload).sort()).toEqual(
        ['attachmentId', 'contentType', 'expiresAt', 'maxBytes', 'uploadUrl'].sort(),
      );

      const key = await storageKeyFor(upload.attachmentId);
      // No order, conversation or party identifier travels in the key, which
      // is copied verbatim into every presigned URL.
      expect(key).toMatch(/^conversations\/photos\/[0-9a-f-]{36}$/);
      expect(key).not.toContain(orderId);

      const png = await solidImage('png', 64, 48);
      storage.putObject(key, png);
      const confirmed = await confirm(orderId, customerToken, upload.attachmentId);
      expect(confirmed.status).toBe(201);
      // Confirm describes the upload as it arrived.
      expect(confirmed.body as ConfirmedMessageAttachment).toMatchObject({
        id: upload.attachmentId,
        contentType: 'image/png',
        sizeBytes: png.byteLength,
      });

      // Not sendable until it is re-encoded (#318): retried as it is, it goes.
      const early = await send(orderId, customerToken, {
        body: 'Budur, boru buradan sızır.',
        attachmentIds: [upload.attachmentId],
      });
      expect(early.status).toBe(409);
      expect((early.body as ErrorEnvelope).error.code).toBe('MESSAGE_ATTACHMENT_PROCESSING');
      expect(await messageCount(orderId)).toBe(0);
      await sanitize(upload.attachmentId);
      const copyKey = await storageKeyFor(upload.attachmentId);
      expect(copyKey).toMatch(/^message-attachments\/[0-9a-f]{32}\/display\.webp$/);
      expect(storage.hasObject(key)).toBe(false);

      const sent = await send(orderId, customerToken, {
        body: 'Budur, boru buradan sızır.',
        attachmentIds: [upload.attachmentId],
      });
      expect(sent.status).toBe(201);
      const message = sent.body as Message;
      expect(message.attachments).toHaveLength(1);
      // The message describes the copy that is stored.
      expect(message.attachments[0]).toMatchObject({
        id: upload.attachmentId,
        contentType: 'image/webp',
        sizeBytes: storage.getObject(copyKey)?.bytes.byteLength,
      });
      expect(Object.keys(message.attachments[0] ?? {}).sort()).toEqual(
        ['contentType', 'expiresAt', 'id', 'sizeBytes', 'url'].sort(),
      );

      // The master reads the history and gets a short-lived read URL for it.
      const history = await get(`/orders/${orderId}/messages`, master.accessToken);
      expect(history.status).toBe(200);
      const [seen] = (history.body as CursorPage<Message>).items;
      expect(seen?.id).toBe(message.id);
      expect(seen?.attachments).toHaveLength(1);
      const attachment = seen?.attachments[0];
      expect(attachment?.url).toBe(`stub://download/${encodeURIComponent(copyKey)}`);
      const ttlMs = new Date(attachment?.expiresAt ?? 0).getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(0);
      expect(ttlMs).toBeLessThanOrEqual(300_000);

      expect(await attachmentRow(upload.attachmentId)).toEqual({
        status: 'attached',
        message_id: message.id,
      });
    });

    it('a photo may be sent on its own, with no text', async () => {
      const { orderId, master } = await acceptedOrder();
      const { attachmentId } = await uploadPhoto(orderId, master.accessToken);

      const sent = await send(orderId, master.accessToken, { attachmentIds: [attachmentId] });
      expect(sent.status).toBe(201);
      expect((sent.body as Message).body).toBe('');
      expect((sent.body as Message).attachments.map((item) => item.id)).toEqual([attachmentId]);
    });

    it('a text-only message still carries an empty attachment list', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const sent = await send(orderId, customerToken, { body: 'Salam.' });
      expect(sent.status).toBe(201);
      expect((sent.body as Message).attachments).toEqual([]);
    });

    it('a history page carries every message s photos, in upload order', async () => {
      const { orderId, customerToken, master } = await acceptedOrder();

      const first = await uploadPhoto(orderId, customerToken);
      const second = await uploadPhoto(orderId, customerToken);
      expect(
        (
          await send(orderId, customerToken, {
            body: 'İki şəkil.',
            attachmentIds: [second.attachmentId, first.attachmentId],
          })
        ).status,
      ).toBe(201);
      expect((await send(orderId, master.accessToken, { body: 'Gördüm.' })).status).toBe(201);
      const third = await uploadPhoto(orderId, master.accessToken);
      expect(
        (await send(orderId, master.accessToken, { attachmentIds: [third.attachmentId] })).status,
      ).toBe(201);

      const history = await get(`/orders/${orderId}/messages`, customerToken);
      expect(history.status).toBe(200);
      const items = (history.body as CursorPage<Message>).items;
      expect(items.map((item) => item.attachments.map((photo) => photo.id))).toEqual([
        [third.attachmentId],
        [],
        [first.attachmentId, second.attachmentId],
      ]);
    });
  });

  describe('authorization', () => {
    it('a non-party can neither presign, confirm nor read — and is told 404, never 403', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const { attachmentId } = await uploadPhoto(orderId, customerToken);
      expect(
        (await send(orderId, customerToken, { body: 'Şəkil.', attachmentIds: [attachmentId] }))
          .status,
      ).toBe(201);

      const pending = await presign(orderId, customerToken);

      const outsiderMaster = await seedMaster();
      const outsiderCustomer = await seedCustomer();

      for (const token of [outsiderMaster.accessToken, outsiderCustomer.accessToken]) {
        const presigned = await post(`/orders/${orderId}/messages/attachments`, token).send({
          contentType: 'image/jpeg',
        });
        expect(presigned.status).toBe(404);

        const confirmed = await confirm(orderId, token, pending.attachmentId);
        expect(confirmed.status).toBe(404);

        const read = await get(`/orders/${orderId}/messages`, token);
        expect(read.status).toBe(404);
        expect(JSON.stringify(read.body)).not.toContain('stub://download');
      }

      // And the pending upload is exactly as the outsiders found it.
      expect((await attachmentRow(pending.attachmentId))?.status).toBe('awaiting_upload');
    });

    it('without a token every route is a 401', async () => {
      const { orderId } = await acceptedOrder();
      const id = randomUUID();
      expect(
        (await post(`/orders/${orderId}/messages/attachments`).send({ contentType: 'image/jpeg' }))
          .status,
      ).toBe(401);
      expect((await post(`/orders/${orderId}/messages/attachments/${id}/confirm`)).status).toBe(
        401,
      );
    });

    it('the other party cannot confirm or send a photo they did not upload', async () => {
      const { orderId, customerToken, master } = await acceptedOrder();

      const pending = await presign(orderId, customerToken);
      storage.putObject(await storageKeyFor(pending.attachmentId), jpegBytes());
      expect((await confirm(orderId, master.accessToken, pending.attachmentId)).status).toBe(404);

      expect((await confirm(orderId, customerToken, pending.attachmentId)).status).toBe(201);
      const refused = await send(orderId, master.accessToken, {
        attachmentIds: [pending.attachmentId],
      });
      expect(refused.status).toBe(404);
      expect(await messageCount(orderId)).toBe(0);
      expect((await attachmentRow(pending.attachmentId))?.status).toBe('confirmed');
    });

    it('a photo from another conversation cannot be sent in this one', async () => {
      const first = await acceptedOrder();
      const second = await acceptedOrder();

      // Two orders by two different customers; the second's customer names
      // the first conversation's photo in their own.
      const { attachmentId } = await uploadPhoto(first.orderId, first.customerToken);
      const refused = await send(second.orderId, second.customerToken, {
        body: 'Bu mənim deyil.',
        attachmentIds: [attachmentId],
      });
      expect(refused.status).toBe(404);
      expect(await messageCount(second.orderId)).toBe(0);
      expect((await attachmentRow(attachmentId))?.status).toBe('confirmed');
    });
  });

  describe('what confirm refuses', () => {
    it('an oversized upload is refused at confirm, removed, and can never be sent', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const upload = await presign(orderId, customerToken);
      const key = await storageKeyFor(upload.attachmentId);
      storage.putObject(key, jpegBytes(TEST_MAX_BYTES + 1));

      const refused = await confirm(orderId, customerToken, upload.attachmentId);
      expect(refused.status).toBe(422);
      expect((refused.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
      expect(storage.hasObject(key)).toBe(false);
      expect((await attachmentRow(upload.attachmentId))?.status).toBe('awaiting_upload');

      const send409 = await send(orderId, customerToken, {
        body: 'Böyük şəkil.',
        attachmentIds: [upload.attachmentId],
      });
      expect(send409.status).toBe(409);
      expect(await messageCount(orderId)).toBe(0);
    });

    it('a file whose bytes are not the declared type is refused and removed', async () => {
      const { orderId, customerToken } = await acceptedOrder();

      // Declared PNG, the bytes are a JPEG.
      const lie = await presign(orderId, customerToken, 'image/png');
      const lieKey = await storageKeyFor(lie.attachmentId);
      storage.putObject(lieKey, jpegBytes());
      const refusedLie = await confirm(orderId, customerToken, lie.attachmentId);
      expect(refusedLie.status).toBe(422);
      expect(storage.hasObject(lieKey)).toBe(false);

      // Declared JPEG, the bytes are not an image at all.
      const html = await presign(orderId, customerToken, 'image/jpeg');
      const htmlKey = await storageKeyFor(html.attachmentId);
      storage.putObject(htmlKey, htmlBytes());
      const refusedHtml = await confirm(orderId, customerToken, html.attachmentId);
      expect(refusedHtml.status).toBe(422);
      expect(storage.hasObject(htmlKey)).toBe(false);
      expect((await attachmentRow(html.attachmentId))?.status).toBe('awaiting_upload');
    });

    it('a content type outside the allow-list is refused at presign', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      for (const contentType of ['image/svg+xml', 'text/html', 'application/pdf']) {
        const response = await post(`/orders/${orderId}/messages/attachments`, customerToken).send({
          contentType,
        });
        expect({ contentType, status: response.status }).toEqual({ contentType, status: 422 });
      }
    });

    it('confirm before the bytes arrive is a 409, and confirming twice is a 409', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const upload = await presign(orderId, customerToken);
      expect((await confirm(orderId, customerToken, upload.attachmentId)).status).toBe(409);

      storage.putObject(await storageKeyFor(upload.attachmentId), jpegBytes());
      expect((await confirm(orderId, customerToken, upload.attachmentId)).status).toBe(201);
      expect((await confirm(orderId, customerToken, upload.attachmentId)).status).toBe(409);
    });

    it('a new presign replaces the side s previous abandoned one, and its object', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const first = await presign(orderId, customerToken);
      const firstKey = await storageKeyFor(first.attachmentId);
      storage.putObject(firstKey, jpegBytes());

      const second = await presign(orderId, customerToken);
      expect(second.attachmentId).not.toBe(first.attachmentId);
      expect(await attachmentRow(first.attachmentId)).toBeUndefined();
      expect(storage.hasObject(firstKey)).toBe(false);
    });
  });

  describe('what send refuses', () => {
    it('a photo already sent cannot be sent again, and the second message is not written', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const { attachmentId } = await uploadPhoto(orderId, customerToken);
      expect((await send(orderId, customerToken, { attachmentIds: [attachmentId] })).status).toBe(
        201,
      );

      const again = await send(orderId, customerToken, {
        body: 'Yenə.',
        attachmentIds: [attachmentId],
      });
      expect(again.status).toBe(409);
      expect(await messageCount(orderId)).toBe(1);
    });

    it('one bad id refuses the whole message, and leaves the good photo unsent', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const good = await uploadPhoto(orderId, customerToken);

      const refused = await send(orderId, customerToken, {
        body: 'İki şəkil.',
        attachmentIds: [good.attachmentId, randomUUID()],
      });
      expect(refused.status).toBe(404);
      expect(await messageCount(orderId)).toBe(0);
      expect((await attachmentRow(good.attachmentId))?.status).toBe('confirmed');
    });

    it('refuses an empty message, a duplicate id, too many photos, and a malformed id', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const { attachmentId } = await uploadPhoto(orderId, customerToken);
      const tooMany = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, () => randomUUID());

      const cases: { name: string; payload: object }[] = [
        { name: 'nothing', payload: {} },
        { name: 'empty body, no photos', payload: { body: '', attachmentIds: [] } },
        { name: 'blank body, no photos', payload: { body: '   ' } },
        { name: 'duplicate id', payload: { attachmentIds: [attachmentId, attachmentId] } },
        { name: 'too many', payload: { attachmentIds: tooMany } },
        { name: 'not a uuid', payload: { attachmentIds: ['foto.jpg'] } },
        { name: 'not an array', payload: { attachmentIds: attachmentId } },
      ];

      for (const testCase of cases) {
        const response = await send(orderId, customerToken, testCase.payload);
        expect({ name: testCase.name, status: response.status }).toEqual({
          name: testCase.name,
          status: 422,
        });
      }

      expect(await messageCount(orderId)).toBe(0);
      expect((await attachmentRow(attachmentId))?.status).toBe('confirmed');
    });

    it('two concurrent sends of the same photo: exactly one wins', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const { attachmentId } = await uploadPhoto(orderId, customerToken);

      const responses = await Promise.all([
        send(orderId, customerToken, { body: 'bir', attachmentIds: [attachmentId] }),
        send(orderId, customerToken, { body: 'iki', attachmentIds: [attachmentId] }),
      ]);
      expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([
        201, 409,
      ]);
      expect(await messageCount(orderId)).toBe(1);
    });
  });

  describe('a finished order', () => {
    it('refuses presign and confirm, and still serves the photos already sent', async () => {
      const { orderId, customerToken, master } = await acceptedOrder();
      const sentPhoto = await uploadPhoto(orderId, customerToken);
      expect(
        (await send(orderId, customerToken, { attachmentIds: [sentPhoto.attachmentId] })).status,
      ).toBe(201);
      const pending = await presign(orderId, customerToken);
      storage.putObject(await storageKeyFor(pending.attachmentId), jpegBytes());

      const cancelled = await post(`/orders/${orderId}/transitions`, customerToken).send({
        to: 'CANCELLED',
        reason: 'Özüm düzəltdim.',
      });
      expect(cancelled.status).toBe(200);

      const presignRefused = await post(
        `/orders/${orderId}/messages/attachments`,
        customerToken,
      ).send({ contentType: 'image/jpeg' });
      expect(presignRefused.status).toBe(409);
      expect((presignRefused.body as ErrorEnvelope).error.code).toBe('CONVERSATION_NOT_WRITABLE');

      const confirmRefused = await confirm(orderId, customerToken, pending.attachmentId);
      expect(confirmRefused.status).toBe(409);
      expect((confirmRefused.body as ErrorEnvelope).error.code).toBe('CONVERSATION_NOT_WRITABLE');

      // The transcript, photos included, is still readable by both parties.
      const history = await get(`/orders/${orderId}/messages`, master.accessToken);
      expect(history.status).toBe(200);
      expect(
        (history.body as CursorPage<Message>).items[0]?.attachments.map((photo) => photo.id),
      ).toEqual([sentPhoto.attachmentId]);
    });
  });

  describe('the transcript protects its photos', () => {
    it('an attached photo cannot be detached, swapped or deleted', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const { attachmentId } = await uploadPhoto(orderId, customerToken);
      expect((await send(orderId, customerToken, { attachmentIds: [attachmentId] })).status).toBe(
        201,
      );

      await expect(
        pool.query(
          `update message_attachments set storage_key = 'conversations/photos/other' where id = $1`,
          [attachmentId],
        ),
      ).rejects.toThrow(/write-once/);
      await expect(
        pool.query('delete from message_attachments where id = $1', [attachmentId]),
      ).rejects.toThrow(/write-once/);
      await expect(pool.query('truncate message_attachments')).rejects.toThrow(/truncated/);

      expect((await attachmentRow(attachmentId))?.status).toBe('attached');
    });

    it('the database refuses a whitespace-only body even where Zod is not in the way', async () => {
      const { orderId } = await acceptedOrder();
      const { rows } = await pool.query<{ id: string }>(
        'select id::text as id from conversations where order_id = $1',
        [orderId],
      );
      await expect(
        pool.query(
          `insert into messages (id, conversation_id, sender_kind, body) values ($1, $2, 'customer', '   ')`,
          [randomUUID(), rows[0]?.id],
        ),
      ).rejects.toThrow(/messages_body_shape/);
    });

    it('a page of photos is read through the per-message index', async () => {
      const client = await pool.connect();
      try {
        await client.query('set enable_seqscan = off');
        const { rows } = await client.query<{ 'QUERY PLAN': string }>(
          `explain select * from message_attachments
             where message_id = any($1::uuid[]) and status = 'attached'`,
          [[randomUUID(), randomUUID()]],
        );
        expect(rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(
          'message_attachments_message_idx',
        );
      } finally {
        await client.query('reset enable_seqscan');
        client.release();
      }
    });
  });

  describe('re-encoding without metadata (#318)', () => {
    it('sends a geotagged photo only as a re-encoded copy with no EXIF or GPS', async () => {
      const { orderId, customerToken, master } = await acceptedOrder();
      // Held sideways and geotagged, as a phone writes it.
      const geotagged = await orientedPhoto('jpeg', 6);
      const input = await sharp(geotagged).metadata();
      expect(input.exif !== undefined && hasGpsIfd(input.exif)).toBe(true);

      const upload = await presign(orderId, customerToken);
      const uploadKey = await storageKeyFor(upload.attachmentId);
      storage.putObject(uploadKey, geotagged);
      expect((await confirm(orderId, customerToken, upload.attachmentId)).status).toBe(201);
      // Confirm hands the photo to the `media` queue, keyed by the photo.
      const mediaQueue = app.get<Queue>(getQueueToken(MEDIA_QUEUE));
      expect(
        await mediaQueue.getJob(`${MESSAGE_ATTACHMENT_PURPOSE}-${upload.attachmentId}`),
      ).toBeDefined();

      await sanitize(upload.attachmentId);

      const row = await sanitizeState(upload.attachmentId);
      expect(row?.sanitized_at).not.toBeNull();
      expect(row?.sanitize_failure).toBeNull();
      expect(row?.sanitized_key).toBe(row?.storage_key);
      expect(row?.verified_content_type).toBe('image/webp');
      // The upload, GPS and all, is gone; the copy is all that is left.
      expect(storage.hasObject(uploadKey)).toBe(false);
      const copy = storage.getObject(row?.storage_key ?? '');
      expect(copy?.bytes.byteLength).toBe(row?.size_bytes);
      const meta = await sharp(copy?.bytes).metadata();
      // Upright: the orientation was applied to the pixels before the tag went.
      expect(meta).toMatchObject({ format: 'webp', width: 300, height: 200 });
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      // And not merely hidden from `metadata()`: the GPS reference is not in the bytes.
      expect(Buffer.from(copy?.bytes ?? new Uint8Array()).includes('GPS')).toBe(false);

      expect(
        (await send(orderId, customerToken, { attachmentIds: [upload.attachmentId] })).status,
      ).toBe(201);
      const history = await get(`/orders/${orderId}/messages`, master.accessToken);
      const [seen] = (history.body as CursorPage<Message>).items;
      expect(seen?.attachments[0]?.url).toBe(
        `stub://download/${encodeURIComponent(row?.storage_key ?? '')}`,
      );
    });

    it('refuses for good a photo that cannot be re-encoded, and deletes its upload', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const upload = await presign(orderId, customerToken);
      const uploadKey = await storageKeyFor(upload.attachmentId);
      // A JPEG's leading bytes, which pass the sniff, and nothing decodable after them.
      storage.putObject(uploadKey, jpegBytes(64));
      expect((await confirm(orderId, customerToken, upload.attachmentId)).status).toBe(201);

      // The job records the failure, then tells the queue not to retry.
      await expect(sanitize(upload.attachmentId)).rejects.toThrow(/undecodable/);

      const row = await sanitizeState(upload.attachmentId);
      expect(row?.sanitized_at).toBeNull();
      expect(row?.sanitize_failure).not.toBeNull();
      expect(storage.hasObject(uploadKey)).toBe(false);

      const refused = await send(orderId, customerToken, {
        body: 'Şəkil.',
        attachmentIds: [upload.attachmentId],
      });
      expect(refused.status).toBe(422);
      expect((refused.body as ErrorEnvelope).error.code).toBe('MESSAGE_ATTACHMENT_UNUSABLE');
      expect(await messageCount(orderId)).toBe(0);
      expect((await attachmentRow(upload.attachmentId))?.status).toBe('confirmed');
    });

    it('enqueues the job again when a send finds the photo still processing', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const upload = await presign(orderId, customerToken);
      storage.putObject(await storageKeyFor(upload.attachmentId), await solidImage('jpeg', 64, 48));
      expect((await confirm(orderId, customerToken, upload.attachmentId)).status).toBe(201);

      // As if confirm's enqueue had been lost.
      const mediaQueue = app.get<Queue>(getQueueToken(MEDIA_QUEUE));
      const jobId = `${MESSAGE_ATTACHMENT_PURPOSE}-${upload.attachmentId}`;
      await mediaQueue.remove(jobId);
      expect(await mediaQueue.getJob(jobId)).toBeUndefined();

      const refused = await send(orderId, customerToken, { attachmentIds: [upload.attachmentId] });
      expect(refused.status).toBe(409);
      expect((refused.body as ErrorEnvelope).error.code).toBe('MESSAGE_ATTACHMENT_PROCESSING');
      expect(await mediaQueue.getJob(jobId)).toBeDefined();
    });

    it('rescues a photo whose job failed without marking it, on the next send (#374)', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const upload = await presign(orderId, customerToken);
      storage.putObject(await storageKeyFor(upload.attachmentId), await solidImage('jpeg', 64, 48));
      expect((await confirm(orderId, customerToken, upload.attachmentId)).status).toBe(201);
      const mediaQueue = app.get<Queue>(getQueueToken(MEDIA_QUEUE));
      const jobId = `${MESSAGE_ATTACHMENT_PURPOSE}-${upload.attachmentId}`;

      // The job's last attempt dies before the photo can be marked failed.
      const { redis, queue } = parseEnv(process.env);
      const connection = createBullmqRedisClient(redis.url);
      connection.on('error', () => undefined);
      const dying = new Worker(
        MEDIA_QUEUE,
        () => {
          throw new Error('lost');
        },
        { connection, prefix: queue.prefix },
      );
      dying.on('error', () => undefined);
      try {
        await eventually(
          async () => (await mediaQueue.getJob(jobId))?.getState(),
          (state) => state === 'failed',
        );
      } finally {
        await dying.close();
        connection.disconnect();
      }
      expect((await sanitizeState(upload.attachmentId))?.sanitize_failure).toBeNull();

      const refused = await send(orderId, customerToken, { attachmentIds: [upload.attachmentId] });
      expect(refused.status).toBe(409);
      expect((refused.body as ErrorEnvelope).error.code).toBe('MESSAGE_ATTACHMENT_PROCESSING');
      // The send's enqueue reached the failed job instead of being ignored.
      expect(await (await mediaQueue.getJob(jobId))?.getState()).toBe('waiting');

      // And that very job, run by a worker as the `media` worker runs it,
      // re-encodes the photo.
      const workerConnection = createBullmqRedisClient(redis.url);
      workerConnection.on('error', () => undefined);
      const pipeline = app.get(MediaPipelineService);
      const working = new Worker(
        MEDIA_QUEUE,
        async (job) => {
          if (job.id === jobId) {
            await pipeline.run(job.data as DeferredJobPayload);
          }
        },
        { connection: workerConnection, prefix: queue.prefix },
      );
      working.on('error', () => undefined);
      try {
        await eventually(
          async () => (await sanitizeState(upload.attachmentId))?.sanitized_at,
          (sanitizedAt) => sanitizedAt !== null && sanitizedAt !== undefined,
        );
      } finally {
        await working.close();
        workerConnection.disconnect();
      }
      expect(
        (await send(orderId, customerToken, { attachmentIds: [upload.attachmentId] })).status,
      ).toBe(201);
    });

    it('answers a ready photo sent with one still processing as processing, not as sent', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const ready = await uploadPhoto(orderId, customerToken);
      const pending = await presign(orderId, customerToken);
      storage.putObject(
        await storageKeyFor(pending.attachmentId),
        await solidImage('jpeg', 64, 48),
      );
      expect((await confirm(orderId, customerToken, pending.attachmentId)).status).toBe(201);
      const mediaQueue = app.get<Queue>(getQueueToken(MEDIA_QUEUE));
      const jobId = `${MESSAGE_ATTACHMENT_PURPOSE}-${pending.attachmentId}`;
      await mediaQueue.remove(jobId);

      const refused = await send(orderId, customerToken, {
        attachmentIds: [ready.attachmentId, pending.attachmentId],
      });
      expect(refused.status).toBe(409);
      expect((refused.body as ErrorEnvelope).error.code).toBe('MESSAGE_ATTACHMENT_PROCESSING');
      expect(await mediaQueue.getJob(jobId)).toBeDefined();
      // The ready photo's claim went back with the message.
      expect(await messageCount(orderId)).toBe(0);
      expect((await attachmentRow(ready.attachmentId))?.status).toBe('confirmed');
    });

    it('treats a second run that lands on the accepted copy as done, even once it is sent', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const { attachmentId, key } = await uploadPhoto(orderId, customerToken);
      expect((await send(orderId, customerToken, { attachmentIds: [attachmentId] })).status).toBe(
        201,
      );
      const row = await sanitizeState(attachmentId);
      const copy = { name: 'display', key, width: 64, height: 48, bytes: row?.size_bytes ?? 1 };
      const target = app.get(MessageAttachmentsMediaTarget);

      // A redelivered job that wrote over the same reserved key.
      expect(await target.complete(attachmentId, [copy])).toBe('accepted');
      // One that wrote somewhere else: that copy is the one to delete.
      expect(
        await target.complete(attachmentId, [
          { ...copy, key: 'message-attachments/other/display.webp' },
        ]),
      ).toBe('discarded');
      expect(storage.hasObject(key)).toBe(true);
      expect((await attachmentRow(attachmentId))?.status).toBe('attached');
    });

    it('shows nobody a photo sent before #318, which was never re-encoded', async () => {
      const { orderId, customerToken, master } = await acceptedOrder();
      const legacy = await uploadPhoto(orderId, customerToken);
      expect(
        (await send(orderId, customerToken, { attachmentIds: [legacy.attachmentId] })).status,
      ).toBe(201);
      // Rewind it to how a photo sent before #318 is stored. Only the
      // write-once trigger stands in the way, so it is lifted for the one
      // statement on this throwaway database.
      await pool.query(
        'alter table message_attachments disable trigger message_attachments_write_once',
      );
      try {
        await pool.query(
          `update message_attachments set sanitized_at = null, sanitized_key = null where id = $1`,
          [legacy.attachmentId],
        );
      } finally {
        await pool.query(
          'alter table message_attachments enable trigger message_attachments_write_once',
        );
      }

      for (const token of [customerToken, master.accessToken]) {
        const history = await get(`/orders/${orderId}/messages`, token);
        expect(history.status).toBe(200);
        const [seen] = (history.body as CursorPage<Message>).items;
        expect(seen?.attachments).toEqual([]);
      }
    });

    it('lets the schema record only a whole outcome: re-encoded with its copy, or failed', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const upload = await presign(orderId, customerToken);
      storage.putObject(await storageKeyFor(upload.attachmentId), jpegBytes());
      expect((await confirm(orderId, customerToken, upload.attachmentId)).status).toBe(201);

      // Re-encoded, but still naming the upload rather than its copy.
      await expect(
        pool.query(
          `update message_attachments
              set sanitized_at = now(), sanitized_key = 'message-attachments/x/display.webp'
            where id = $1`,
          [upload.attachmentId],
        ),
      ).rejects.toThrow(/message_attachments_sanitize_shape/);
      // Both outcomes at once.
      await expect(
        pool.query(
          `update message_attachments
              set sanitized_at = now(), sanitized_key = storage_key,
                  sanitize_failure = 'processing_failed'
            where id = $1`,
          [upload.attachmentId],
        ),
      ).rejects.toThrow(/message_attachments_sanitize_shape/);
    });
  });

  describe('the sweep (extending #92)', () => {
    it('deletes a photo that could not be re-encoded once the window has passed', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const upload = await presign(orderId, customerToken);
      const uploadKey = await storageKeyFor(upload.attachmentId);
      storage.putObject(uploadKey, jpegBytes(64));
      expect((await confirm(orderId, customerToken, upload.attachmentId)).status).toBe(201);
      await expect(sanitize(upload.attachmentId)).rejects.toThrow(/undecodable/);
      await age(upload.attachmentId, ABANDONED_AFTER_HOURS + 1);

      await runSweep();

      expect(await attachmentRow(upload.attachmentId)).toBeUndefined();
      expect(storage.hasObject(uploadKey)).toBe(false);
    });

    it('deletes an unsent photo whose job stopped after writing its copy, and both objects', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const upload = await presign(orderId, customerToken);
      const uploadKey = await storageKeyFor(upload.attachmentId);
      storage.putObject(uploadKey, jpegBytes());
      expect((await confirm(orderId, customerToken, upload.attachmentId)).status).toBe(201);
      // The job reserved its key and wrote the copy, then died before completing.
      const copyKey = `message-attachments/${randomUUID().replaceAll('-', '')}/display.webp`;
      await pool.query('update message_attachments set sanitized_key = $2 where id = $1', [
        upload.attachmentId,
        copyKey,
      ]);
      storage.putObject(copyKey, await solidImage('webp', 64, 48));
      await age(upload.attachmentId, ABANDONED_AFTER_HOURS + 1);

      await runSweep();

      expect(await attachmentRow(upload.attachmentId)).toBeUndefined();
      expect(storage.hasObject(uploadKey)).toBe(false);
      expect(storage.hasObject(copyKey)).toBe(false);
    });

    it('deletes a confirmed photo never sent, and its object, once the window has passed', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const { attachmentId, key } = await uploadPhoto(orderId, customerToken);
      await age(attachmentId, ABANDONED_AFTER_HOURS + 1);

      await runSweep();

      expect(await attachmentRow(attachmentId)).toBeUndefined();
      expect(storage.hasObject(key)).toBe(false);
    });

    it('deletes a presign whose confirm never came, and whatever bytes did arrive', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const upload = await presign(orderId, customerToken);
      const key = await storageKeyFor(upload.attachmentId);
      storage.putObject(key, jpegBytes());
      await age(upload.attachmentId, ABANDONED_AFTER_HOURS + 1);

      await runSweep();

      expect(await attachmentRow(upload.attachmentId)).toBeUndefined();
      expect(storage.hasObject(key)).toBe(false);
    });

    it('leaves a photo still inside the window alone', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const { attachmentId, key } = await uploadPhoto(orderId, customerToken);
      await age(attachmentId, ABANDONED_AFTER_HOURS - 1);

      await runSweep();

      expect((await attachmentRow(attachmentId))?.status).toBe('confirmed');
      expect(storage.hasObject(key)).toBe(true);
    });

    it('never touches a photo that went out on a message, however old its presign', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const { attachmentId, key } = await uploadPhoto(orderId, customerToken);
      // Aged while still unsent — the trigger refuses any change once it is
      // attached — then sent before the sweep gets to it.
      await age(attachmentId, ABANDONED_AFTER_HOURS * 10);
      expect((await send(orderId, customerToken, { attachmentIds: [attachmentId] })).status).toBe(
        201,
      );

      await runSweep();

      expect((await attachmentRow(attachmentId))?.status).toBe('attached');
      expect(storage.hasObject(key)).toBe(true);
    });
  });
});
