import type { Address } from '@tezusta/types';
import type { Meta, StoryObj } from '@storybook/react-native-web-vite';

import { AddressList } from './AddressList';

function address(overrides: Partial<Address>): Address {
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

const HOME = address({
  id: 'addr-1',
  label: 'Ev',
  building: '12B',
  entrance: '2',
  floor: '5',
  apartment: '48',
  isDefault: true,
});

const OFFICE = address({
  id: 'addr-2',
  label: 'İş',
  formattedAddress: 'Rəşid Behbudov küçəsi 5',
  landmarkNote: 'Marketin yanı',
  isDefault: false,
});

const meta = {
  title: 'Addresses/AddressList',
  component: AddressList,
  args: {
    onEdit: () => undefined,
    onDelete: () => undefined,
    onSetDefault: () => undefined,
  },
} satisfies Meta<typeof AddressList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  args: { addresses: [HOME, OFFICE] },
};

export const SingleDefault: Story = {
  args: { addresses: [HOME] },
};

export const BusyRow: Story = {
  args: { addresses: [HOME, OFFICE], busyId: OFFICE.id },
};
