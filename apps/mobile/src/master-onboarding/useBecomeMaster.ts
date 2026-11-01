import { useCallback, useState } from 'react';

import { refreshCoordinator, type RefreshCoordinator } from '../auth/refresh';
import { useAppDispatch } from '../store/hooks';
import { signedIn } from '../store/session-slice';

import {
  useCreateMasterProfileMutation,
  type CreateMasterBody,
} from './master-onboarding-endpoints';

export interface BecomeMaster {
  readonly creating: boolean;
  readonly failed: boolean;
  /** Creates the profile, then refreshes the session. True on success. */
  create: (body: CreateMasterBody) => Promise<boolean>;
}

/**
 * Creates the master profile and brings the new grant into the app (#490).
 *
 * `POST /masters` grants the `master` role on the server at once, but the
 * access token in memory was minted before it and still lists the old roles.
 * The route guard reads the token's roles, so without a refresh a customer who
 * just became a master could not enter the `(master)` group for up to fifteen
 * minutes. One refresh through the shared coordinator — the same one launch
 * and the base query use, so it cannot race them into reuse detection — and a
 * `signedIn` with the new identity fix that.
 *
 * A refresh that fails leaves the profile created: the next launch, or the
 * next routine refresh, brings the grant in. The step after this (documents)
 * talks to the server, which already honours the grant, so it is not blocked.
 */
export function useBecomeMaster(
  coordinator: RefreshCoordinator = refreshCoordinator,
): BecomeMaster {
  const dispatch = useAppDispatch();
  const [createProfile, result] = useCreateMasterProfileMutation();
  const [refreshing, setRefreshing] = useState(false);

  const create = useCallback(
    async (body: CreateMasterBody): Promise<boolean> => {
      try {
        await createProfile(body).unwrap();
      } catch {
        return false;
      }

      setRefreshing(true);
      try {
        const outcome = await coordinator.refresh();
        if (outcome.status === 'refreshed' && outcome.identity !== null) {
          dispatch(signedIn(outcome.identity));
        }
      } finally {
        setRefreshing(false);
      }
      return true;
    },
    [coordinator, createProfile, dispatch],
  );

  return { creating: result.isLoading || refreshing, failed: result.isError, create };
}
