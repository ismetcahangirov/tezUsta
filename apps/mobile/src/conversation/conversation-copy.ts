import type { MessageSenderKind } from '@tezusta/types';

/**
 * Every string on the conversation screen and its entry points (issue #182),
 * in one file.
 *
 * **Proposed, not settled** — the standing `orders-copy.ts` and
 * `master-jobs-copy.ts` have. The design system fixes colour, type and
 * components, not words, and CLAUDE.md §17 keeps the content of an empty or
 * error state with the owner. Every string here is listed in the pull request
 * and in [ADR-0037](../../../../docs/decisions/ADR-0037-conversation-screen.md)
 * as placeholder copy for the owner to accept or replace. Azerbaijani,
 * matching the rest of the app.
 */
export const CONVERSATION_COPY = {
  title: 'Mesajlar',
  back: 'Geri',
  loading: 'Mesajlar yüklənir',
  loadingOlder: 'Köhnə mesajlar yüklənir…',
  olderFailed: 'Köhnə mesajlar yüklənmədi.',
  retry: 'Yenidən cəhd et',

  /** The conversation could not be read at all. */
  errorTitle: 'Mesajlar yüklənmədi',
  errorDescription: 'Bağlantını yoxlayıb yenidən cəhd edin.',
  /** A 404: the order has no conversation — no master yet, or the master gave it back. */
  noneTitle: 'Yazışma yoxdur',
  noneDescription: 'Usta sifarişi qəbul edəndə burada yazışa biləcəksiniz.',

  /** An open conversation with nothing in it yet. */
  emptyTitle: 'Hələ mesaj yoxdur',
  emptyDescription: {
    customer: 'Ustaya giriş, mərtəbə və ya problem haqqında yaza bilərsiniz.',
    master: 'Müştəriyə gəliş vaxtı və ya ünvan haqqında yaza bilərsiniz.',
  } satisfies Record<MessageSenderKind, string>,

  /** Shown in place of the composer once the order is over. */
  closedNotice: 'Sifariş bitib. Yazışmanı oxumaq olar, yazmaq olmur.',

  composerLabel: 'Mesaj',
  composerPlaceholder: 'Mesaj yazın…',
  send: 'Göndər',

  /** Who is typing, named by their role on the order. */
  typing: {
    customer: 'Müştəri yazır…',
    master: 'Usta yazır…',
  } satisfies Record<MessageSenderKind, string>,

  /** Under the user's own bubble. */
  delivery: {
    sending: 'Göndərilir…',
    sent: 'Göndərildi',
    read: 'Oxundu',
    failed: 'Göndərilmədi',
  },
  resend: 'Yenidən göndər',

  /** The entry on the order screen and on the master's job screen. */
  entry: {
    title: 'Mesajlar',
    open: {
      customer: 'Usta ilə yazışma',
      master: 'Müştəri ilə yazışma',
    } satisfies Record<MessageSenderKind, string>,
    closed: 'Yazışma bağlanıb, yalnız oxumaq olar',
  },

  /** The screen reader's reading of an unread badge: "3 oxunmamış mesaj". */
  unread: (count: number): string => `${String(count)} oxunmamış mesaj`,
} as const;
