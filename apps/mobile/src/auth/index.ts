export { readAccessTokenIdentity } from './access-token';
export type { OtpRequest, OtpVerification, TokenPairResponse } from './auth.types';
export {
  authApi,
  useRequestOtpMutation,
  useSignOutEverywhereMutation,
  useSignOutMutation,
  useVerifyOtpMutation,
} from './auth-endpoints';
export { createAuthBaseQuery } from './auth-base-query';
export { createRefreshCoordinator, refreshCoordinator } from './refresh';
export type { RefreshCoordinator, RefreshOutcome } from './refresh';
export {
  AUTH_ENTRY_ROUTE,
  effectiveRole,
  resolveAuthRedirect,
  ROLE_HOME_ROUTE,
  ROUTE_GROUPS,
  toRouteGroup,
} from './route-guard';
export type { AuthRedirectTarget, GuardedRoute, RouteGroup } from './route-guard';
export { tokenStore } from './token-store';
export type { TokenStore } from './token-store';
export { useAuthGuard } from './useAuthGuard';
export { useRestoreSession } from './useRestoreSession';
export { useSignOut, useSignOutEverywhere } from './useSignOut';
export type { SignOutState } from './useSignOut';
