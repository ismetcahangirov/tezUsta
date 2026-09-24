import { waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { adminMe, apiError, installFakeServer } from '../../test/fake-server';
import { createStore } from '../store';
import { adminApi } from './admin-api';

/** A second authenticated route, standing in for the screens #248–#251 add. */
const probeApi = adminApi.injectEndpoints({
  endpoints: (build) => ({
    probe: build.query<unknown, void>({ query: () => '/admin/probe' }),
  }),
});

/**
 * The base query's contract, driven through the real store: what every request
 * carries, and how a 401 turns into at most one refresh.
 */
describe('adminBaseQuery', () => {
  it('sends every request to /api on the page origin with the CSRF header and same-origin credentials', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('POST', '/api/admin/auth/sign-in', { status: 200, body: adminMe() })
      .on('POST', '/api/admin/auth/sign-out', { status: 204 })
      .on('POST', '/api/admin/auth/setup/start', apiError(400, 'ADMIN_SETUP_LINK_INVALID'));
    const store = createStore();

    await store.dispatch(adminApi.endpoints.me.initiate());
    await store.dispatch(
      adminApi.endpoints.signIn.initiate({ email: 'a@b.c', password: 'x', code: '123456' }),
    );
    await store.dispatch(adminApi.endpoints.signOut.initiate());
    await store.dispatch(adminApi.endpoints.setupStart.initiate({ token: 't' }));

    expect(server.requests).toHaveLength(4);
    for (const request of server.requests) {
      expect(request.headers.get('X-TezUsta-Admin')).toBe('1');
      expect(request.credentials).toBe('same-origin');
      expect(request.origin).toBe(window.location.origin);
      expect(request.path.startsWith('/api/admin/')).toBe(true);
      // Nothing the page holds is a credential: the cookies are httpOnly.
      expect(request.headers.has('authorization')).toBe(false);
    }
  });

  it('shares one refresh between concurrent 401s and retries each request once', async () => {
    let releaseRefresh: () => void = () => undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const server = installFakeServer()
      // Each route meets the expired access cookie once; its retry does not.
      .on('GET', '/api/admin/me', apiError(401, 'UNAUTHORIZED'), { status: 200, body: adminMe() })
      .on('GET', '/api/admin/probe', apiError(401, 'UNAUTHORIZED'), { status: 200, body: {} })
      .on('POST', '/api/admin/auth/refresh', async () => {
        await refreshGate;
        return { status: 200, body: adminMe() };
      });
    const store = createStore();

    // Two different queries whose 401s both arrive before the refresh answers.
    const first = store.dispatch(adminApi.endpoints.me.initiate());
    const second = store.dispatch(probeApi.endpoints.probe.initiate());
    await waitFor(() => expect(server.calls('POST', '/api/admin/auth/refresh')).toHaveLength(1));
    await waitFor(() => expect(server.calls('GET', '/api/admin/probe')).toHaveLength(1));
    releaseRefresh();
    const [me, probe] = await Promise.all([first, second]);

    expect(me.isSuccess).toBe(true);
    expect(probe.isSuccess).toBe(true);
    expect(server.calls('POST', '/api/admin/auth/refresh')).toHaveLength(1);
    expect(server.calls('GET', '/api/admin/me')).toHaveLength(2);
    expect(server.calls('GET', '/api/admin/probe')).toHaveLength(2);
    expect(store.getState().session.signedOut).toBe(false);
  });

  it('marks the tab signed out when the refresh is refused', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', apiError(401, 'UNAUTHORIZED'))
      .on('POST', '/api/admin/auth/refresh', apiError(401, 'UNAUTHORIZED'));
    const store = createStore();

    await store.dispatch(adminApi.endpoints.me.initiate());

    expect(store.getState().session.signedOut).toBe(true);
  });

  it('does not sign the tab out when the refresh fails for want of an answer', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', apiError(401, 'UNAUTHORIZED'))
      .on('POST', '/api/admin/auth/refresh', apiError(503, 'INTERNAL_ERROR'));
    const store = createStore();

    await store.dispatch(adminApi.endpoints.me.initiate());

    expect(store.getState().session.signedOut).toBe(false);
  });

  it('never refreshes after a 401 from an auth route', async () => {
    const server = installFakeServer().on(
      'POST',
      '/api/admin/auth/sign-out',
      apiError(401, 'UNAUTHORIZED'),
    );
    const store = createStore();

    await store.dispatch(adminApi.endpoints.signOut.initiate());

    expect(server.calls('POST', '/api/admin/auth/refresh')).toHaveLength(0);
  });
});
