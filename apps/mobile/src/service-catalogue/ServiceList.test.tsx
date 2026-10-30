import type { Service } from '@tezusta/types';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { SERVICE_CATALOGUE_COPY as copy } from './service-catalogue-copy';
import { ServiceList } from './ServiceList';

const FIXED: Service = {
  id: 'svc-1',
  categoryId: 'cat-1',
  slug: 'leak-repair',
  name: 'Su sızması',
  pricing: { kind: 'fixed', amountMinor: 2500, currency: 'AZN' },
  displayOrder: 0,
};

const INSPECTION: Service = {
  id: 'svc-2',
  categoryId: 'cat-1',
  slug: 'water-heater-repair',
  name: 'Su qızdırıcısı',
  pricing: { kind: 'inspection' },
  displayOrder: 1,
};

interface RenderedNode {
  props?: Record<string, unknown>;
  children?: readonly (RenderedNode | string)[] | null;
}

/** How many Lucide glyphs of one kind the rendered tree draws. */
function countGlyphs(node: unknown, glyph: string): number {
  if (node === null || typeof node !== 'object') {
    return 0;
  }
  if (Array.isArray(node)) {
    return node.reduce((sum: number, child) => sum + countGlyphs(child, glyph), 0);
  }
  const { props, children } = node as RenderedNode;
  const own = typeof props?.className === 'string' && props.className.includes(glyph) ? 1 : 0;
  return own + countGlyphs(children ?? [], glyph);
}

describe('ServiceList', () => {
  it('renders the services the API returned', async () => {
    await render(<ServiceList services={[FIXED, INSPECTION]} onSelect={jest.fn()} />);

    expect(screen.getByText('Su sızması')).toBeOnTheScreen();
    expect(screen.getByText('Su qızdırıcısı')).toBeOnTheScreen();
  });

  /**
   * Asserts what the customer can read, not that the row called the formatter
   * — `getByText(formatServicePrice(...))` would be true by construction and
   * would keep passing if the price stopped rendering at all (CLAUDE.md §13).
   */
  it('shows a fixed price as an amount the customer can read', async () => {
    await render(<ServiceList services={[FIXED]} onSelect={jest.fn()} />);

    expect(screen.getByText(/25/)).toBeOnTheScreen();
  });

  it('says the price follows the visit for an inspection-priced service', async () => {
    await render(<ServiceList services={[INSPECTION]} onSelect={jest.fn()} />);

    expect(screen.getByText(copy.priceAfterInspection)).toBeOnTheScreen();
  });

  it('renders the two pricing shapes differently, not as the same blank', async () => {
    await render(<ServiceList services={[FIXED, INSPECTION]} onSelect={jest.fn()} />);

    expect(screen.getByText(copy.priceAfterInspection)).toBeOnTheScreen();
    expect(screen.getByText(/25/)).toBeOnTheScreen();
  });

  it('does not crash the whole list when one row carries a currency Intl rejects', async () => {
    const broken = {
      ...FIXED,
      id: 'svc-3',
      name: 'Pozuq sətir',
      pricing: { kind: 'fixed', amountMinor: 900, currency: 'AZNX' },
    } as const;

    await render(<ServiceList services={[broken, INSPECTION]} onSelect={jest.fn()} />);

    expect(screen.getByText('Pozuq sətir')).toBeOnTheScreen();
    expect(screen.getByText('Su qızdırıcısı')).toBeOnTheScreen();
  });

  it('ends every row in a chevron, so a service reads as something to tap', async () => {
    await render(<ServiceList services={[FIXED, INSPECTION]} onSelect={jest.fn()} />);

    // A row with only a price on its right looks like a price list; the
    // chevron is the same one a category row carries.
    expect(countGlyphs(screen.toJSON(), 'lucide-chevron-right')).toBe(2);
  });

  it('hands back the whole service when a row is pressed', async () => {
    const onSelect = jest.fn();
    await render(<ServiceList services={[FIXED, INSPECTION]} onSelect={onSelect} />);

    await fireEvent.press(screen.getByRole('button', { name: 'Su qızdırıcısı' }));

    expect(onSelect).toHaveBeenCalledWith(INSPECTION);
  });
});
