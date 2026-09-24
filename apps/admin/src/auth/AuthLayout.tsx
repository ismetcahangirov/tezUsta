import type { ReactNode } from 'react';

import { copy } from '../copy';

/** The centred card the sign-in and setup pages share. */
export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-start justify-center bg-bg px-6 py-12">
      <div className="flex w-full max-w-md flex-col gap-6 rounded-md bg-surface p-8">
        <p className="text-caption font-bold text-text-muted">{copy.appName}</p>
        <h1 className="text-h1 font-bold text-text">{title}</h1>
        {children}
      </div>
    </main>
  );
}
