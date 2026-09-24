import type { ReactNode } from 'react';

/** The heading and body every page in the shell's content area starts from. */
export function PageFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-h1 font-bold text-text">{title}</h1>
      {children}
    </section>
  );
}
