import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { App } from '../src/App';

/**
 * Renders the whole panel — real store, real router, real base query — at
 * `url`, exactly as a browser tab would open it. Only `fetch` is fake.
 */
export function renderApp(url: string) {
  window.history.replaceState(null, '', url);
  const user = userEvent.setup();
  const utils = render(<App />);
  return { user, ...utils };
}
