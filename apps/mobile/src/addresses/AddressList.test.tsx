import type { Address } from '@tezusta/types';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { AddressList } from './AddressList';

function address(overrides: Partial<Address> = {}): Address {
  return {
    id: 'addr-1',
    label: null,
    formattedAddress: 'Nizami küçəsi 203',
    building: null,
    entrance: null,
    floor: null,
    apartment: null,
    landmarkNote: null,
    latitude: 40.377,
    longitude: 49.892,
    isDefault: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const HOME: Address = address({
  id: 'addr-1',
  label: 'Ev',
  building: '12B',
  entrance: '2',
  isDefault: true,
});
const OFFICE: Address = address({
  id: 'addr-2',
  label: null,
  formattedAddress: 'Rəşid Behbudov küçəsi 5',
  isDefault: false,
});

describe('AddressList', () => {
  it('renders every address the API returned, default first as given', async () => {
    await render(
      <AddressList
        addresses={[HOME, OFFICE]}
        onEdit={jest.fn()}
        onDelete={jest.fn()}
        onSetDefault={jest.fn()}
      />,
    );

    const rows = screen.getAllByText(/^(Ev|Rəşid Behbudov küçəsi 5)$/);
    expect(rows.map((row) => String(row.props.children))).toEqual([
      'Ev',
      'Rəşid Behbudov küçəsi 5',
    ]);
  });

  it('shows the default badge on the default address and no "make default" action for it', async () => {
    await render(
      <AddressList
        addresses={[HOME]}
        onEdit={jest.fn()}
        onDelete={jest.fn()}
        onSetDefault={jest.fn()}
      />,
    );

    expect(screen.getByText('Defolt')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Ev ünvanını defolt et' })).not.toBeOnTheScreen();
  });

  it('offers a "make default" action on a non-default address, and hands back the whole address', async () => {
    const onSetDefault = jest.fn();
    await render(
      <AddressList
        addresses={[OFFICE]}
        onEdit={jest.fn()}
        onDelete={jest.fn()}
        onSetDefault={onSetDefault}
      />,
    );

    await fireEvent.press(
      screen.getByRole('button', { name: 'Rəşid Behbudov küçəsi 5 ünvanını defolt et' }),
    );

    expect(onSetDefault).toHaveBeenCalledWith(OFFICE);
  });

  it('hands the whole address to edit and delete', async () => {
    const onEdit = jest.fn();
    const onDelete = jest.fn();
    await render(
      <AddressList
        addresses={[HOME]}
        onEdit={onEdit}
        onDelete={onDelete}
        onSetDefault={jest.fn()}
      />,
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Ev ünvanını redaktə et' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Ev ünvanını sil' }));

    expect(onEdit).toHaveBeenCalledWith(HOME);
    expect(onDelete).toHaveBeenCalledWith(HOME);
  });

  it('disables a busy row’s own actions without touching another row', async () => {
    await render(
      <AddressList
        addresses={[HOME, OFFICE]}
        busyId={OFFICE.id}
        onEdit={jest.fn()}
        onDelete={jest.fn()}
        onSetDefault={jest.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Rəşid Behbudov küçəsi 5 ünvanını sil' }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ev ünvanını sil' })).not.toBeDisabled();
  });

  it('renders the Baku addressing detail under the title', async () => {
    await render(
      <AddressList
        addresses={[HOME]}
        onEdit={jest.fn()}
        onDelete={jest.fn()}
        onSetDefault={jest.fn()}
      />,
    );

    expect(screen.getByText(/bina 12B, giriş 2/)).toBeOnTheScreen();
  });

  it('renders nothing at all with no addresses', async () => {
    await render(
      <AddressList
        addresses={[]}
        onEdit={jest.fn()}
        onDelete={jest.fn()}
        onSetDefault={jest.fn()}
      />,
    );

    expect(screen.queryByRole('button')).not.toBeOnTheScreen();
  });
});
