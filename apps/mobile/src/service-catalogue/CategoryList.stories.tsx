import type { Meta, StoryObj } from '@storybook/react-native-web-vite';

import { CategoryList } from './CategoryList';

/**
 * The rows here are sample data for the workshop only. The app itself holds no
 * category list — see `CategoryList`'s own comment.
 */
const meta = {
  title: 'Catalogue/CategoryList',
  component: CategoryList,
  args: {
    categories: [
      { id: 'cat-1', slug: 'plumbing', name: 'Santexnika', displayOrder: 0 },
      { id: 'cat-2', slug: 'locks', name: 'Qapı və kilid', displayOrder: 1 },
      { id: 'cat-3', slug: 'electrical', name: 'Elektrik', displayOrder: 2 },
      { id: 'cat-4', slug: 'air-conditioning', name: 'Kondisioner', displayOrder: 3 },
    ],
    onSelect: () => undefined,
  },
} satisfies Meta<typeof CategoryList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Single: Story = {
  args: { categories: [{ id: 'cat-1', slug: 'other', name: 'Digər', displayOrder: 0 }] },
};
