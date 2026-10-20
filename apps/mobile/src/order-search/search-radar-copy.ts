/**
 * Every customer-facing string on the search radar (issue #398).
 *
 * **Placeholder, not settled**, like `tracking-copy.ts`: CLAUDE.md § 17 keeps
 * words with the owner, and ADR-0055 lists each of these as interim.
 *
 * **Nothing here identifies a master.** The count is how many masters the
 * search has sent the order to — reach, not interest — and no sentence says
 * who, how far, or that anyone declined (ADR-0055 § 4).
 */
export const SEARCH_RADAR_COPY = {
  title: 'Axtarışın gedişi',
  mapLabel: 'Axtarış xəritəsi: ünvanınız və sorğunuzun çatdığı ustaların təxmini yerləri',
  addressMarker: 'Sizin ünvanınız',
  cellMarker: 'Təxmini usta yeri',
  starting: 'Axtarış başlayır…',
  reachedNobody: 'Sorğunuz hələ heç bir ustaya çatmayıb. Axtarış genişlənir.',
  reached: (count: number) => `Sorğunuz ${String(count)} ustaya göndərildi.`,
  reconnecting: 'Bağlantı bərpa olunur… Axtarış davam edir.',
  error: 'Xəritə yüklənmədi, amma axtarış davam edir.',
} as const;
