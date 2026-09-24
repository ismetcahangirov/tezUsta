import { useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { ScrollView, View } from 'react-native';

import { useSignOut, useSignOutEverywhere } from '../auth';
import { Button, Divider, SegmentedControl, Text } from '../components';
import { NotificationPreferences } from '../notifications';
import { REVIEWS_COPY } from '../reviews/reviews-copy';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import {
  roleSelected,
  selectCanSwitchRole,
  selectRole,
  type AppRole,
} from '../store/session-slice';
import { SETTINGS_COPY as copy } from './settings-copy';

const SCHEMES = [
  { value: 'light', label: copy.schemeLight },
  { value: 'dark', label: copy.schemeDark },
  { value: 'system', label: copy.schemeSystem },
] as const;

type SchemeChoice = (typeof SCHEMES)[number]['value'];

const ROLES: { value: AppRole; label: string }[] = [
  { value: 'customer', label: copy.roleCustomer },
  { value: 'master', label: copy.roleMaster },
];

/**
 * Settings, and for now the only place the session can be acted on.
 *
 * **A component rather than a route, since issue #164.** Two routes render it:
 * the customer's third tab and `(shared)/settings`, which is how a master
 * reaches it — an Expo Router tab can only name a route inside its own
 * directory, so a shared screen that is a tab for one role and a pushed screen
 * for the other has to be a component both routes call
 * ([ADR-0031](../../../../docs/decisions/ADR-0031-where-settings-is-reached-from.md)).
 * There is one implementation; what differs is the way in.
 *
 * **Where the controls on it belong is still partly open.** Role switching is
 * a navigation-level affordance in every app that has it, and nobody has
 * decided where it lives; it is here because this is the screen both roles can
 * reach, not because this is its home.
 *
 * It scrolls. On a phone holding a role switch, an appearance switch, every
 * notification category the server serves and two sign-out buttons, the last
 * of those is below the fold — and with a tab bar under it, further below
 * still. A sign-out control nobody can scroll to is not a control.
 */
export function Settings(): React.JSX.Element {
  // Kept as an object rather than destructured: `setColorScheme` is typed as a
  // method, and pulling it out detaches it from its receiver.
  const scheme = useColorScheme();
  const router = useRouter();

  const dispatch = useAppDispatch();
  const role = useAppSelector(selectRole);
  const canSwitchRole = useAppSelector(selectCanSwitchRole);

  // Both hooks retire this device from the push registry before they revoke
  // anything, which is an ordering the server requires rather than a courtesy
  // (`src/auth/useSignOut.ts`).
  const [signOut, { isSigningOut }] = useSignOut();
  const [signOutEverywhere, { isSigningOut: isSigningOutEverywhere }] = useSignOutEverywhere();
  const busy = isSigningOut || isSigningOutEverywhere;

  return (
    <ScrollView className="flex-1">
      <View className="gap-6 p-6 pb-10">
        <Text variant="h1">{copy.title}</Text>

        {canSwitchRole && (
          <View className="gap-2">
            <Text variant="caption" tone="muted">
              {copy.roleHeading}
            </Text>
            {/*
              Switching is local and instant: both roles are grants the server
              already made on this session, so there is nothing to
              re-authenticate. The guard in the root layout moves the user to
              the new role's group once the selection changes.
            */}
            <SegmentedControl
              items={ROLES}
              value={role}
              onChange={(next) => dispatch(roleSelected(next))}
            />
          </View>
        )}

        <View className="gap-2">
          <Text variant="caption" tone="muted">
            {copy.appearanceHeading}
          </Text>
          <SegmentedControl
            items={[...SCHEMES]}
            value={scheme.colorScheme ?? 'system'}
            onChange={(choice: SchemeChoice) => {
              scheme.setColorScheme(choice);
            }}
          />
        </View>

        {/*
          Addresses are customer-only (issue #90's screen lives under
          `(customer)/`) and this app has no profile screen yet — the same
          situation role switching is in above. It lands here because
          `(shared)` is the one group every role can reach, not because this
          is where it should end up; the navigation pattern is still the
          owner's to decide (CLAUDE.md §17).
        */}
        <View className="gap-2">
          <Text variant="caption" tone="muted">
            {copy.accountHeading}
          </Text>
          {role === 'customer' && (
            <Button
              label={copy.addresses}
              variant="secondary"
              fullWidth
              onPress={() => {
                router.push('/(customer)/addresses');
              }}
            />
          )}
          {/*
            Reviews about the user in the role on screen (issue #228), for
            both roles — the same "this is the screen both can reach" reason
            as everything else in this section.
          */}
          <Button
            label={REVIEWS_COPY.received.entry}
            variant="secondary"
            fullWidth
            onPress={() => {
              router.push('/(shared)/reviews');
            }}
          />
        </View>

        {/*
          Rendered inline rather than behind its own route, which is what
          issue #147 asks for: settings is where these belong. Whether it
          eventually becomes its own screen is the same open navigation
          question as everything else on this screen (CLAUDE.md §17).
        */}
        <NotificationPreferences />

        <Divider />

        <View className="gap-3">
          <Button
            label={copy.signOut}
            variant="secondary"
            fullWidth
            loading={isSigningOut}
            disabled={busy}
            onPress={() => {
              void signOut();
            }}
          />
          {/*
            Sign out everywhere is destructive in the way that matters here: it
            revokes the sessions on the user's other devices as well as this
            one. A confirmation step is the obvious guard and is deliberately
            absent — what it says and how it looks is a design decision nobody
            has made, and inventing one would be worse than leaving it visibly
            missing.
          */}
          <Button
            label={copy.signOutEverywhere}
            variant="danger"
            fullWidth
            loading={isSigningOutEverywhere}
            disabled={busy}
            onPress={() => {
              void signOutEverywhere();
            }}
          />
        </View>
      </View>
    </ScrollView>
  );
}
