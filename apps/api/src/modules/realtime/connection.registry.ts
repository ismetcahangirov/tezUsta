import { Inject, Injectable, Logger } from '@nestjs/common';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import type { AuthenticatedSocket } from './realtime.types';

/**
 * Bounds how many sockets one account holds on **this instance**
 * (`realtime-architecture.md` § Security: "Cap connections per user to bound
 * resource use from a malicious client").
 *
 * **Per-instance, and that is the correct scope — not a §12 violation.** The
 * rule CLAUDE.md §12 states is that no in-process state may exist that two
 * instances would *disagree* about, and there is nothing here to disagree on:
 * a socket consumes file descriptors, memory and event-loop time on the one
 * instance that holds it, and each instance bounds exactly what it is paying
 * for. Putting this count in Redis would make every connection a network
 * round trip in order to bound a resource that is not shared. The cluster-wide
 * ceiling is therefore `REALTIME_MAX_CONNECTIONS_PER_USER × instances`, which
 * is the honest description of a resource bound rather than a product limit.
 *
 * **Past the cap the oldest socket is closed, not the newest refused.** Both
 * bound the resource identically, so the tiebreaker is which behaves better
 * for a legitimate client: a master whose phone dropped off a tunnel
 * reconnects while the server is still holding sockets it has not yet noticed
 * are dead (socket.io only reaps them after `pingTimeout`). Refusing the new
 * connection would lock that master out of their own account for as long as
 * the corpses survive — on a mobile network, repeatedly. Evicting the oldest
 * is not a weaker control either: an attacker who reaches this code already
 * holds a valid access token for the account, so being able to disconnect
 * that account's own sockets is not an escalation.
 */
@Injectable()
export class ConnectionRegistry {
  private readonly logger = new Logger(ConnectionRegistry.name);

  /**
   * Per account, oldest first. Insertion order is age order because a socket
   * is appended when it connects and removed when it goes — so the eviction
   * below never has to sort.
   *
   * **Every array here is mutated in place, never replaced**, because
   * {@link release} runs *re-entrantly* inside {@link admit}'s eviction loop:
   * `disconnect()` invokes the gateway's disconnect handler synchronously —
   * verified against the shipped socket.io rather than assumed.
   *
   * Replacing the array instead is not a live defect today, and this is not
   * presented as a fixed bug: `admit` can only ever exceed the cap by one, so
   * the loop runs exactly once and the re-entrant `release` finds the evicted
   * socket already removed, leaving both copies with identical contents.
   * Mutating in place is preferred because it does not *depend* on that
   * coincidence — anything that ever evicts twice in one pass, or re-reads the
   * map between evictions, would otherwise silently disagree with itself.
   */
  private readonly byUser = new Map<string, AuthenticatedSocket[]>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * Records a socket that has already authenticated, and closes whatever it
   * pushed past the cap.
   */
  admit(socket: AuthenticatedSocket): void {
    const userId = socket.data.actor.userId;
    const held = this.byUser.get(userId) ?? [];
    held.push(socket);
    this.byUser.set(userId, held);

    const cap = this.config.realtime.maxConnectionsPerUser;
    while (held.length > cap) {
      // Removed from the list *before* the disconnect, not after. The handler
      // `disconnect()` triggers calls `release` synchronously, and a socket
      // still in the list at that moment would be removed by `release`
      // instead — leaving this loop's `shift()` to take a second, innocent
      // socket on the next pass.
      const oldest = held.shift();
      if (oldest === undefined) {
        break;
      }
      // `true` closes the underlying connection rather than only the
      // namespace — the point is to give the file descriptor back.
      oldest.disconnect(true);
      // The account is not named. A user id is not a secret the way a phone
      // number is, but it is still the identifier that ties every other log
      // line together, and a client can force this line to be written.
      this.logger.warn(`connection cap reached; closed the oldest socket ${oldest.id}`);
    }
  }

  /**
   * Forgets a socket that has gone. Called for every disconnect, including
   * the ones {@link admit} caused, so the map cannot outlive the sockets it
   * describes.
   */
  release(socket: AuthenticatedSocket): void {
    const userId = socket.data.actor?.userId;
    if (userId === undefined) {
      return;
    }

    const held = this.byUser.get(userId);
    if (held === undefined) {
      return;
    }

    // In place — see the field's docblock. A socket evicted by `admit` has
    // already been removed, so this finds nothing and does nothing, which is
    // the intended no-op rather than an error.
    const at = held.findIndex((candidate) => candidate.id === socket.id);
    if (at !== -1) {
      held.splice(at, 1);
    }

    if (held.length === 0) {
      // Deleting rather than leaving an empty array: this map is keyed by
      // every account that has ever connected to this instance, and an entry
      // per past user is a slow leak on a long-lived process.
      this.byUser.delete(userId);
    }
  }

  /** How many sockets this instance currently holds for an account. */
  countFor(userId: string): number {
    return this.byUser.get(userId)?.length ?? 0;
  }
}
