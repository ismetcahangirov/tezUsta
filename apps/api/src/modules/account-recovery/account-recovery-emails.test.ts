import { describe, expect, it } from 'vitest';

import {
  formatBakuTime,
  renderRecoveryCancelledNotice,
  renderRecoveryCodeEmail,
  renderRecoveryMovedNotice,
  renderRecoveryOpenedNotice,
} from './account-recovery-emails';
import type { AppConfig } from '../../infra/config/app-config.types';
import {
  AccountRecoveryService,
  hashCancelToken,
  InsecureRecoveryLinkBaseError,
  recoveryStatus,
} from './account-recovery.service';

/**
 * What ADR-0074 § 5 decides about the recovery mail, independent of its
 * placeholder wording: no notice carries a code or a sign-in link, the only
 * link is the cancel link, and the old address sees the new one masked.
 */

const LINK = 'https://api.tezusta.example/account-recovery/cancel#token';
const URL_PATTERN = /https?:\/\/\S+/gu;

describe('the recovery mail', () => {
  it('puts the code in the mail to the new address, and no link', () => {
    const mail = renderRecoveryCodeEmail('482915', 5);
    expect(mail.subject).toContain('482915');
    expect(mail.text).toContain('482915');
    expect(mail.text.match(URL_PATTERN)).toBeNull();
  });

  it('gives the old address the masked new address, the earliest move and exactly one link', () => {
    const at = new Date('2026-11-13T20:00:00Z');
    const mail = renderRecoveryOpenedNotice('n•••@example.com', at, LINK);
    expect(mail.text).toContain('n•••@example.com');
    expect(mail.text).toContain(formatBakuTime(at));
    expect(mail.text.match(URL_PATTERN)).toEqual([LINK]);
  });

  it('carries no link in the cancelled and moved notices', () => {
    expect(renderRecoveryCancelledNotice().text.match(URL_PATTERN)).toBeNull();
    expect(renderRecoveryMovedNotice('n•••@example.com').text.match(URL_PATTERN)).toBeNull();
  });

  it('reads the time in Baku', () => {
    // 20:00 UTC is midnight in Baku (UTC+4).
    expect(formatBakuTime(new Date('2026-11-13T20:00:00Z'))).toContain('00:00');
  });
});

describe('a request’s status', () => {
  const base = {
    movedAt: null,
    cancelledAt: null,
    holdUntil: null,
  } as unknown as Parameters<typeof recoveryStatus>[0];
  const now = new Date('2026-11-13T12:00:00Z');

  it('follows its timestamps', () => {
    expect(recoveryStatus(base, now)).toBe('awaiting_code');
    expect(recoveryStatus({ ...base, holdUntil: new Date('2026-11-14T00:00:00Z') }, now)).toBe(
      'on_hold',
    );
    expect(recoveryStatus({ ...base, holdUntil: now }, now)).toBe('ready');
    expect(recoveryStatus({ ...base, holdUntil: now, cancelledAt: now }, now)).toBe('cancelled');
    expect(recoveryStatus({ ...base, holdUntil: now, movedAt: now }, now)).toBe('moved');
  });
});

describe('the cancel token digest', () => {
  it('is stable and is not the token', () => {
    expect(hashCancelToken('abc')).toBe(hashCancelToken('abc'));
    expect(hashCancelToken('abc')).not.toContain('abc');
    expect(hashCancelToken('abc')).toHaveLength(64);
  });
});

describe('the cancel link’s base', () => {
  function serviceUnder(nodeEnv: string, recoveryLinkBaseUrl: string): AccountRecoveryService {
    const config = { runtime: { nodeEnv }, email: { recoveryLinkBaseUrl } } as unknown as AppConfig;
    const none = undefined as never;
    return new AccountRecoveryService(none, none, none, none, none, none, none, config, none);
  }

  it('must be https in production, and may be anything else elsewhere', () => {
    expect(() => serviceUnder('production', 'http://api.tezusta.example')).toThrow(
      InsecureRecoveryLinkBaseError,
    );
    expect(() => serviceUnder('production', 'https://api.tezusta.example')).not.toThrow();
    expect(() => serviceUnder('development', 'http://localhost:3000')).not.toThrow();
  });
});
