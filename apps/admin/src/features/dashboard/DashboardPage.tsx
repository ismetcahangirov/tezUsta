import type { AdminDashboard, AdminDashboardCell } from '@tezusta/types';
import { type ReactNode, useState } from 'react';

import { describeFailure } from '../../api/api-error';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { SelectField } from '../../components/SelectField';
import { Table, TD_CLASS, TH_CLASS } from '../../components/Table';
import { copy } from '../../copy';
import { formatDateTime } from '../../format';
import { PageFrame } from '../../shell/PageFrame';
import { type DashboardRange, useDashboardQuery } from './api';
import { dashboardCopy } from './copy';

const HOUR_MS = 60 * 60 * 1000;

/** The ranges on offer. 90 days is the server's ceiling (`MAX_DASHBOARD_RANGE_DAYS`). */
export const RANGE_PRESETS = {
  '24h': 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
  '30d': 30 * 24 * HOUR_MS,
  '90d': 90 * 24 * HOUR_MS,
} as const;

export type RangePreset = keyof typeof RANGE_PRESETS;

const PRESET_KEYS = Object.keys(RANGE_PRESETS) as RangePreset[];

/**
 * A range ending now. Computed once per choice and kept, not per render: a
 * `to` that moved on every render would be a new query every render.
 */
export function rangeEndingNow(preset: RangePreset, now = new Date()): DashboardRange {
  return {
    from: new Date(now.getTime() - RANGE_PRESETS[preset]).toISOString(),
    to: now.toISOString(),
  };
}

const PERCENT = new Intl.NumberFormat('en-GB', { style: 'percent', maximumFractionDigits: 1 });

/** A rate as the API sends it — a fraction of `created`, null when nothing was created. */
export function formatRate(rate: number | null): string | undefined {
  return rate === null ? undefined : PERCENT.format(rate);
}

/** How long ago `iso` was, coarsely: days and hours, or hours and minutes. */
export function formatAge(iso: string, now = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return dashboardCopy.age.days(days, hours % 24);
  if (hours > 0) return dashboardCopy.age.hours(hours, minutes % 60);
  return dashboardCopy.age.minutes(minutes);
}

/**
 * A grid cell's centre to three decimals (≈ 100 m) — the cell is 0.02°, so
 * more digits would only suggest a precision the grouping does not have.
 */
function cellCentre(cell: AdminDashboardCell): { lat: string; lng: string } {
  return { lat: cell.lat.toFixed(3), lng: cell.lng.toFixed(3) };
}

export function googleMapsUrl(cell: AdminDashboardCell): string {
  const { lat, lng } = cellCentre(cell);
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

/**
 * The operational dashboard (ADR-0043 § 7, `admin-flow.md` § 6): KPI tiles
 * over a chosen range, and tables — deliberately not charts — for where the
 * supply gaps are. Counts only; nothing here names a person or an address.
 */
export function DashboardPage() {
  const [preset, setPreset] = useState<RangePreset>('7d');
  const [range, setRange] = useState(() => rangeEndingNow('7d'));
  const { data, error, isFetching, refetch } = useDashboardQuery(range);
  const failure = describeFailure(error);

  function choose(next: RangePreset) {
    setPreset(next);
    setRange(rangeEndingNow(next));
  }

  return (
    <PageFrame title={copy.nav.dashboard}>
      <div className="flex items-end justify-between gap-4">
        <p className="max-w-3xl text-body text-text-muted">{dashboardCopy.intro}</p>
        <div className="flex items-end gap-2">
          <SelectField
            label={dashboardCopy.rangeLabel}
            value={preset}
            options={PRESET_KEYS.map((key) => ({ value: key, label: dashboardCopy.presets[key] }))}
            onChange={(event) => {
              choose(event.target.value as RangePreset);
            }}
          />
          <Button
            label={dashboardCopy.refresh}
            variant="secondary"
            loading={isFetching}
            onClick={() => {
              setRange(rangeEndingNow(preset));
            }}
          />
        </div>
      </div>
      <p className="text-caption text-text-muted">
        {dashboardCopy.rangeShown(formatDateTime(range.from), formatDateTime(range.to))}
      </p>

      {data === undefined ? (
        failure === undefined ? (
          <p role="status" className="text-body text-text-muted">
            {dashboardCopy.loading}
          </p>
        ) : (
          <div className="flex flex-col items-start gap-3">
            <Banner
              tone="danger"
              message={
                failure.status === 422 ? dashboardCopy.rangeRefused : dashboardCopy.loadFailed
              }
            />
            <Button
              label={dashboardCopy.retry}
              variant="secondary"
              onClick={() => void refetch()}
            />
          </div>
        )
      ) : (
        <DashboardBody dashboard={data} />
      )}
    </PageFrame>
  );
}

function DashboardBody({ dashboard }: { dashboard: AdminDashboard }) {
  const { orders, openDisputes, mastersAvailable } = dashboard;
  const text = dashboardCopy.tiles;
  const rateNote = (rate: number | null) => {
    const shown = formatRate(rate);
    return shown === undefined ? text.noRate : text.rate(shown);
  };

  return (
    <>
      <ul aria-label={dashboardCopy.keyFigures} className="grid grid-cols-4 gap-4">
        <Tile label={text.created} value={orders.created} />
        <Tile label={text.filled} value={orders.filled} note={rateNote(orders.fillRate)} />
        <Tile label={text.unfilled} value={orders.unfilled} note={rateNote(orders.unfilledRate)} />
        <Tile
          label={text.cancelled}
          value={orders.cancelled}
          note={rateNote(orders.cancellationRate)}
        />
        <Tile
          label={text.cancelledAfterAccept}
          value={orders.cancelledAfterAccept}
          note={text.cancelledAfterAcceptNote}
        />
        <Tile label={text.searching} value={orders.searching} note={text.searchingNote} />
        <Tile
          label={text.openDisputes}
          value={openDisputes.count}
          note={
            openDisputes.oldestDisputedAt === null
              ? text.noDisputes
              : text.oldest(formatAge(openDisputes.oldestDisputedAt))
          }
        />
        <Tile
          label={text.mastersAvailable}
          value={mastersAvailable.total}
          note={text.mastersAvailableNote}
        />
      </ul>

      <p className="rounded-sm bg-surface-alt px-4 py-3 text-caption text-text">
        {dashboardCopy.unfilledNote}
      </p>

      <div className="grid grid-cols-2 gap-4">
        <CountTable
          caption={dashboardCopy.tables.unfilledByCategory}
          keyHeader={dashboardCopy.tables.category}
          rows={dashboard.unfilledByCategory.map((row) => ({
            key: row.categoryId,
            label: row.categoryName,
            count: row.count,
          }))}
        />
        <CountTable
          caption={dashboardCopy.tables.cancelledBy}
          keyHeader={dashboardCopy.tables.cancelledByWhom}
          rows={orders.cancelledBy.map((row) => ({
            key: row.actorKind,
            label: dashboardCopy.actors[row.actorKind] ?? row.actorKind,
            count: row.count,
          }))}
        />
        <AreaTable caption={dashboardCopy.tables.unfilledByArea} cells={dashboard.unfilledByArea} />
        <AreaTable caption={dashboardCopy.tables.mastersByArea} cells={mastersAvailable.byArea} />
      </div>
      <p className="text-footnote text-text-muted">
        {dashboardCopy.tables.areaNote(String(dashboard.cellDegrees))}
      </p>
    </>
  );
}

function Tile({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <li className="flex flex-col gap-1 rounded-md border-hairline border-border bg-surface p-4">
      <span className="text-caption text-text-muted">{label}</span>
      <span className="text-display font-bold text-text">{value}</span>
      {note !== undefined && <span className="text-footnote text-text-muted">{note}</span>}
    </li>
  );
}

function Section({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-body-strong font-bold text-text">{caption}</h2>
      {children}
    </section>
  );
}

function CountTable({
  caption,
  keyHeader,
  rows,
}: {
  caption: string;
  keyHeader: string;
  rows: readonly { key: string; label: string; count: number }[];
}) {
  return (
    <Section caption={caption}>
      {rows.length === 0 ? (
        <p className="text-caption text-text-muted">{dashboardCopy.tables.none}</p>
      ) : (
        <Table caption={caption}>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASS}>
                {keyHeader}
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                {dashboardCopy.tables.count}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td className={TD_CLASS}>{row.label}</td>
                <td className={`${TD_CLASS} text-right`}>{row.count}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Section>
  );
}

function AreaTable({ caption, cells }: { caption: string; cells: readonly AdminDashboardCell[] }) {
  return (
    <Section caption={caption}>
      {cells.length === 0 ? (
        <p className="text-caption text-text-muted">{dashboardCopy.tables.none}</p>
      ) : (
        <Table caption={caption}>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASS}>
                {dashboardCopy.tables.area}
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                {dashboardCopy.tables.count}
              </th>
              <th scope="col" className={TH_CLASS}>
                {dashboardCopy.tables.map}
              </th>
            </tr>
          </thead>
          <tbody>
            {cells.map((cell) => {
              const { lat, lng } = cellCentre(cell);
              return (
                <tr key={`${lat},${lng}`}>
                  <td className={TD_CLASS}>{`${lat}, ${lng}`}</td>
                  <td className={`${TD_CLASS} text-right`}>{cell.count}</td>
                  <td className={TD_CLASS}>
                    <a
                      href={googleMapsUrl(cell)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-text underline outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      {dashboardCopy.tables.openInMaps}
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Section>
  );
}
