import type { Message, MessageSenderKind } from '@tezusta/types';
import { useCallback, useMemo } from 'react';
import { FlatList, KeyboardAvoidingView, View, type ViewToken } from 'react-native';

import { CallEntry } from '../calls/CallEntry';
import { Banner, Button, EmptyState, Skeleton, Text } from '../components';
import { useOrderRoom } from '../realtime/useOrderRoom';
import { useAppSelector } from '../store/hooks';
import { Composer } from './Composer';
import { CONVERSATION_COPY as copy } from './conversation-copy';
import { useConversationQuery, useMessagesInfiniteQuery } from './conversation-endpoints';
import { formatMessageTime } from './format-message-time';
import { MessageBubble } from './MessageBubble';
import { mergePages } from './message-history';
import type { OutboxEntry } from './outbox-slice';
import { selectOutbox } from './outbox-slice';
import { TypingIndicator } from './TypingIndicator';
import { useReadReceipts } from './useReadReceipts';
import { useSendMessage } from './useSendMessage';
import { useOtherPartyTyping, useTypingSignal } from './useTyping';

/** One row of the list: a message the server holds, or one it has not acknowledged. */
type Row =
  | { readonly kind: 'message'; readonly key: string; readonly message: Message }
  | { readonly kind: 'pending'; readonly key: string; readonly entry: OutboxEntry };

/**
 * `KeyboardAvoidingView` is not one of the components NativeWind maps a
 * `className` onto, so its one layout rule is a style. Not a design value:
 * "fill the screen" is the absence of a size, the way `transparent` is the
 * absence of a colour.
 */
const FILL = { flex: 1 } as const;

function statusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const { status } = error as { status?: unknown };
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

export interface ConversationProps {
  readonly orderId: string;
  /** Which side of the order this user is on — decides which bubbles are "mine". */
  readonly viewer: MessageSenderKind;
  readonly onBack: () => void;
}

/**
 * One order's conversation (issue #182,
 * [ADR-0033](../../../../docs/decisions/ADR-0033-in-order-messaging.md),
 * [ADR-0037](../../../../docs/decisions/ADR-0037-conversation-screen.md)).
 *
 * **One screen for both parties**, told only which side of the order it is
 * on. The customer reaches it pushed over their order screen and the master
 * pushed over their job; everything else — the history, the send, the read
 * receipts, the typing — is the same conversation from the other end.
 *
 * **The list is inverted and virtualised.** The newest message is item 0 and
 * sits at the bottom, which is where a chat opens and where new messages
 * land; scrolling up toward the list's end asks for the next page back in
 * time, through the server's keyset cursor. Nothing is ever fully
 * materialised, which is what keeps a long job's conversation responsive on a
 * mid-range Android device (CLAUDE.md §12).
 *
 * **It listens through the app's one socket** (#170). `useOrderRoom` asks for
 * the order's room — counted, so the order screen underneath keeps it when
 * this one closes — and the frames it receives are patched into the same
 * cache this screen reads. With the socket down, every line here still works
 * over HTTP.
 *
 * **The composer is absent, not disabled, once the order is over** (ADR-0033
 * § 2). The transcript stays, with a line saying why nothing can be added.
 */
export function Conversation({ orderId, viewer, onBack }: ConversationProps): React.JSX.Element {
  useOrderRoom(orderId);
  const conversation = useConversationQuery(orderId);
  const history = useMessagesInfiniteQuery(orderId);
  const outbox = useAppSelector((state) => selectOutbox(state, orderId));
  const typing = useOtherPartyTyping(orderId);
  const signalTyping = useTypingSignal(orderId);
  const { send, retry } = useSendMessage(orderId);
  const otherParty: MessageSenderKind = viewer === 'customer' ? 'master' : 'customer';

  const current = conversation.currentData;
  const pages = history.currentData?.pages;
  const onVisible = useReadReceipts(orderId, viewer, current?.unreadCount ?? 0);

  const rows = useMemo<Row[]>(() => {
    const pending: Row[] = outbox.map((entry) => ({
      kind: 'pending',
      key: entry.localId,
      entry,
    }));
    const held: Row[] = mergePages(pages ?? []).map((message) => ({
      kind: 'message',
      key: message.id,
      message,
    }));
    return [...pending, ...held];
  }, [outbox, pages]);

  /**
   * Stable for the life of the list — React Native refuses a new
   * `onViewableItemsChanged` on a mounted `FlatList` — which holds because
   * `onVisible` is itself stable.
   */
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<Row>[] }) => {
      onVisible(
        viewableItems.flatMap((token) =>
          token.isViewable && token.item.kind === 'message' ? [token.item.message] : [],
        ),
      );
    },
    [onVisible],
  );

  if (current === undefined || pages === undefined) {
    const error = conversation.error ?? history.error;
    const missing = statusOf(conversation.error) === 404 || statusOf(conversation.error) === 403;

    return (
      <ConversationFrame onBack={onBack}>
        {missing ? (
          <EmptyState title={copy.noneTitle} description={copy.noneDescription} />
        ) : error === undefined ? (
          <View accessible accessibilityLabel={copy.loading} className="gap-4">
            <Skeleton className="h-control-lg w-full" />
            <Skeleton className="h-control-lg w-full" />
          </View>
        ) : (
          <EmptyState
            title={copy.errorTitle}
            description={copy.errorDescription}
            action={
              <Button
                label={copy.retry}
                loading={conversation.isFetching || history.isFetching}
                onPress={() => {
                  void conversation.refetch();
                  void history.refetch();
                }}
              />
            }
          />
        )}
      </ConversationFrame>
    );
  }

  const typingIndicator = typing ? <TypingIndicator label={copy.typing[otherParty]} /> : null;

  return (
    <KeyboardAvoidingView behavior="padding" style={FILL}>
      <ConversationFrame
        onBack={onBack}
        action={<CallEntry orderId={orderId} viewer={viewer} available={current.writable} />}
      >
        {rows.length === 0 ? (
          <View className="flex-1 justify-end">
            <EmptyState title={copy.emptyTitle} description={copy.emptyDescription[viewer]} />
            {typingIndicator}
          </View>
        ) : (
          <FlatList
            testID="conversation-messages"
            data={rows}
            inverted
            keyExtractor={(row) => row.key}
            renderItem={({ item }) => (
              <ConversationRow
                row={item}
                viewer={viewer}
                canRetry={current.writable}
                onRetry={retry}
              />
            )}
            onViewableItemsChanged={onViewableItemsChanged}
            onEndReachedThreshold={0.5}
            onEndReached={() => {
              if (history.hasNextPage && !history.isFetchingNextPage) {
                void history.fetchNextPage();
              }
            }}
            // Inverted: the header sits under the newest message, the footer
            // above the oldest loaded one.
            ListHeaderComponent={typingIndicator}
            ListFooterComponent={
              <OlderMessagesFooter
                loading={history.isFetchingNextPage}
                // With pages already on screen, an error can only be a page
                // that failed to arrive — the next one back, or a refetch.
                failed={history.isError && !history.isFetching}
                onRetry={() => {
                  void history.fetchNextPage();
                }}
              />
            }
          />
        )}

        {current.writable ? (
          <Composer onSend={send} onTyping={signalTyping} />
        ) : (
          <Banner message={copy.closedNotice} />
        )}
      </ConversationFrame>
    </KeyboardAvoidingView>
  );
}

interface ConversationRowProps {
  readonly row: Row;
  readonly viewer: MessageSenderKind;
  readonly canRetry: boolean;
  readonly onRetry: (entry: OutboxEntry) => void;
}

function ConversationRow({
  row,
  viewer,
  canRetry,
  onRetry,
}: ConversationRowProps): React.JSX.Element {
  if (row.kind === 'pending') {
    const { entry } = row;
    return (
      <MessageBubble
        body={entry.body}
        time={formatMessageTime(entry.createdAt)}
        mine
        delivery={entry.status}
        onRetry={
          canRetry && entry.status === 'failed'
            ? () => {
                onRetry(entry);
              }
            : undefined
        }
      />
    );
  }

  const { message } = row;
  const mine = message.senderKind === viewer;
  return (
    <MessageBubble
      body={message.body}
      time={formatMessageTime(message.createdAt)}
      mine={mine}
      delivery={mine ? (message.readAt === null ? 'sent' : 'read') : undefined}
    />
  );
}

interface OlderMessagesFooterProps {
  readonly loading: boolean;
  readonly failed: boolean;
  readonly onRetry: () => void;
}

/** Above the oldest loaded message: the next page coming, or failing to. */
function OlderMessagesFooter({
  loading,
  failed,
  onRetry,
}: OlderMessagesFooterProps): React.JSX.Element | null {
  if (failed) {
    return (
      <View className="items-center gap-2 py-4">
        <Text variant="caption" tone="muted">
          {copy.olderFailed}
        </Text>
        <Button label={copy.retry} variant="ghost" size="sm" onPress={onRetry} />
      </View>
    );
  }
  if (loading) {
    return (
      <View className="items-center py-4">
        <Text variant="caption" tone="muted">
          {copy.loadingOlder}
        </Text>
      </View>
    );
  }
  return null;
}

interface ConversationFrameProps {
  readonly onBack: () => void;
  /**
   * The header's call control (ADR-0040 § 6), or nothing. Shown only in the
   * frame around a conversation that has loaded and is writable — the
   * server's own answer to whether the order is still one to call about.
   */
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
}

/** The title row every state shares — the order screen's own frame, so back is always reachable. */
function ConversationFrame({
  onBack,
  action,
  children,
}: ConversationFrameProps): React.JSX.Element {
  return (
    <View className="flex-1 gap-4 p-6">
      <View className="flex-row items-center justify-between gap-3">
        <Text variant="h1" className="flex-1">
          {copy.title}
        </Text>
        {action}
        <Button label={copy.back} variant="ghost" size="sm" onPress={onBack} />
      </View>
      {children}
    </View>
  );
}
