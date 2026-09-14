import type { Meta, StoryObj } from '@storybook/react-native-web-vite';

import { Text } from './Text';

const meta = {
  title: 'Components/Text',
  component: Text,
  args: {
    children: 'Usta 8 dəqiqəyə çatır',
    variant: 'body',
    tone: 'default',
  },
  argTypes: {
    variant: {
      control: 'select',
      options: ['display', 'h1', 'h2', 'body', 'body-strong', 'caption', 'footnote'],
    },
    tone: {
      control: 'select',
      options: ['default', 'muted', 'danger', 'accent', 'on-inverse', 'on-accent', 'on-danger'],
    },
  },
} satisfies Meta<typeof Text>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};
