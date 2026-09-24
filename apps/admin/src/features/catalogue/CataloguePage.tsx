import type { AdminCatalogueCategory, AdminCatalogueService } from '@tezusta/types';
import { useState } from 'react';

import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { copy } from '../../copy';
import { PageFrame } from '../../shell/PageFrame';
import {
  useCatalogueQuery,
  useReorderCategoriesMutation,
  useReorderServicesMutation,
  useUpdateCategoryMutation,
  useUpdateServiceMutation,
} from './api';
import { CategoryForm } from './CategoryForm';
import { catalogueCopy } from './copy';
import { azName } from './form-support';
import { formatAzn } from './money';
import { ServiceForm } from './ServiceForm';

type Editing =
  | { readonly kind: 'category'; readonly category?: AdminCatalogueCategory }
  | {
      readonly kind: 'service';
      readonly categoryId: string;
      readonly service?: AdminCatalogueService;
    };

function byDisplayOrder<T extends { readonly displayOrder: number }>(items: readonly T[]): T[] {
  // `sort` is stable, so equal orders keep the server's sequence.
  return [...items].sort((a, b) => a.displayOrder - b.displayOrder);
}

/** `ids` with the item at `index` swapped with its neighbour `delta` away. */
function moved(ids: readonly string[], index: number, delta: -1 | 1): string[] {
  const next = [...ids];
  const target = index + delta;
  const a = next[index];
  const b = next[target];
  if (a === undefined || b === undefined) return next;
  next[index] = b;
  next[target] = a;
  return next;
}

/**
 * The catalogue editor (#250): every category in order, each with its
 * services, inactive ones shown and marked. Reordering sends the whole new
 * permutation — the API accepts nothing less, so two admins cannot each move
 * one row and leave an order neither of them chose.
 */
export function CataloguePage() {
  const { data, error, isLoading, refetch } = useCatalogueQuery();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [reorderCategories, categoryReorder] = useReorderCategoriesMutation();
  const [reorderServices, serviceReorder] = useReorderServicesMutation();
  const [updateCategory] = useUpdateCategoryMutation();
  const [updateService] = useUpdateServiceMutation();
  const [actionFailed, setActionFailed] = useState(false);
  const reordering = categoryReorder.isLoading || serviceReorder.isLoading;

  async function run(action: Promise<{ error?: unknown }>) {
    setActionFailed(false);
    const result = await action;
    if (result.error !== undefined) setActionFailed(true);
  }

  const categories = byDisplayOrder(data?.categories ?? []);

  return (
    <PageFrame title={copy.nav.catalogue}>
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-3xl text-body text-text-muted">{catalogueCopy.intro}</p>
        <Button
          label={catalogueCopy.newCategory}
          variant="accent"
          onClick={() => {
            setEditing({ kind: 'category' });
          }}
        />
      </div>

      {actionFailed && <Banner tone="danger" message={catalogueCopy.actionFailed} />}

      {data === undefined ? (
        isLoading || error === undefined ? (
          <p role="status" className="text-body text-text-muted">
            {catalogueCopy.loading}
          </p>
        ) : (
          <div className="flex flex-col items-start gap-3">
            <Banner tone="danger" message={catalogueCopy.loadFailed} />
            <Button
              label={catalogueCopy.retry}
              variant="secondary"
              onClick={() => void refetch()}
            />
          </div>
        )
      ) : categories.length === 0 ? (
        <p className="text-body text-text-muted">{catalogueCopy.empty}</p>
      ) : (
        categories.map((category, index) => (
          <CategorySection
            key={category.id}
            category={category}
            isFirst={index === 0}
            isLast={index === categories.length - 1}
            reordering={reordering}
            onMove={(delta) =>
              void run(
                reorderCategories(
                  moved(
                    categories.map((c) => c.id),
                    index,
                    delta,
                  ),
                ),
              )
            }
            onEdit={() => {
              setEditing({ kind: 'category', category });
            }}
            onToggle={() =>
              void run(updateCategory({ id: category.id, patch: { isActive: !category.isActive } }))
            }
            onAddService={() => {
              setEditing({ kind: 'service', categoryId: category.id });
            }}
            onEditService={(service) => {
              setEditing({ kind: 'service', categoryId: category.id, service });
            }}
            onToggleService={(service) =>
              void run(updateService({ id: service.id, patch: { isActive: !service.isActive } }))
            }
            onMoveService={(ids) => void run(reorderServices({ categoryId: category.id, ids }))}
          />
        ))
      )}

      {editing?.kind === 'category' && (
        <CategoryForm
          {...(editing.category === undefined ? {} : { category: editing.category })}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
      {editing?.kind === 'service' && (
        <ServiceForm
          categories={categories}
          categoryId={editing.categoryId}
          {...(editing.service === undefined ? {} : { service: editing.service })}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
    </PageFrame>
  );
}

interface CategorySectionProps {
  category: AdminCatalogueCategory;
  isFirst: boolean;
  isLast: boolean;
  reordering: boolean;
  onMove: (delta: -1 | 1) => void;
  onEdit: () => void;
  onToggle: () => void;
  onAddService: () => void;
  onEditService: (service: AdminCatalogueService) => void;
  onToggleService: (service: AdminCatalogueService) => void;
  onMoveService: (ids: string[]) => void;
}

function CategorySection({
  category,
  isFirst,
  isLast,
  reordering,
  onMove,
  onEdit,
  onToggle,
  onAddService,
  onEditService,
  onToggleService,
  onMoveService,
}: CategorySectionProps) {
  const services = byDisplayOrder(category.services);
  const name = azName(category.name);

  return (
    <section
      aria-label={name}
      className={`flex flex-col gap-3 rounded-md border-hairline border-border bg-surface p-4 ${category.isActive ? '' : 'border-dashed'}`}
    >
      <div className="flex items-center gap-3">
        <MoveButtons
          name={name}
          isFirst={isFirst}
          isLast={isLast}
          disabled={reordering}
          onMove={onMove}
        />
        <div className="flex flex-1 flex-col">
          <h2
            className={`text-h2 font-bold ${category.isActive ? 'text-text' : 'text-text-muted'}`}
          >
            {name}
          </h2>
          <OtherNames name={category.name} slug={category.slug} />
        </div>
        <StatusBadge active={category.isActive} />
        <Button label={catalogueCopy.edit} variant="secondary" onClick={onEdit} />
        <Button
          label={category.isActive ? catalogueCopy.deactivate : catalogueCopy.activate}
          variant="secondary"
          onClick={onToggle}
        />
        <Button label={catalogueCopy.newService} variant="primary" onClick={onAddService} />
      </div>

      {services.length === 0 ? (
        <p className="text-caption text-text-muted">{catalogueCopy.noServices}</p>
      ) : (
        <table className="w-full border-collapse text-left text-body">
          <thead>
            <tr className="border-b-hairline border-border text-caption text-text-muted">
              <th scope="col" className="w-avatar-lg py-2 font-regular">
                <span className="sr-only">{catalogueCopy.columns.actions}</span>
              </th>
              <th scope="col" className="py-2 font-regular">
                {catalogueCopy.columns.name}
              </th>
              <th scope="col" className="py-2 font-regular">
                {catalogueCopy.columns.pricing}
              </th>
              <th scope="col" className="py-2 font-regular">
                {catalogueCopy.columns.price}
              </th>
              <th scope="col" className="py-2 font-regular">
                {catalogueCopy.columns.status}
              </th>
              <th scope="col" className="py-2 font-regular">
                <span className="sr-only">{catalogueCopy.columns.actions}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {services.map((service, index) => (
              <tr
                key={service.id}
                className={`border-b-hairline border-border last:border-b-0 ${service.isActive ? 'text-text' : 'text-text-muted'}`}
              >
                <td className="py-2">
                  <MoveButtons
                    name={azName(service.name)}
                    isFirst={index === 0}
                    isLast={index === services.length - 1}
                    disabled={reordering}
                    onMove={(delta) => {
                      onMoveService(
                        moved(
                          services.map((s) => s.id),
                          index,
                          delta,
                        ),
                      );
                    }}
                  />
                </td>
                <td className="py-2">
                  <span className="text-body-strong font-bold">{azName(service.name)}</span>
                  <OtherNames name={service.name} slug={service.slug} />
                </td>
                <td className="py-2">{catalogueCopy.pricing[service.pricingKind]}</td>
                <td className="py-2">
                  {service.basePriceMinor === null
                    ? catalogueCopy.noPrice
                    : formatAzn(service.basePriceMinor)}
                </td>
                <td className="py-2">
                  <StatusBadge active={service.isActive} />
                </td>
                <td className="py-2">
                  <div className="flex justify-end gap-2">
                    <Button
                      label={catalogueCopy.edit}
                      variant="secondary"
                      aria-label={`${catalogueCopy.edit} ${azName(service.name)}`}
                      onClick={() => {
                        onEditService(service);
                      }}
                    />
                    <Button
                      label={service.isActive ? catalogueCopy.deactivate : catalogueCopy.activate}
                      variant="secondary"
                      aria-label={`${service.isActive ? catalogueCopy.deactivate : catalogueCopy.activate} ${azName(service.name)}`}
                      onClick={() => {
                        onToggleService(service);
                      }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function MoveButtons({
  name,
  isFirst,
  isLast,
  disabled,
  onMove,
}: {
  name: string;
  isFirst: boolean;
  isLast: boolean;
  disabled: boolean;
  onMove: (delta: -1 | 1) => void;
}) {
  return (
    <div className="flex gap-1">
      <button
        type="button"
        aria-label={catalogueCopy.moveUp(name)}
        disabled={isFirst || disabled}
        className="h-avatar-sm w-avatar-sm rounded-full text-body-strong text-text outline-none focus-visible:ring-2 focus-visible:ring-focus enabled:hover:bg-surface-alt disabled:opacity-40"
        onClick={() => {
          onMove(-1);
        }}
      >
        {catalogueCopy.up}
      </button>
      <button
        type="button"
        aria-label={catalogueCopy.moveDown(name)}
        disabled={isLast || disabled}
        className="h-avatar-sm w-avatar-sm rounded-full text-body-strong text-text outline-none focus-visible:ring-2 focus-visible:ring-focus enabled:hover:bg-surface-alt disabled:opacity-40"
        onClick={() => {
          onMove(1);
        }}
      >
        {catalogueCopy.down}
      </button>
    </div>
  );
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-flex rounded-full px-3 py-1 text-footnote font-bold ${active ? 'bg-accent text-on-accent' : 'bg-surface-alt text-text-muted'}`}
    >
      {active ? catalogueCopy.active : catalogueCopy.inactive}
    </span>
  );
}

function OtherNames({ name, slug }: { name: Readonly<Record<string, string>>; slug: string }) {
  const others = Object.entries(name)
    .filter(([language]) => language !== 'az')
    .map(([language, value]) => `${language}: ${value}`);
  return (
    <span className="block text-footnote text-text-muted">{[slug, ...others].join(' · ')}</span>
  );
}
