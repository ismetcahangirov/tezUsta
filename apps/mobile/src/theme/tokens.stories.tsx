import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { Text } from '../components/Text';
import { colors, radius, space, type ColorRole } from './tokens';

/**
 * The palette, spacing, and radius the whole app is built from. If a value is
 * not on this page, it is not a value a component may use.
 */
const meta = {
  title: 'Design System/Tokens',
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const ROLES = Object.keys(colors.light) as ColorRole[];

function Swatch({ role }: { role: ColorRole }): React.JSX.Element {
  return (
    <View className="w-full flex-row items-center gap-4">
      <View className="h-avatar-md w-avatar-md rounded-sm border-hairline border-border bg-surface">
        <View
          className="h-full w-full rounded-sm"
          style={{ backgroundColor: colors.light[role] }}
        />
      </View>
      <View className="flex-1">
        <Text variant="body-strong">{role}</Text>
        <Text variant="caption" tone="muted">
          {`light ${colors.light[role]}  ·  dark ${colors.dark[role]}`}
        </Text>
      </View>
    </View>
  );
}

export const Colour: Story = {
  render: () => (
    <View className="gap-4">
      <Text variant="h1">Colour</Text>
      <Text tone="muted">
        Lime is a surface colour on the light theme and never type. On the inverse surface it may
        also be type.
      </Text>
      {ROLES.map((role) => (
        <Swatch key={role} role={role} />
      ))}
    </View>
  ),
};

export const Spacing: Story = {
  render: () => (
    <View className="gap-4">
      <Text variant="h1">Spacing</Text>
      {Object.entries(space).map(([step, value]) => (
        <View key={step} className="flex-row items-center gap-4">
          <View className="w-avatar-md">
            <Text variant="caption" tone="muted">{`space-${step}`}</Text>
          </View>
          <View className="h-2 bg-accent" style={{ width: value }} />
          <Text variant="caption">{`${value}`}</Text>
        </View>
      ))}
    </View>
  ),
};

export const Radius: Story = {
  render: () => (
    <View className="flex-row flex-wrap gap-4">
      {Object.entries(radius).map(([name, value]) => (
        <View key={name} className="items-center gap-2">
          <View
            className="h-avatar-lg w-avatar-lg bg-inverse-surface"
            style={{ borderRadius: value }}
          />
          <Text variant="caption" tone="muted">{`${name} · ${value}`}</Text>
        </View>
      ))}
    </View>
  ),
};
