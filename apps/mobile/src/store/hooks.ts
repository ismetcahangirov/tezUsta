import { useDispatch, useSelector, useStore } from 'react-redux';

import type { AppDispatch, AppStore, RootState } from './index';

/**
 * Typed hooks, so no screen has to annotate `RootState` by hand and no screen
 * can dispatch something the store does not accept. Use these, never
 * `useDispatch` or `useSelector` directly — the untyped versions silently
 * return `any`-shaped state, which CLAUDE.md §20 forbids reaching for.
 */
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
/**
 * The store itself, for the rare read that must see the state **as of the
 * call**, not as of the last render — a decision two event sources can race
 * on (`usePresentIncomingCall`). Everything that renders uses a selector.
 */
export const useAppStore = useStore.withTypes<AppStore>();
