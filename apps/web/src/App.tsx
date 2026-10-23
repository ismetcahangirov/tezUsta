import { type ReactNode, useState } from 'react';
import { Provider } from 'react-redux';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';

import { useAppSelector } from './hooks';
import { DEFAULT_RETURN_TIMING, ReturnPage, type ReturnTiming } from './pages/ReturnPage';
import { SignInPage } from './pages/SignInPage';
import { SubscriptionPage } from './pages/SubscriptionPage';
import { createStore } from './store';

/**
 * Every page needs a session, so the sign-in form takes the place of whatever
 * was asked for and gives it back once signed in. The page cannot read its
 * own cookies: it learns it is signed out when a refresh is refused.
 */
function RequireSession({ children }: { children: ReactNode }) {
  const signedOut = useAppSelector((state) => state.session.signedOut);
  return signedOut ? <SignInPage /> : children;
}

export function AppRoutes({ returnTiming }: { returnTiming: ReturnTiming }) {
  return (
    <RequireSession>
      <Routes>
        <Route index element={<SubscriptionPage />} />
        <Route path="/return" element={<ReturnPage timing={returnTiming} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </RequireSession>
  );
}

export function App({ returnTiming = DEFAULT_RETURN_TIMING }: { returnTiming?: ReturnTiming }) {
  const [store] = useState(createStore);
  return (
    <Provider store={store}>
      <BrowserRouter>
        <AppRoutes returnTiming={returnTiming} />
      </BrowserRouter>
    </Provider>
  );
}
