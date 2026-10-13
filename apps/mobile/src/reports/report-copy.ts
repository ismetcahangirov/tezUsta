import type { ReportReasonCode, ReportStatus } from '@tezusta/types';

/**
 * PLACEHOLDER COPY — the owner's to approve (#330, ADR-0053, CLAUDE.md §17).
 *
 * The screen and its entry were laid out by delegation, from the design
 * system's own components; the words here are a first draft in Azerbaijani.
 */
export const REPORTS_COPY = {
  entry: 'Problem bildir',
  entryDone: 'Problem bildirildi',
  entryDoneHint: 'Bildirişinizə baxın',

  title: 'Problem bildir',
  back: 'Geri',
  loading: 'Yüklənir',
  errorTitle: 'Məlumat yüklənmədi',
  errorDescription: 'İnternet bağlantısını yoxlayıb yenidən cəhd edin.',
  retry: 'Yenidən cəhd et',
  unavailableTitle: 'Bu sifariş üçün problem bildirmək mümkün deyil',
  unavailableDescription:
    'Problem sifariş davam edərkən və bitdikdən sonra qısa müddət ərzində bildirilə bilər.',

  whoLabel: 'Kim haqqında?',
  whoCurrent: 'Hazırkı usta',
  whoLeft: 'Sifarişdən imtina edib',
  reasonLabel: 'Nə baş verdi?',
  reasonRequired: 'Səbəbi seçin.',
  selected: 'seçilib',
  textLabel: 'Əlavə məlumat (istəyə bağlı)',
  textPlaceholder: 'Nə baş verdiyini qısaca yazın',
  textCount: (count: number, max: number) => `${String(count)} / ${String(max)}`,
  textCountLabel: (count: number, max: number) => `${String(count)} simvol, ən çox ${String(max)}`,
  privacyNote: 'Qarşı tərəf bu bildirişi və onu kimin yazdığını görməyəcək.',
  submit: 'Göndər',
  save: 'Yadda saxla',

  sentTitle: 'Bildirişiniz',
  editableNotice: 'Komandamız baxana qədər bildirişi dəyişə bilərsiniz.',
  inReviewNotice: 'Komandamız bildirişinizə baxır. Artıq dəyişmək olmur.',
  closedNotice: 'Bildirişinizə baxılıb. Təşəkkür edirik.',
  windowClosedNotice: 'Bildiriş müddəti bitib, onu artıq dəyişmək olmur.',
  noText: 'Əlavə məlumat yazılmayıb.',

  failure: {
    closed: 'Bu sifariş üçün bildiriş müddəti bitib.',
    notEditable: 'Bildirişinizə artıq baxılır, onu dəyişmək olmur.',
    duplicate: 'Bu sifariş üçün artıq bildiriş göndərmisiniz.',
    unexpected: 'Bildiriş göndərilmədi. Yenidən cəhd edin.',
  },

  reason: {
    no_show: 'Gəlmədi',
    rude_or_abusive: 'Kobud və ya təhqiramiz davranış',
    unsafe_behaviour: 'Təhlükəli davranış',
    asked_off_platform_payment: 'Tətbikdən kənar ödəniş istədi',
    damage: 'Ziyan vurdu',
    other: 'Başqa səbəb',
  } satisfies Record<ReportReasonCode, string>,

  status: {
    open: 'Göndərilib',
    in_review: 'Baxılır',
    closed: 'Baxılıb',
  } satisfies Record<ReportStatus, string>,
} as const;
