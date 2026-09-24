import { Injectable, Logger } from '@nestjs/common';
import type { CallAcceptAck, CallActionAck, CallInviteAck, CallRefusal } from '@tezusta/types';
import type { z } from 'zod';

import { ActorService } from '../auth/actor.service';
import type { Actor } from '../auth/auth.types';
import { InvalidAccessTokenError } from '../auth/token.service';
import { callActionRequestSchema, callInviteRequestSchema } from '../calls/calls.schema';
import type { CallActionInput, CallInviteInput } from '../calls/calls.schema';
import { callRefusal, CallsService } from '../calls/calls.service';
import { InboundBudget } from './inbound-budget';
import type { AuthenticatedSocket } from './realtime.types';

/**
 * The checks every call frame passes before `CallsService` sees it
 * (issue #185): **validation, budget, then the actor re-read** — the order the
 * room handlers use, for their reasons, with one step they do not need.
 *
 * **The re-read is that step.** A room join only *listens*, and the socket's
 * frozen actor (bounded by the token's `exp`, `realtime.types.ts`) is enough
 * to decide that. A call frame *acts*: an invite rings another person's phone
 * and an accept mints a media credential, so it is authorized against the
 * account as it is now (`ActorService.current`) — a session signed out or an
 * account suspended since the handshake is refused on its very next frame.
 * Everything after that — whose order, whose call, which edge — is
 * `CallsService`'s, and is read from the database too.
 *
 * **No failure disconnects the socket**, as `realtime.gateway.ts#accept`
 * explains: a bad frame is answered and the connection, which may be carrying
 * a live order, stays up. An actor that no longer resolves gets
 * `CALL_FORBIDDEN` rather than a disconnect as well; the socket closes on its
 * own at the token's `exp`, and every frame until then is refused.
 *
 * **An unexpected failure is an ack too.** An exception thrown out of a
 * `@SubscribeMessage` handler becomes a socket.io `exception` event and the
 * ack is never called, so the client would wait out its own timeout on a
 * frame that already failed. It gets `CALL_UNAVAILABLE` instead, and the
 * server log gets the reason.
 */
@Injectable()
export class CallFrames {
  private readonly logger = new Logger(CallFrames.name);

  constructor(
    private readonly budget: InboundBudget,
    private readonly actors: ActorService,
    private readonly calls: CallsService,
  ) {}

  invite(client: AuthenticatedSocket, payload: unknown): Promise<CallInviteAck> {
    return this.handle(client, payload, callInviteRequestSchema, (actor, input: CallInviteInput) =>
      this.calls.invite(actor, input),
    );
  }

  accept(client: AuthenticatedSocket, payload: unknown): Promise<CallAcceptAck> {
    return this.handle(client, payload, callActionRequestSchema, (actor, input: CallActionInput) =>
      this.calls.accept(actor, input),
    );
  }

  reject(client: AuthenticatedSocket, payload: unknown): Promise<CallActionAck> {
    return this.handle(client, payload, callActionRequestSchema, (actor, input: CallActionInput) =>
      this.calls.reject(actor, input),
    );
  }

  cancel(client: AuthenticatedSocket, payload: unknown): Promise<CallActionAck> {
    return this.handle(client, payload, callActionRequestSchema, (actor, input: CallActionInput) =>
      this.calls.cancel(actor, input),
    );
  }

  hangup(client: AuthenticatedSocket, payload: unknown): Promise<CallActionAck> {
    return this.handle(client, payload, callActionRequestSchema, (actor, input: CallActionInput) =>
      this.calls.hangup(actor, input),
    );
  }

  private async handle<Input, Ack>(
    client: AuthenticatedSocket,
    payload: unknown,
    schema: z.ZodType<Input>,
    act: (actor: Actor, input: Input) => Promise<Ack>,
  ): Promise<Ack | CallRefusal> {
    const parsed = schema.safeParse(payload);

    if (!parsed.success) {
      return callRefusal('CALL_INVALID');
    }

    if (!this.budget.consume(client)) {
      this.logger.warn(`socket ${client.id} exceeded its inbound message budget`);
      return callRefusal('RATE_LIMITED');
    }

    try {
      const actor = await this.currentActor(client);
      return actor === undefined ? callRefusal('CALL_FORBIDDEN') : await act(actor, parsed.data);
    } catch (error) {
      this.logger.error(
        `a call frame on socket ${client.id} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return callRefusal('CALL_UNAVAILABLE');
    }
  }

  /** The socket's account as it is now, or `undefined` if it no longer resolves. */
  private async currentActor(client: AuthenticatedSocket): Promise<Actor | undefined> {
    try {
      return await this.actors.current(client.data.actor);
    } catch (error) {
      if (error instanceof InvalidAccessTokenError) {
        // `reason` is a fixed vocabulary of our own words (`socket.authenticator.ts`).
        this.logger.warn(`socket ${client.id} refused a call frame: ${error.reason}`);
        return undefined;
      }
      throw error;
    }
  }
}
