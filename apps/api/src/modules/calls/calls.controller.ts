import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import type { Call, CallJoinCredential } from '@tezusta/types';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { Roles } from '../auth/roles.decorator';
import { callIdParamsSchema } from './calls.schema';
import { CallsService } from './calls.service';

class CallIdParamsDto extends createZodDto(callIdParamsSchema) {}

/**
 * Calling's HTTP routes: a credential for an answered call's media room
 * (issue #185), and one call as a party sees it (issue #189).
 *
 * **HTTP rather than a socket frame, for the caller.** The callee receives its
 * credential in the ack of its own `call:accept`; the caller learns of the
 * answer from `call:accepted`, which goes to every device the account holds
 * and so cannot carry a token (ADR-0034 § 3). The caller's device that is
 * actually on the call asks here instead — and so does either party
 * reconnecting after a network change, which is the other reason this is a
 * request and not a push: a credential is handed to whoever proves, now, that
 * they are a party to a call that is `ACCEPTED` on an order that is live.
 *
 * `@Roles('customer', 'master')` is a first gate and not the authorization,
 * as on every order route: whether *this* account is on *this* call is read
 * from the database per request (`CallsService.join`).
 *
 * **Not rate-limited, and the line is deliberate**: minting is local signing
 * with no third-party cost, it answers only a party to an answered call, and
 * each credential is bounded by `CALL_JOIN_TOKEN_TTL_SECONDS`. What would be
 * worth a budget — ringing somebody — is the invite, and that has one.
 */
@Roles('customer', 'master')
@Controller('calls/:callId')
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  /**
   * The call as this party sees it — what a device reads before it lets a
   * ring push open an incoming screen (#189, ADR-0039 § 4). 404 for a call
   * that does not exist and for one this account is not on, alike.
   *
   * Not rate-limited, for `join`'s reason: one primary-key read, answering
   * only a party.
   */
  @Get()
  async find(@CurrentActor() actor: Actor, @Param() params: CallIdParamsDto): Promise<Call> {
    return this.calls.find(actor, params.callId);
  }

  /**
   * `@HttpCode(200)`: nothing is created — the call already exists — and a
   * credential is a read of what the accept already entitled the caller to.
   */
  @HttpCode(200)
  @Post('join')
  async join(
    @CurrentActor() actor: Actor,
    @Param() params: CallIdParamsDto,
  ): Promise<CallJoinCredential> {
    return this.calls.join(actor, params.callId);
  }
}
