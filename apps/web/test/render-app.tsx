import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { App } from '../src/App';
import type { ReturnTiming } from '../src/pages/ReturnPage';

/**
 * Renders the whole page — real store, real router, real base query — at
 * `url`, exactly as a browser tab would open it. Only `fetch` is fake.
 */
export function renderApp(url: string, returnTiming?: ReturnTiming) {
  window.history.replaceState(null, '', url);
  const user = userEvent.setup();
  const utils = render(returnTiming === undefined ? <App /> : <App returnTiming={returnTiming} />);
  return { user, ...utils };
}
