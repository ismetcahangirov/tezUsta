import type { Address } from '@tezusta/types';
import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { Provider } from 'react-redux';

import { createAppStore } from '../store';
import { AddressForm } from './AddressForm';

/**
 * `AddressForm` calls `useForwardGeocodeMutation`, so every story needs a
 * real store underneath it — the same reason `ServiceCatalogue`'s stories
 * would, had it needed one. No transport is installed: the "find address"
 * button is present to look at, not to press, inside Storybook.
 */
const meta = {
  title: 'Addresses/AddressForm',
  component: AddressForm,
  decorators: [
    (Story) => (
      <Provider store={createAppStore()}>
        <Story />
      </Provider>
    ),
  ],
  args: {
    mode: 'add',
    submitting: false,
    onSubmit: () => undefined,
    onCancel: () => undefined,
  },
} satisfies Meta<typeof AddressForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Add: Story = {};

const EXISTING: Address = {
  id: 'addr-1',
  label: 'Ev',
  formattedAddress: 'Nizami küçəsi 203',
  building: '12B',
  entrance: '2',
  floor: '5',
  apartment: '48',
  landmarkNote: 'Marketin yanı',
  latitude: 40.377,
  longitude: 49.892,
  isDefault: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

export const Edit: Story = {
  args: { mode: 'edit', initial: EXISTING },
};

export const FieldError: Story = {
  args: {
    error: {
      status: 422,
      data: {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Validation failed.',
          requestId: 'req-1',
          details: { issues: [{ path: 'building', message: 'Çox uzundur.' }] },
        },
      },
    },
  },
};

export const TooManyAddresses: Story = {
  args: {
    error: {
      status: 409,
      data: { error: { code: 'CONFLICT', message: 'x', requestId: 'req-1' } },
    },
  },
};
