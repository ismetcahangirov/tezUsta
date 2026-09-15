import { useDispatch, useSelector } from 'react-redux';

import type { AppDispatch, RootState } from './index';

/**
 * Typed hooks, so no screen has to annotate `RootState` by hand and no screen
 * can dispatch something the store does not accept. Use these, never
 * `useDispatch` or `useSelector` directly — the untyped versions silently
 * return `any`-shaped state, which CLAUDE.md §20 forbids reaching for.
 */
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
