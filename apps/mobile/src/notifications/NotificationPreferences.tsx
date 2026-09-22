import type { NotificationPreferenceUpdate } from '@tezusta/types';
import { View } from 'react-native';

import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { Text } from '../components/Text';
import {
  useGetNotificationPreferencesQuery,
  useSetNotificationPreferencesMutation,
} from './notification-preferences-endpoints';
import { notificationsCopy } from './notifications-copy';
import { PreferenceList, type PreferenceChoice } from './PreferenceList';
import { useOsNotificationPermission } from './useOsNotificationPermission';

const copy = notificationsCopy.preferences;

/**
 * Which notifications this user receives, from settings.
 *
 * **The server owns the list and the rule.** Every category rendered here came
 * from `GET /notification-preferences`, including whether it may be switched
 * off at all — there is no category named anywhere in this app's source, and a
 * `no-hardcoded-catalogue`-shaped drift is therefore impossible by
 * construction. A category the server adds appears on the next fetch, under
 * its own key until somebody writes it a name.
 *
 * The rows themselves are `PreferenceList`, which holds no server state and
 * has the story (ADR-0012). This file is the query, the write and the three
 * things that can go wrong around them.
 *
 * **Every string here is a placeholder** (`notifications-copy.ts`). The
 * arrangement and the wording are the owner's (CLAUDE.md §17).
 */
export function NotificationPreferences(): React.JSX.Element {
  const preferences = useGetNotificationPreferencesQuery();
  const [save, saveResult] = useSetNotificationPreferencesMutation();
  const { permission, openSystemSettings } = useOsNotificationPermission();

  const current = preferences.currentData;

  function choose(category: string, choice: PreferenceChoice): void {
    if (current === undefined) {
      return;
    }

    // The whole set, every time. `PUT` means the body *is* the state, so
    // sending one category would silently return the other four to their
    // defaults.
    const next: NotificationPreferenceUpdate[] = current.map((entry) => ({
      category: entry.category,
      enabled: entry.category === category ? choice === 'on' : entry.enabled,
    }));

    void save({ preferences: next });
  }

  if (current === undefined) {
    if (preferences.error === undefined) {
      return (
        <View className="gap-3">
          <Skeleton className="h-control-md w-full" />
          <Skeleton className="h-control-md w-full" />
        </View>
      );
    }

    return (
      <EmptyState
        title={copy.loadFailed}
        action={
          <Button
            label={copy.retry}
            variant="secondary"
            onPress={() => {
              void preferences.refetch();
            }}
          />
        }
      />
    );
  }

  return (
    <View className="gap-3">
      <Text variant="caption" tone="muted">
        {copy.sectionTitle}
      </Text>

      {permission === 'blocked' && (
        // Above the list rather than replacing it: the stored preferences are
        // still real and still worth seeing, they just cannot reach the user
        // while the operating system is refusing everything.
        <Banner
          message={copy.osBlocked}
          action={
            <Button
              label={copy.openSystemSettings}
              variant="secondary"
              onPress={openSystemSettings}
            />
          }
        />
      )}

      {saveResult.isError && <Banner tone="danger" message={copy.saveFailed} />}

      <PreferenceList preferences={current} busy={saveResult.isLoading} onChoose={choose} />
    </View>
  );
}
