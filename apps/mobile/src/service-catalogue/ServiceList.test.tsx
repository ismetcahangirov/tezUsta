import type { Service } from '@tezusta/types';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { formatServicePrice } from './format-service-price';
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

describe('ServiceList', () => {
  it('renders the services the API returned', async () => {
    await render(<ServiceList services={[FIXED, INSPECTION]} onSelect={jest.fn()} />);

    expect(screen.getByText('Su sızması')).toBeOnTheScreen();
    expect(screen.getByText('Su qızdırıcısı')).toBeOnTheScreen();
  });

  it('shows a fixed price as a reference figure', async () => {
    await render(<ServiceList services={[FIXED]} onSelect={jest.fn()} />);

    expect(screen.getByText(formatServicePrice(FIXED.pricing))).toBeOnTheScreen();
  });

  it('says the price follows the visit for an inspection-priced service', async () => {
    await render(<ServiceList services={[INSPECTION]} onSelect={jest.fn()} />);

    expect(screen.getByText(copy.priceAfterInspection)).toBeOnTheScreen();
  });

  it('renders the two pricing shapes differently, not as the same blank', async () => {
    await render(<ServiceList services={[FIXED, INSPECTION]} onSelect={jest.fn()} />);

    expect(screen.getByText(copy.priceAfterInspection)).toBeOnTheScreen();
    expect(screen.getByText(formatServicePrice(FIXED.pricing))).toBeOnTheScreen();
  });

  it('hands back the whole service when a row is pressed', async () => {
    const onSelect = jest.fn();
    await render(<ServiceList services={[FIXED, INSPECTION]} onSelect={onSelect} />);

    await fireEvent.press(screen.getByRole('button', { name: 'Su qızdırıcısı' }));

    expect(onSelect).toHaveBeenCalledWith(INSPECTION);
  });
});
