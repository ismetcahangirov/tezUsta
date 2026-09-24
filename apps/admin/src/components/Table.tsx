import type { ReactNode } from 'react';

/** Header and body cell classes, so every dense table in the panel reads alike. */
export const TH_CLASS =
  'border-b-hairline border-border px-4 py-2 text-left text-caption font-bold text-text-muted';
export const TD_CLASS = 'border-b-hairline border-border px-4 py-2 align-top text-body text-text';

/**
 * A dense table on a `surface` card (ADR-0043 § 8). The caller writes the
 * `thead` and `tbody`; the caption names the table for assistive technology.
 */
export function Table({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md border-hairline border-border bg-surface">
      <table className="w-full border-collapse">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}
