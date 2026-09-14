import { create } from 'zustand';

/**
 * Client-only state. The server owns everything else — orders, masters,
 * services — and that lives in TanStack Query
 * (docs/architecture/frontend-architecture.md).
 *
 * The active role is a UI preference, not an authorisation decision. The API
 * re-checks the caller's role on every request (CLAUDE.md §11).
 */
export type AppRole = 'customer' | 'master';

export interface SessionState {
  role: AppRole;
  setRole: (role: AppRole) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  role: 'customer',
  setRole: (role) => {
    set({ role });
  },
}));
