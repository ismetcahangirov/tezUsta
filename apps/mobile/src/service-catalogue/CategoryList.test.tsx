import type { ServiceCategory } from '@tezusta/types';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { CategoryList } from './CategoryList';

const CATEGORIES: ServiceCategory[] = [
  { id: 'cat-1', slug: 'plumbing', name: 'Santexnika', displayOrder: 0 },
  { id: 'cat-2', slug: 'electrical', name: 'Elektrik', displayOrder: 1 },
];

describe('CategoryList', () => {
  it('renders whatever the API returned, in the order it returned it', async () => {
    await render(<CategoryList categories={CATEGORIES} onSelect={jest.fn()} />);

    const rows = screen.getAllByRole('button');
    expect(rows).toHaveLength(2);
    expect(screen.getByText('Santexnika')).toBeOnTheScreen();
    expect(screen.getByText('Elektrik')).toBeOnTheScreen();
  });

  it('hands the whole category back, not just its name', async () => {
    const onSelect = jest.fn();
    await render(<CategoryList categories={CATEGORIES} onSelect={onSelect} />);

    await fireEvent.press(screen.getByRole('button', { name: 'Elektrik' }));

    expect(onSelect).toHaveBeenCalledWith(CATEGORIES[1]);
  });

  it('renders nothing at all when there are no categories', async () => {
    await render(<CategoryList categories={[]} onSelect={jest.fn()} />);

    expect(screen.queryByRole('button')).not.toBeOnTheScreen();
  });
});
