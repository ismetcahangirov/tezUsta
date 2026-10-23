import type { ReactNode } from 'react';

import { copy } from '../copy';

/**
 * The page's single column. A placeholder layout built from the design
 * system's tokens: the arrangement is the owner's (ADR-0061, CLAUDE.md § 17).
 */
export function PageFrame({ action, children }: { action?: ReactNode; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-page flex-col gap-6 px-4 py-8">
      <header className="flex items-center justify-between">
        <img src="/wordmark.svg" alt={copy.appName} className="h-6" />
        {action}
      </header>
      <h1 className="text-h1 font-bold text-text">{copy.pageTitle}</h1>
      {children}
    </main>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-md border-hairline border-border bg-surface p-5">
      {title !== undefined && <h2 className="text-h2 font-bold text-text">{title}</h2>}
      {children}
    </section>
  );
}
