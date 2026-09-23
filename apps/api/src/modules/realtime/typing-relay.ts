import { Injectable } from '@nestjs/common';

import type { AuthenticatedSocket } from './realtime.types';

/**
 * The shortest gap between two typing frames this server relays for one socket
 * in one conversation (issue #179).
 *
 * A client may send `conversation:typing` on every keystroke; the other phone
 * needs to hear it roughly once per couple of seconds to keep an indicator
 * alive. Relaying every keystroke would turn one person typing into a frame per
 * character on the other party's radio — the cheapest flood in the system, as
 * the issue puts it — for no visible difference.
 *
 * A constant rather than configuration: nothing operational depends on it, and
 * the client's indicator lapse (a few seconds after the last frame) is sized
 * against it rather than against a deployment's choice.
 */
export const TYPING_RELAY_INTERVAL_MS = 2_000;

/**
 * Server-side debounce for typing frames — **leading edge, per socket and
 * order**.
 *
 * The first frame after a quiet interval is relayed at once, so the indicator
 * appears without delay; the rest of the interval is dropped. Nothing is held
 * back to be sent later, so there is no timer to cancel and nothing to leak.
 *
 * **In-process, and that is correct here** for the reason `InboundBudget`
 * gives: a typing frame arrives on one connection held by one instance, so
 * there is nothing two instances could disagree about (CLAUDE.md §12).
 *
 * This is not the rate limit. The per-connection `InboundBudget` is spent
 * before this is asked, so a flood is refused there; this only decides which
 * of the frames an honest client sends are worth passing on.
 */
@Injectable()
export class TypingRelay {
  /** `socketId` → `orderId` → when that socket's last relayed frame went out. */
  private readonly lastRelayed = new Map<string, Map<string, number>>();

  /** Whether this frame is the one of its interval that gets relayed. */
  admit(client: AuthenticatedSocket, orderId: string, nowMs: number = Date.now()): boolean {
    const perOrder = this.lastRelayed.get(client.id) ?? new Map<string, number>();
    const last = perOrder.get(orderId);

    if (last !== undefined && nowMs - last < TYPING_RELAY_INTERVAL_MS) {
      return false;
    }

    perOrder.set(orderId, nowMs);
    this.lastRelayed.set(client.id, perOrder);
    return true;
  }

  /**
   * Forgets a socket. Called on disconnect; without it the map would hold every
   * socket the process has ever seen. A socket's entries are bounded by the
   * order rooms it can be in, which is one or two in practice.
   */
  release(client: AuthenticatedSocket): void {
    this.lastRelayed.delete(client.id);
  }
}
