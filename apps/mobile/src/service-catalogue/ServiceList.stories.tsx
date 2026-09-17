import type { Meta, StoryObj } from '@storybook/react-native-web-vite';

import { ServiceList } from './ServiceList';

/** Sample rows for the workshop. The app holds no service list of its own. */
const meta = {
  title: 'Catalogue/ServiceList',
  component: ServiceList,
  args: {
    services: [
      {
        id: 'svc-1',
        categoryId: 'cat-1',
        slug: 'leak-repair',
        name: 'Su sızmasının aradan qaldırılması',
        pricing: { kind: 'fixed', amountMinor: 2500, currency: 'AZN' },
        displayOrder: 0,
      },
      {
        id: 'svc-2',
        categoryId: 'cat-1',
        slug: 'drain-unblocking',
        name: 'Kanalizasiya tıxacının açılması',
        pricing: { kind: 'fixed', amountMinor: 3000, currency: 'AZN' },
        displayOrder: 1,
      },
      {
        id: 'svc-3',
        categoryId: 'cat-1',
        slug: 'water-heater-repair',
        name: 'Su qızdırıcısının təmiri',
        pricing: { kind: 'inspection' },
        displayOrder: 2,
      },
    ],
    onSelect: () => undefined,
  },
} satisfies Meta<typeof ServiceList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const OnlyInspectionPriced: Story = {
  args: {
    services: [
      {
        id: 'svc-3',
        categoryId: 'cat-5',
        slug: 'washing-machine-repair',
        name: 'Paltaryuyan maşının təmiri',
        pricing: { kind: 'inspection' },
        displayOrder: 0,
      },
    ],
  },
};
