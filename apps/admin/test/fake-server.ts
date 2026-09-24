import type { AdminMe, AdminPermission } from '@tezusta/types';
import { vi } from 'vitest';

/** One request the panel sent, as the API would have seen it. */
export interface RecordedRequest {
  readonly method: string;
  /** The URL path, `/api` prefix included — what reached the proxy. */
  readonly path: string;
  readonly origin: string;
  readonly headers: Headers;
  readonly credentials: RequestCredentials | undefined;
  readonly body: unknown;
}

export interface FakeResponse {
  readonly status: number;
  readonly body?: unknown;
}

type Handler = FakeResponse | ((request: RecordedRequest) => FakeResponse | Promise<FakeResponse>);

/**
 * A stand-in for the API behind `fetch`. Each route answers from a queue — the
 * first queued answer is used once, and the last one keeps answering — so a
 * test can say "401, then 200" without writing a state machine.
 */
export class FakeServer {
  readonly requests: RecordedRequest[] = [];
  private readonly routes = new Map<string, Handler[]>();

  on(method: string, path: string, ...answers: Handler[]): this {
    this.routes.set(`${method} ${path}`, answers);
    return this;
  }

  calls(method: string, path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && r.path === path);
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const text = await request.text();
    const recorded: RecordedRequest = {
      method: request.method,
      path: url.pathname,
      origin: url.origin,
      headers: request.headers,
      credentials: request.credentials,
      body: text === '' ? undefined : (JSON.parse(text) as unknown),
    };
    this.requests.push(recorded);

    const queue = this.routes.get(`${recorded.method} ${recorded.path}`);
    if (queue === undefined || queue.length === 0) {
      throw new Error(`FakeServer: no route for ${recorded.method} ${recorded.path}`);
    }
    const next = queue.length > 1 ? queue.shift() : queue[0];
    const answer = typeof next === 'function' ? await next(recorded) : next;
    if (answer === undefined) throw new Error('FakeServer: empty answer');
    return jsonResponse(answer);
  };
}

function jsonResponse({ status, body }: FakeResponse): Response {
  if (status === 204 || body === undefined) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The API's error envelope (backend-architecture.md § Error model). */
export function apiError(status: number, code: string, message = 'error'): FakeResponse {
  return { status, body: { error: { code, message, requestId: 'test-request' } } };
}

export const ALL_PERMISSIONS: readonly AdminPermission[] = [
  'dashboard.read',
  'orders.read',
  'orders.override',
  'disputes.resolve',
  'disputes.refund',
  'pii.read',
  'calls.read',
  'masters.read',
  'masters.review',
  'masters.suspend',
  'reviews.moderate',
  'catalogue.manage',
  'audit.read',
  'admins.manage',
];

export function adminMe(overrides: Partial<AdminMe> = {}): AdminMe {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'aysel@tezusta.test',
    displayName: 'Aysel Mammadova',
    roles: ['super_admin'],
    permissions: ALL_PERMISSIONS,
    ...overrides,
  };
}

/** Installs a fresh fake server as the global `fetch` for one test. */
export function installFakeServer(): FakeServer {
  const server = new FakeServer();
  vi.stubGlobal('fetch', vi.fn(server.fetch));
  return server;
}
