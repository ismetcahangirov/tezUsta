import { useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useSignOut, useSignOutEverywhere } from '../../src/auth';
import { Button, Divider, SegmentedControl, Text } from '../../src/components';
import { NotificationPreferences } from '../../src/notifications';
import { useAppDispatch, useAppSelector } from '../../src/store/hooks';
import {
  roleSelected,
  selectCanSwitchRole,
  selectRole,
  type AppRole,
} from '../../src/store/session-slice';

const SCHEMES = [
  { value: 'light', label: 'İşıqlı' },
  { value: 'dark', label: 'Qaranlıq' },
  { value: 'system', label: 'Sistem' },
] as const;

type SchemeChoice = (typeof SCHEMES)[number]['value'];

const ROLES: { value: AppRole; label: string }[] = [
  { value: 'customer', label: 'Müştəri' },
  { value: 'master', label: 'Usta' },
];

/**
 * Settings, and for now the only place the session can be acted on.
 *
 * **Where these controls belong is an open design decision.** Role switching
 * in particular is a navigation-level affordance in every app that has it, and
 * the navigation pattern is the owner's to choose (CLAUDE.md §17). They live
 * here because `(shared)` is the one group both roles can reach, not because
 * this is where they should end up.
 */
export default function SettingsScreen(): React.JSX.Element {
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
    <SafeAreaView className="flex-1 bg-bg">
      <View className="gap-6 p-6">
        <Text variant="h1">Tənzimləmələr</Text>

        {canSwitchRole && (
          <View className="gap-2">
            <Text variant="caption" tone="muted">
              Rejim
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
            Görünüş
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
        {role === 'customer' && (
          <View className="gap-2">
            <Text variant="caption" tone="muted">
              Hesab
            </Text>
            <Button
              label="Ünvanlarım"
              variant="secondary"
              fullWidth
              onPress={() => {
                router.push('/(customer)/addresses');
              }}
            />
          </View>
        )}

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
            label="Çıxış"
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
            label="Bütün cihazlardan çıx"
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
    </SafeAreaView>
  );
}
