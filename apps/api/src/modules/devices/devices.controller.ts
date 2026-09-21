import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import type { Device } from '@tezusta/types';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { rateLimitByUser } from '../../infra/rate-limit/rate-limit-by-user';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { deviceIdParamsSchema, registerDeviceSchema } from './devices.schema';
import { DevicesService } from './devices.service';

class RegisterDeviceDto extends createZodDto(registerDeviceSchema) {}
class DeviceIdParamsDto extends createZodDto(deviceIdParamsSchema) {}

/**
 * Where a user's phones say how to reach them.
 *
 * **No route here is `@Public()`, and none of them names a user.** The owner
 * is always the authenticated actor, so the only id a client can send is a
 * device id — checked against the caller before anything happens to it.
 *
 * **No route carries a push token in its path**, and that is a deliberate
 * shape rather than an accident of REST. A token in a URL is written to every
 * access log between the phone and the process, which is precisely what
 * CLAUDE.md §11 forbids; the token travels in a body, and the row is addressed
 * afterwards by the id the registration handed back.
 */
@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /**
   * Register or refresh this device. Always 201 — see `DevicesService.register`
   * on why "created" and "refreshed" do not answer differently.
   *
   * Rate-limited by user id. What this bounds is not a bill and not a
   * credential guess: registration is an unauthenticated-shaped write behind
   * an authenticated route, and without a ceiling one scripted client can fill
   * the table with tokens that will never be deliverable — each of which then
   * costs the notification worker a message and issue #142 a receipt to chase.
   * The limit is loose enough that a phone re-registering on every launch,
   * every token rotation and every sign-in never reaches it.
   */
  @Post()
  @RateLimit({ policy: 'device-registration', identifier: rateLimitByUser })
  async register(@CurrentActor() actor: Actor, @Body() body: RegisterDeviceDto): Promise<Device> {
    return this.devices.register(actor, body);
  }

  /**
   * A plain array, not a cursor page. A person has a phone, perhaps two, and
   * the whole list is a few lines; paginating it would add a cursor to every
   * render for no benefit. Retired devices are absent — a device that stopped
   * receiving is not a device the client has anything to do with.
   */
  @Get()
  async list(@CurrentActor() actor: Actor): Promise<Device[]> {
    return this.devices.list(actor);
  }

  /**
   * Retire a device — what the app calls at sign-out, before it clears the
   * session, so the server is not left holding an address for a phone nobody
   * is signed in on.
   *
   * 204, and 404 for an id that is unknown, already retired, or somebody
   * else's — indistinguishable on purpose, or the route becomes a way to ask
   * whether a device id exists.
   */
  @Delete(':id')
  @HttpCode(204)
  async retire(@CurrentActor() actor: Actor, @Param() params: DeviceIdParamsDto): Promise<void> {
    await this.devices.retire(actor, params.id);
  }
}
