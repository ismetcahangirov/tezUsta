import { useState } from 'react';
import { Provider } from 'react-redux';
import { BrowserRouter, Route, Routes } from 'react-router';

import { SetupPage } from './auth/SetupPage';
import { SignInPage } from './auth/SignInPage';
import { copy } from './copy';
import { NAVIGATION, type NavigationItem } from './shell/navigation';
import { PageFrame } from './shell/PageFrame';
import { PlaceholderPage } from './shell/PlaceholderPage';
import { RequirePermission } from './shell/RequirePermission';
import { Shell, useSignedInAdmin } from './shell/Shell';
import { createStore } from './store';

function Section({ item }: { item: NavigationItem }) {
  const me = useSignedInAdmin();
  return (
    <RequirePermission permission={item.permission} granted={me.permissions}>
      <PlaceholderPage title={item.label} issue={item.issue} />
    </RequirePermission>
  );
}

function NotFound() {
  return <PageFrame title={copy.shell.notFoundTitle}>{null}</PageFrame>;
}

/** Sign-in and setup stand alone; every other path is inside the authenticated shell. */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignInPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route element={<Shell />}>
        {NAVIGATION.map((item) =>
          item.path === '/' ? (
            <Route key={item.path} index element={<Section item={item} />} />
          ) : (
            <Route key={item.path} path={item.path} element={<Section item={item} />} />
          ),
        )}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

export function App() {
  const [store] = useState(createStore);
  return (
    <Provider store={store}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </Provider>
  );
}
