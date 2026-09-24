import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  // A file may opt into the node environment, where there is no DOM to reset.
  if (typeof window === 'undefined') return;
  cleanup();
  window.history.replaceState(null, '', '/');
});
