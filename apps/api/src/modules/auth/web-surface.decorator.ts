import type { CustomDecorator, ExecutionContext } from '@nestjs/common';
import { SetMetadata } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

export const WEB_SURFACE_ROUTE = 'auth:webSurfaceRoute';

/**
 * This route also accepts the master's web subscription page's session
 * ([ADR-0061](docs/decisions/ADR-0061-master-web-subscription-page.md) § 3):
 * the `tezusta-web` access token, from its httpOnly cookie, with the CSRF
 * header. The app's bearer token is accepted as before.
 *
 * **Opt-in, per handler, and deliberately rare.** Every route without it
 * refuses a web session outright, so a stolen browser cookie reaches the
 * subscription and nothing else. Adding this to a route widens what a web
 * session can do, which ADR-0061 says is a new decision, not a one-line change.
 */
export const WebSurface = (): CustomDecorator<typeof WEB_SURFACE_ROUTE> =>
  SetMetadata(WEB_SURFACE_ROUTE, true);

export function isWebSurfaceRoute(reflector: Reflector, context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean | undefined>(WEB_SURFACE_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]) === true
  );
}
