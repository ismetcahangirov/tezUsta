import { View } from 'react-native';

import {
  Avatar,
  Button,
  IconButton,
  MicOffIcon,
  PhoneIcon,
  PhoneOffIcon,
  SpeakerIcon,
  Text,
} from '../components';
import { CALL_COPY as copy } from './call-copy';
import type { CallState, EndedCallState } from './call-machine';
import { formatCallDuration } from './format-call-duration';
import { useCallDuration } from './useCallDuration';

type HeldPhase = Extract<CallState, { phase: 'active' | 'reconnecting' }>;

export interface CallScreenProps {
  /** The reducer's state. The screen renders it and decides nothing about it. */
  readonly state: CallState;
  /** The other party, as the server names them — never a phone number. */
  readonly peerName: string;
  /** The order's service, or null while it has not been read. */
  readonly serviceName: string | null;

  /**
   * Local toggles, rendered and reported but not acted on here. **Until the
   * room bridge lands they change nothing about the audio** (ADR-0039): the
   * bridge is what will mute the track and route the output.
   */
  readonly muted: boolean;
  readonly speakerOn: boolean;
  /** True while the accept is waiting on the microphone prompt, so it cannot be tapped twice. */
  readonly accepting?: boolean;

  readonly onCancel?: () => void;
  readonly onDecline?: () => void;
  readonly onAccept?: () => void;
  readonly onHangup: () => void;
  readonly onToggleMute: () => void;
  readonly onToggleSpeaker: () => void;
  /** The ended screen's one button: back to whatever the call was presented over. */
  readonly onClose: () => void;

  /** The clock the running duration is read against; pinned by stories and tests. */
  readonly now?: () => number;
}

/**
 * One call, in whichever phase its reducer is in
 * ([ADR-0040](../../../../docs/decisions/ADR-0040-call-screens.md), issue #188).
 *
 * **It renders phases; it decides nothing.** Every control reports a tap and
 * the reducer — held by `useOutgoingCall` / `useIncomingCall` — decides what
 * the tap means. A screen that decided anything about a call would be a second
 * state machine disagreeing with the first.
 *
 * **The inverse surface, in both themes** (ADR-0040 § 2): a call is a mode
 * apart from the product, and the inverse surface is the one place lime may be
 * type — which the running duration is.
 *
 * Top to bottom: the other party's avatar and name, the order's service, one
 * status line in words, and the phase's controls pinned to the bottom.
 */
export function CallScreen(props: CallScreenProps): React.JSX.Element {
  const { state, peerName, serviceName } = props;

  return (
    <View className="flex-1 justify-between bg-inverse-surface px-6 py-10">
      <View className="flex-1 items-center justify-center gap-3">
        <Avatar name={peerName} size="lg" />
        <Text variant="h1" tone="on-inverse" className="text-center">
          {peerName}
        </Text>
        {serviceName !== null && (
          // Muted on the inverse surface by opacity, not `text-muted`: that
          // role is drawn for the page, and on inverse it falls under 3:1.
          <Text variant="body" tone="on-inverse" className="text-center opacity-80">
            {serviceName}
          </Text>
        )}
        <CallStatus state={state} now={props.now} />
      </View>

      <CallControls {...props} />
    </View>
  );
}

/** The one line that says where the call is, in words. */
function CallStatus({
  state,
  now,
}: {
  readonly state: CallState;
  readonly now: (() => number) | undefined;
}): React.JSX.Element {
  switch (state.phase) {
    case 'active':
    case 'reconnecting':
      return <HeldStatus state={state} now={now} />;
    case 'ended':
      return <EndedStatus state={state} />;
    default:
      return <StatusLine>{copy.status[state.phase]}</StatusLine>;
  }
}

function StatusLine({ children }: { readonly children: string }): React.JSX.Element {
  return (
    // Polite: a change of phase is announced without interrupting whatever
    // the screen reader is saying.
    <Text variant="body-strong" tone="on-inverse" accessibilityLiveRegion="polite">
      {children}
    </Text>
  );
}

/**
 * The running duration, and — while reconnecting — a line saying so under it.
 *
 * **Reconnecting looks recovering, not frozen** (#188): the duration keeps its
 * place and keeps running, but loses its lime, and the words below say what is
 * happening. A frozen-looking screen is how somebody hangs up on a call that
 * was about to come back.
 */
function HeldStatus({
  state,
  now,
}: {
  readonly state: HeldPhase;
  readonly now: (() => number) | undefined;
}): React.JSX.Element {
  const elapsed = useCallDuration(state.connectedAt, now);
  const formatted = formatCallDuration(elapsed ?? 0);
  const reconnecting = state.phase === 'reconnecting';

  return (
    <View className="items-center gap-1">
      <Text
        variant="h2"
        tone={reconnecting ? 'on-inverse' : 'accent'}
        className={reconnecting ? 'opacity-80' : ''}
        accessibilityLabel={copy.duration(formatted)}
      >
        {formatted}
      </Text>
      {reconnecting && <StatusLine>{copy.status.reconnecting}</StatusLine>}
    </View>
  );
}

/** Why the call is over, in words — one sentence per reason, never "error". */
function EndedStatus({ state }: { readonly state: EndedCallState }): React.JSX.Element {
  return <StatusLine>{copy.ended[state.endReason]}</StatusLine>;
}

/** The phase's controls, left to right as ADR-0040 § 4 lists them. */
function CallControls({
  state,
  muted,
  speakerOn,
  accepting = false,
  onCancel,
  onDecline,
  onAccept,
  onHangup,
  onToggleMute,
  onToggleSpeaker,
  onClose,
}: CallScreenProps): React.JSX.Element {
  const hangup = (
    <IconButton
      accessibilityLabel={copy.controls.hangup}
      variant="danger"
      icon={<PhoneOffIcon tone="on-danger" size="lg" />}
      onPress={onHangup}
    />
  );

  switch (state.phase) {
    case 'permissions':
    case 'outgoing':
      return (
        <ControlRow>
          {onCancel !== undefined && (
            <IconButton
              accessibilityLabel={copy.controls.cancel}
              variant="danger"
              icon={<PhoneOffIcon tone="on-danger" size="lg" />}
              onPress={onCancel}
            />
          )}
        </ControlRow>
      );

    case 'incoming':
      return (
        <ControlRow>
          {onDecline !== undefined && (
            <IconButton
              accessibilityLabel={copy.controls.decline}
              variant="danger"
              icon={<PhoneOffIcon tone="on-danger" size="lg" />}
              onPress={onDecline}
            />
          )}
          {onAccept !== undefined && (
            <IconButton
              accessibilityLabel={copy.controls.accept}
              variant="accent"
              icon={<PhoneIcon tone="on-accent" size="lg" />}
              disabled={accepting}
              onPress={onAccept}
            />
          )}
        </ControlRow>
      );

    case 'connecting':
      return <ControlRow>{hangup}</ControlRow>;

    case 'active':
    case 'reconnecting':
      return (
        <ControlRow>
          <IconButton
            accessibilityLabel={copy.controls.mute}
            variant={muted ? 'on-inverse' : 'surface-alt'}
            selected={muted}
            icon={<MicOffIcon tone={muted ? 'inverse-surface' : 'text'} size="lg" />}
            onPress={onToggleMute}
          />
          <IconButton
            accessibilityLabel={copy.controls.speaker}
            variant={speakerOn ? 'on-inverse' : 'surface-alt'}
            selected={speakerOn}
            icon={<SpeakerIcon tone={speakerOn ? 'inverse-surface' : 'text'} size="lg" />}
            onPress={onToggleSpeaker}
          />
          {hangup}
        </ControlRow>
      );

    case 'ended':
      return (
        <ControlRow>
          {/* `secondary` rather than the default: the default pill is the
              inverse surface, which would vanish into this one. */}
          <Button label={copy.controls.close} variant="secondary" fullWidth onPress={onClose} />
        </ControlRow>
      );
  }
}

function ControlRow({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return <View className="flex-row items-center justify-center gap-10">{children}</View>;
}
