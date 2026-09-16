import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import type { Actor } from '../../modules/auth/auth.types';
import { ensureRequestId, requestLogContext } from './request-context';

function fakeRequest(headers: Record<string, string | string[]> = {}): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

function fakeReply(): { reply: FastifyReply; headers: Record<string, unknown> } {
  const headers: Record<string, unknown> = {};
  const reply = {
    header(name: string, value: unknown) {
      headers[name] = value;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, headers };
}

const ACTOR: Actor = {
  userId: 'user-1',
  sessionId: 'session-1',
  roles: ['customer'],
  status: 'active',
};

describe('ensureRequestId', () => {
  it('generates an id, attaches it to the request, and echoes it in the response header', () => {
    const request = fakeRequest();
    const { reply, headers } = fakeReply();

    const id = ensureRequestId(request, reply);

    expect(id).toHaveLength(36);
    expect(request.requestId).toBe(id);
    expect(headers['x-request-id']).toBe(id);
  });

  it('reuses a well-formed inbound x-request-id so a client can correlate its own retry', () => {
    const request = fakeRequest({ 'x-request-id': 'client-generated-id-123' });
    const { reply, headers } = fakeReply();

    expect(ensureRequestId(request, reply)).toBe('client-generated-id-123');
    expect(headers['x-request-id']).toBe('client-generated-id-123');
  });

  it('replaces an inbound id that could be used to inject a forged line into the log', () => {
    const spoofed = 'not-safe: <script>alert(1)</script>\nX-Injected: evil';
    const request = fakeRequest({ 'x-request-id': spoofed });
    const { reply } = fakeReply();

    expect(ensureRequestId(request, reply)).not.toBe(spoofed);
  });

  it('is idempotent — the guard resolves the id first and the interceptor must not replace it', () => {
    // The property the whole function exists for. Guards run before
    // interceptors, so both call this on the same request; a second call that
    // minted a fresh id would make the id in the guard's log line differ from
    // the one in the response the client was handed.
    const request = fakeRequest();
    const { reply } = fakeReply();

    const first = ensureRequestId(request, reply);
    const second = ensureRequestId(request, reply);

    expect(second).toBe(first);
  });
});

describe('requestLogContext', () => {
  it('carries the request id alone before a guard has resolved an actor', () => {
    const request = fakeRequest();
    request.requestId = 'req-1';

    expect(requestLogContext(request)).toBe('[req-1]');
  });

  it('adds the actor id once the guard has resolved one, so a failure ties to a user', () => {
    const request = fakeRequest();
    request.requestId = 'req-1';
    request.actor = ACTOR;

    expect(requestLogContext(request)).toBe('[req-1 actor=user-1]');
  });

  it('carries the actor id and nothing else about the actor', () => {
    // Roles are reconstructable from the id and the phone number is PII, so
    // neither belongs in a log line that is written on every failure
    // (CLAUDE.md §11).
    const request = fakeRequest();
    request.requestId = 'req-1';
    request.actor = ACTOR;

    const context = requestLogContext(request);
    expect(context).not.toContain('customer');
    expect(context).not.toContain('session-1');
  });

  it('degrades to "unknown" rather than throwing when no id was ever resolved', () => {
    // Reached only if a request bypasses both the guard and the interceptor;
    // the exception filter still has to produce a line rather than fail inside
    // the handler that is already failing.
    expect(requestLogContext(fakeRequest())).toBe('[unknown]');
  });
});
