import type { RefreshCoordinator, RefreshOutcome } from '../auth/refresh';
import type { SessionIdentity } from '../store/session-slice';

import type { SocketEnding } from './realtime-connection';
import { EXPIRY_MARGIN_MS, createSessionRecovery } from './session-recovery';

const NOW = 1_800_000_000_000;
const IDENTITY: SessionIdentity = { userId: 'user-1', roles: ['master'] };

/** A token shaped the way the server mints one; nothing here verifies it. */
function tokenExpiringAt(epochMs: number): string {
  const segment = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');

  return `${segment({ alg: 'HS256' })}.${segment({ sub: 'user-1', exp: epochMs / 1_000 })}.sig`;
}

interface Harness {
  decide(ending: SocketEnding): Promise<'retry' | 'stop'>;
  readonly refreshes: () => number;
  readonly refreshedWith: readonly SessionIdentity[];
  readonly ended: () => number;
}

/**
 * `token` is what the store holds when the recovery runs; `presented` is what
 * the ended socket dialled with, the same token unless the HTTP layer rotated
 * it in between (#474).
 */
function harness(
  token: string | null,
  outcome: RefreshOutcome,
  presented: string | null = token,
): Harness {
  let refreshes = 0;
  let ended = 0;
  const refreshedWith: SessionIdentity[] = [];
  const coordinator: RefreshCoordinator = {
    refresh: () => {
      refreshes += 1;
      return Promise.resolve(outcome);
    },
  };

  const recover = createSessionRecovery({
    tokens: { getAccessToken: () => token },
    coordinator,
    onRefreshed: (identity) => refreshedWith.push(identity),
    onSessionEnded: () => {
      ended += 1;
    },
    now: () => NOW,
  });
  const decide = (ending: SocketEnding): Promise<'retry' | 'stop'> => recover(ending, presented);

  return { decide, refreshes: () => refreshes, refreshedWith, ended: () => ended };
}

const REFRESHED: RefreshOutcome = { status: 'refreshed', identity: IDENTITY };

/**
 * What the app does once socket.io has given up on its socket (issue #468).
 * Each case is a real situation: the 15-minute token running out on an open
 * screen, the connection cap evicting this phone, a suspended account, and the
 * session ending altogether.
 */
describe('recovering the realtime session', () => {
  it('renews an expired token and dials again after the server closes the socket', async () => {
    const app = harness(tokenExpiringAt(NOW), REFRESHED);

    await expect(app.decide('closed-by-server')).resolves.toBe('retry');
    expect(app.refreshes()).toBe(1);
    expect(app.refreshedWith).toEqual([IDENTITY]);
  });

  it('counts a token inside the skew margin as expired', async () => {
    const app = harness(tokenExpiringAt(NOW + EXPIRY_MARGIN_MS), REFRESHED);

    await expect(app.decide('closed-by-server')).resolves.toBe('retry');
    expect(app.refreshes()).toBe(1);
  });

  /**
   * The connection cap. Coming back would evict another of this account's
   * sockets, which would come back too.
   */
  it('stays closed when the server closed a socket whose token is still good', async () => {
    const app = harness(tokenExpiringAt(NOW + EXPIRY_MARGIN_MS + 1), REFRESHED);

    await expect(app.decide('closed-by-server')).resolves.toBe('stop');
    expect(app.refreshes()).toBe(0);
  });

  /**
   * The race in #474: the socket's token ran out and the server closed it, but
   * a location report got its 401 first and the HTTP layer already renewed
   * the pair. Judged by the stored token this looked like an eviction.
   */
  it('dials again with the token the HTTP layer already renewed, without a second refresh', async () => {
    const app = harness(
      tokenExpiringAt(NOW + 15 * 60_000),
      REFRESHED,
      tokenExpiringAt(NOW - 1_000),
    );

    await expect(app.decide('closed-by-server')).resolves.toBe('retry');
    expect(app.refreshes()).toBe(0);
  });

  it('still stays closed when the socket that was closed held a good token', async () => {
    const app = harness(
      tokenExpiringAt(NOW + 15 * 60_000),
      REFRESHED,
      tokenExpiringAt(NOW + 10 * 60_000),
    );

    await expect(app.decide('closed-by-server')).resolves.toBe('stop');
    expect(app.refreshes()).toBe(0);
  });

  it('renews when the store still holds the token the socket presented', async () => {
    const expired = tokenExpiringAt(NOW - 1_000);
    const app = harness(expired, REFRESHED, expired);

    await expect(app.decide('closed-by-server')).resolves.toBe('retry');
    expect(app.refreshes()).toBe(1);
  });

  /**
   * A suspended account or a revoked session: a refresh would not help, and
   * would rotate the token on every retry.
   */
  it('dials a refused handshake again without renewing a token that is still good', async () => {
    const app = harness(tokenExpiringAt(NOW + 10 * EXPIRY_MARGIN_MS), REFRESHED);

    await expect(app.decide('refused')).resolves.toBe('retry');
    expect(app.refreshes()).toBe(0);
  });

  it('renews an expired token before dialling a refused handshake again', async () => {
    const app = harness(tokenExpiringAt(NOW - 1), REFRESHED);

    await expect(app.decide('refused')).resolves.toBe('retry');
    expect(app.refreshes()).toBe(1);
  });

  it('ends the session, and stops, when the refresh token is refused', async () => {
    const app = harness(tokenExpiringAt(NOW), { status: 'rejected' });

    await expect(app.decide('closed-by-server')).resolves.toBe('stop');
    expect(app.ended()).toBe(1);
  });

  /** Offline, or the API is down: the refresh token is kept for the next try. */
  it('keeps trying when the refresh could not be answered', async () => {
    const app = harness(tokenExpiringAt(NOW), { status: 'unavailable' });

    await expect(app.decide('closed-by-server')).resolves.toBe('retry');
    expect(app.ended()).toBe(0);
    expect(app.refreshedWith).toEqual([]);
  });

  it('renews when there is no readable token to present', async () => {
    const app = harness('not-a-token', REFRESHED);

    await expect(app.decide('refused')).resolves.toBe('retry');
    expect(app.refreshes()).toBe(1);
  });
});
