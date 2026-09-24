import type { CallPartyKind } from '@tezusta/types';

import type { CallEnd } from './call-end-reason';

/**
 * Every string on the call surface and its entry points (issue #188), in one
 * file.
 *
 * **PLACEHOLDER copy, not settled.** The design system fixes colour, type and
 * components, not words, and CLAUDE.md §17 keeps the content of a state with
 * the owner. Every string here is listed in the pull request and in
 * [ADR-0040](../../../../docs/decisions/ADR-0040-call-screens.md) § 7 for the
 * owner to accept or replace — the same arrangement as `conversation-copy.ts`.
 * Azerbaijani, because `az` is the required locale.
 *
 * **No ended message says "error"** (#188). A call that could not be made is
 * something that happened to the person holding the phone, and they are told
 * what it was — not that the app had a fault.
 */
export const CALL_COPY = {
  /** The other party when the server has not named them yet, by their side of the order. */
  peerFallback: {
    customer: 'Müştəri',
    master: 'Usta',
  } satisfies Record<CallPartyKind, string>,

  /** The status line, one per live phase. */
  status: {
    permissions: 'Mikrofon icazəsi gözlənilir…',
    outgoing: 'Zəng edilir…',
    incoming: 'Gələn zəng',
    connecting: 'Qoşulur…',
    reconnecting: 'Bağlantı bərpa olunur…',
  },

  /** Screen-reader names of the round controls. */
  controls: {
    cancel: 'Zəngi ləğv et',
    decline: 'Rədd et',
    accept: 'Cavab ver',
    hangup: 'Zəngi bitir',
    mute: 'Mikrofonu söndür',
    speaker: 'Dinamik',
    close: 'Bağla',
  },

  /** One sentence per way a call can end — nine, never "error". */
  ended: {
    completed: 'Zəng bitdi',
    declined: 'Zəng rədd edildi',
    no_answer: 'Cavab verən olmadı',
    busy: 'Xətt məşğuldur',
    cancelled: 'Zəng ləğv edildi',
    permission_denied: 'Mikrofona icazə verilmədi',
    connect_failed: 'Zəngə qoşulmaq alınmadı',
    dropped: 'Bağlantı kəsildi',
    error: 'Zəng baş tutmadı',
  } satisfies Record<CallEnd, string>,

  /** The phone control on the order, the job and the conversation header. */
  entry: {
    customer: 'Ustaya zəng et',
    master: 'Müştəriyə zəng et',
  } satisfies Record<CallPartyKind, string>,

  /** The running duration, spoken: "Zəngin müddəti 1:05". */
  duration: (formatted: string): string => `Zəngin müddəti ${formatted}`,
} as const;
