import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { Text, TEXT_VARIANTS, type TextVariant } from '../components/Text';
import { typography } from './tokens';

const meta = {
  title: 'Design System/Typography',
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const SAMPLE = 'Təcili usta çağır';

export const Scale: Story = {
  render: () => (
    <View className="gap-6">
      <Text variant="h1">Anybody</Text>
      <Text tone="muted">
        Full Azerbaijani coverage, including the schwa. Weight comes from the family, not from a
        synthesised weight React Native cannot render.
      </Text>
      {TEXT_VARIANTS.map((variant: TextVariant) => {
        const step = typography.scale[variant];

        return (
          <View key={variant} className="gap-1">
            <Text variant="footnote" tone="muted">
              {`${variant} · ${step.size}/${step.lineHeight} · ${step.weight}`}
            </Text>
            <Text variant={variant}>{SAMPLE}</Text>
          </View>
        );
      })}
    </View>
  ),
};

export const Tones: Story = {
  render: () => (
    <View className="gap-4">
      <Text variant="h2">Tones</Text>
      <Text>default — body copy</Text>
      <Text tone="muted">muted — secondary detail</Text>
      <Text tone="danger">danger — a cancelled order, a failed upload</Text>
      <View className="gap-2 rounded-md bg-inverse-surface p-4">
        <Text tone="on-inverse">on-inverse — type on the dark surface</Text>
        <Text tone="accent">accent — legible here, and only here</Text>
      </View>
      <View className="rounded-md bg-accent p-4">
        <Text tone="on-accent">on-accent — type on a lime fill</Text>
      </View>
    </View>
  ),
};
