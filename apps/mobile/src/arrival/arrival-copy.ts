/**
 * The arrival countdown's strings, for both parties (issue #399).
 *
 * **Placeholder, not settled** — ADR-0055 lists every one as interim and the
 * owner's to replace (CLAUDE.md § 17).
 *
 * **The source of the promise is never mentioned.** Whether it came from a
 * road route or the fallback estimate is an audit fact; saying so on screen
 * would only invite argument about which number counts (ADR-0055 § 12).
 */
export const ARRIVAL_COPY = {
  customer: {
    pending: 'Gəlmə vaxtı hesablanır…',
    arrivingBy: (clock: string) => `${clock}-dək çatacaq`,
    minutesLeft: (minutes: number) => `~${String(minutes)} dəq`,
    underMinute: '1 dəqiqədən az',
    late: (minutes: number) => `Gecikir · ${String(minutes)} dəq`,
    /** Announced once, when the promise passes. Names the state, never a time. */
    lateAnnouncement: 'Usta gecikir.',
  },
  master: {
    pending: 'Çatma vaxtı hesablanır…',
    beThereBy: (clock: string) => `${clock}-dək orada olun`,
    minutesLeft: (minutes: number) => `${String(minutes)} dəq qalıb`,
    underMinute: '1 dəqiqədən az qalıb',
    late: (minutes: number) => `${String(minutes)} dəq gecikirsiniz`,
    lateAnnouncement: 'Gecikirsiniz.',
  },
} as const;
