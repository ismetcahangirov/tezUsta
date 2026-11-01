import { router } from 'expo-router';
import { useCallback } from 'react';

import { useAppDispatch } from '../store/hooks';
import { roleSelected } from '../store/session-slice';

/**
 * Switches to the master role and opens its home, replacing the onboarding
 * screen so Back does not return to a step that is already done. The choice is
 * remembered like any other role choice (`store/remembered-role.ts`).
 */
export function useOpenMasterArea(): () => void {
  const dispatch = useAppDispatch();
  return useCallback(() => {
    dispatch(roleSelected('master'));
    router.replace('/(master)');
  }, [dispatch]);
}
