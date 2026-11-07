import { AudioSession, registerGlobals } from '@livekit/react-native';
import { useLocalSearchParams } from 'expo-router';
import { ConnectionState, Room, RoomEvent, Track } from 'livekit-client';
import { useEffect, useState } from 'react';
import { PermissionsAndroid, Platform, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  startCallForegroundService,
  stopCallForegroundService,
} from '../../modules/call-foreground-service';
import { Button, Text } from '../../src/components';

// WebRTC's globals for `livekit-client` (the SDK's README). Module scope, so
// it runs once and only when this route is first loaded.
registerGlobals();

/**
 * **Spike harness for #183, development builds only.** Joins the LiveKit room
 * a deep link names (`tezusta://livekit-spike?url=…&token=…`), publishes the
 * microphone and logs what the room does, so a call can be held against a
 * second participant without the order and call flow (#187 builds that).
 *
 * Every line also goes to the device log with a `[livekit-spike]` prefix,
 * which is how the spike's findings are read off the phone.
 */
export default function LiveKitSpikeScreen(): React.JSX.Element | null {
  const { url, token } = useLocalSearchParams<{ url?: string; token?: string }>();
  const [state, setState] = useState<string>(ConnectionState.Disconnected);
  const [remotes, setRemotes] = useState<string[]>([]);
  const [lines, setLines] = useState<string[]>([]);
  const [room, setRoom] = useState<Room | null>(null);

  useEffect(() => {
    if (!__DEV__ || url === undefined || token === undefined) {
      return undefined;
    }
    const log = (line: string): void => {
      const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`;
      // `warn`, not `log`: the lint allows only warn and error, and either reaches logcat.
      console.warn(`[livekit-spike] ${stamped}`);
      setLines((previous) => [stamped, ...previous].slice(0, 40));
    };
    const next = new Room();
    const syncRemotes = (): void => {
      setRemotes([...next.remoteParticipants.values()].map((p) => p.identity));
    };
    next
      .on(RoomEvent.ConnectionStateChanged, (s) => {
        setState(s);
        log(`state ${s}`);
      })
      .on(RoomEvent.Reconnecting, () => log('reconnecting'))
      .on(RoomEvent.Reconnected, () => log('reconnected'))
      .on(RoomEvent.Disconnected, (reason) => log(`disconnected ${String(reason)}`))
      .on(RoomEvent.ParticipantConnected, (p) => {
        log(`joined ${p.identity}`);
        syncRemotes();
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        log(`left ${p.identity}`);
        syncRemotes();
      })
      .on(RoomEvent.TrackSubscribed, (track, _pub, p) => {
        log(`subscribed ${track.kind} from ${p.identity}`);
      })
      .on(RoomEvent.TrackUnsubscribed, (track, _pub, p) => {
        log(`unsubscribed ${track.kind} from ${p.identity}`);
      })
      .on(RoomEvent.MediaDevicesError, (error) => log(`media error ${error.message}`));

    let cancelled = false;
    const start = async (): Promise<void> => {
      if (Platform.OS === 'android') {
        const answer = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        );
        log(`microphone ${answer}`);
      }
      await AudioSession.startAudioSession();
      if (cancelled) {
        return;
      }
      await next.connect(url, token);
      syncRemotes();
      await next.localParticipant.setMicrophoneEnabled(true);
      const published = next.localParticipant.getTrackPublication(Track.Source.Microphone);
      log(`microphone published ${String(published !== undefined)}`);
      // Keeps the microphone and the network once the app leaves the screen
      // (#183: without it Android cut both ~3 s after Home).
      startCallForegroundService('TezUsta', 'Zəng davam edir');
      log('foreground service started');
    };
    setRoom(next);
    start().catch((error: unknown) => {
      log(`failed ${error instanceof Error ? error.message : String(error)}`);
    });

    return () => {
      cancelled = true;
      void next.disconnect();
      void AudioSession.stopAudioSession();
      stopCallForegroundService();
    };
  }, [url, token]);

  if (!__DEV__) {
    return null;
  }

  return (
    <SafeAreaView className="flex-1 bg-bg">
      <View className="flex-1 gap-3 p-6">
        <Text variant="h2">LiveKit spike (#183)</Text>
        <Text variant="body">State: {state}</Text>
        <Text variant="body">Remote: {remotes.length === 0 ? '—' : remotes.join(', ')}</Text>
        <Button
          label="Disconnect"
          variant="secondary"
          disabled={room === null}
          onPress={() => {
            void room?.disconnect();
          }}
        />
        <ScrollView className="flex-1">
          {lines.map((line, index) => (
            <Text key={`${String(index)}-${line}`} variant="caption" tone="muted">
              {line}
            </Text>
          ))}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}
