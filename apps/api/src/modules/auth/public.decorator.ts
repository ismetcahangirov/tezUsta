import type { CustomDecorator } from '@nestjs/common';
import { SetMetadata } from '@nestjs/common';

/**
 * Reflector key for {@link Public}. Namespaced because Nest metadata is a flat
 * keyspace shared with every library in the process, and a bare `'isPublic'`
 * is exactly the kind of string two of them collide on.
 */
export const IS_PUBLIC_ROUTE = 'auth:isPublicRoute';

/**
 * Opts a route out of authentication. **This is the only way out**, and it has
 * to be written deliberately on the route it applies to.
 *
 * The inverse design — an `@Authenticated()` that opts routes *in* — is the one
 * that fails in production, because the failure mode of forgetting it is an
 * open endpoint that behaves correctly in every test anyone thought to write.
 * Here, forgetting the decorator yields a 401, which is noticed immediately and
 * is never a breach (issue #27: "a new route without an explicit public marker
 * requires authentication"). `auth.guards.e2e.test.ts` asserts that default on
 * a route carrying no decorator at all, so the guarantee is checked rather than
 * described.
 *
 * Applied to a controller class it covers every route in it; applied to a
 * method it covers that method. Prefer the method, so a route added to a
 * public controller later has to make its own case.
 */
export const Public = (): CustomDecorator<typeof IS_PUBLIC_ROUTE> =>
  SetMetadata(IS_PUBLIC_ROUTE, true);
