import { vi } from 'vitest';

/** One request the panel sent, as the API would have seen it. */
export interface RecordedRequest {
  readonly method: string;
  /** The URL path, `/api` prefix included — what reached the proxy. */
  readonly path: string;
  /** The query string, parsed — routes match on `path` alone. */
  readonly search: URLSearchParams;
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
 * A stand-in for the API behind `fetch`, as in the admin panel's tests. Each
 * route answers from a queue — the first queued answer is used once, and the
 * last one keeps answering — so a test can say "401, then 200" without
 * writing a state machine.
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
      search: url.searchParams,
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

/** Installs a fresh fake server as the global `fetch` for one test. */
export function installFakeServer(): FakeServer {
  const server = new FakeServer();
  vi.stubGlobal('fetch', vi.fn(server.fetch));
  return server;
}
