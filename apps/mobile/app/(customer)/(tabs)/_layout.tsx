import { Tabs } from 'expo-router';

import { ClockIcon, WrenchIcon } from '../../../src/components';
import { ORDERS_COPY } from '../../../src/orders';
import { SERVICE_CATALOGUE_COPY } from '../../../src/service-catalogue';
import { typography, useTheme } from '../../../src/theme';

/**
 * The customer's root: two tabs
 * ([ADR-0030](../../../../docs/decisions/ADR-0030-customer-root-navigation-and-order-list.md),
 * issue #160).
 *
 * **A tab is a place you return to; a stack screen is a place you came from.**
 * That is the whole reason this group exists: order creation, one order and
 * saved addresses stay outside it, in the stack `(customer)/_layout.tsx` owns,
 * and push *over* the bar rather than becoming destinations of their own.
 *
 * The group is invisible in a path, so nothing that navigates to `/(customer)`
 * had to change — it resolves to this navigator's first tab.
 *
 * **The active tint is `text`, never `accent`**, and that is the design system
 * rather than a preference: lime on a light surface is 1.2:1
 * (`docs/design/design-system.md` § 3), so on the light theme it is a surface
 * colour and never type or an icon. An active tab is full-contrast text and an
 * inactive one is muted — the same distinction in both schemes.
 *
 * Values come from the tokens rather than from classes, because a navigator
 * option is one of the few places a NativeWind class cannot reach (§ 10.2).
 * That includes the label's typeface: left alone, a tab bar is the one surface
 * in the app that would render in the system font.
 */
export default function CustomerTabsLayout(): React.JSX.Element {
  const { colors } = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors['text-muted'],
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarLabelStyle: {
          fontFamily: typography.family.regular,
          fontSize: typography.scale.footnote.size,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: SERVICE_CATALOGUE_COPY.tab,
          // `tone`, not the `color` the navigator offers: an icon's colour is a
          // token in this app, and the two tints above are the same two roles.
          tabBarIcon: ({ focused }) => <WrenchIcon tone={focused ? 'text' : 'text-muted'} />,
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: ORDERS_COPY.list.tab,
          tabBarIcon: ({ focused }) => <ClockIcon tone={focused ? 'text' : 'text-muted'} />,
        }}
      />
    </Tabs>
  );
}
