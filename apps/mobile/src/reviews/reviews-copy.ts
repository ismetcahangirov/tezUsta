import type { ReviewAuthorRole } from '@tezusta/types';

import type { ReviewFailure } from './review-errors';

/**
 * Every string on the review screen and its prompt card (issue #227), in one
 * file.
 *
 * **Proposed, not settled** — the standing every `*-copy.ts` in this app has.
 * ADR-0042 § 8 lists the review screen's copy as a placeholder for the owner's
 * acceptance, and every string here is listed in the pull request for that.
 * Azerbaijani, matching the rest of the app.
 *
 * **No number of days appears anywhere.** The window is server configuration
 * (`REVIEW_WINDOW_HOURS`), and a sentence promising "seven days" would be
 * wrong the day somebody tunes it.
 */
export const REVIEWS_COPY = {
  title: 'Rəy',
  back: 'Geri',
  loading: 'Rəy yüklənir',
  retry: 'Yenidən cəhd et',

  /** The question the screen asks, about the other side of the order. */
  question: {
    customer: 'Usta necə işlədi?',
    master: 'Müştəri ilə iş necə keçdi?',
  } satisfies Record<ReviewAuthorRole, string>,

  ratingLabel: 'Qiymət',
  /** One star, as a screen reader names the button: "4 ulduz". */
  star: (star: number): string => `${String(star)} ulduz`,
  /** A read-only row of stars, read once: "Qiymət: 5-dən 4". */
  ratingReading: (rating: number): string => `Qiymət: 5-dən ${String(rating)}`,
  ratingRequired: 'Ulduz sayını seçin.',

  commentLabel: 'Şərh (istəyə bağlı)',
  commentPlaceholder: 'Nə yaxşı idi, nə yaxşı ola bilərdi?',
  /** Under the field: "120/500". */
  commentCount: (count: number, max: number): string => `${String(count)}/${String(max)}`,
  /** The same count, as a sentence a screen reader can say. */
  commentCountLabel: (count: number, max: number): string =>
    `${String(max)} simvoldan ${String(count)} simvol`,

  submit: 'Göndər',
  save: 'Dəyişikliyi saxla',

  /** Edit mode: the review exists and is still sealed (ADR-0042 §§ 3–4). */
  sealedNotice:
    'Rəyiniz göndərilib. Qarşı tərəf də yazanda və ya rəy müddəti bitəndə dərc olunacaq. O vaxta qədər onu dəyişə bilərsiniz.',
  /** Read-only, and why. */
  revealedNotice: 'Rəyiniz dərc olunub və artıq dəyişdirilə bilməz.',
  removedNotice: 'Rəyiniz moderator tərəfindən silinib.',
  closedSealedNotice: 'Rəy müddəti bitib. Rəyiniz tezliklə dərc olunacaq.',

  mineHeading: 'Sizin rəyiniz',
  /** The other side's review of the reader, once revealed. */
  theirsHeading: {
    customer: 'Ustanın sizin haqqınızda rəyi',
    master: 'Müştərinin sizin haqqınızda rəyi',
  } satisfies Record<ReviewAuthorRole, string>,
  noComment: 'Şərh yazılmayıb.',

  /** Nothing to write, and why. */
  notYetTitle: 'Sifariş hələ bitməyib',
  notYetDescription: 'İş tamamlanandan sonra rəy yaza biləcəksiniz.',
  closedTitle: 'Rəy müddəti bitib',
  closedDescription: 'Bu sifariş üçün artıq rəy yazmaq olmur.',
  notFoundTitle: 'Rəy yazmaq mümkün deyil',
  notFoundDescription: 'Bu sifariş tapılmadı.',
  errorTitle: 'Rəy yüklənmədi',
  errorDescription: 'Bağlantını yoxlayıb yenidən cəhd edin.',

  /** A submit or an edit the server refused, one sentence per reason. */
  failure: {
    ORDER_NOT_REVIEWABLE: 'Bu sifarişə hələ rəy yazmaq olmur.',
    REVIEW_WINDOW_CLOSED: 'Rəy müddəti bitib.',
    REVIEW_ALREADY_SUBMITTED: 'Bu sifarişə artıq rəy yazmısınız. Onu aşağıda dəyişə bilərsiniz.',
    REVIEW_ALREADY_REVEALED: 'Rəyiniz artıq dərc olunub və dəyişdirilə bilməz.',
    validation: 'Rəy qəbul olunmadı. Qiyməti və şərhi yoxlayın.',
    'rate-limited': 'Çox cəhd etdiniz. Bir az sonra yenidən yoxlayın.',
    offline: 'Bağlantı yoxdur. İnterneti yoxlayıb yenidən cəhd edin.',
    unknown: 'Rəy göndərilmədi. Yenidən cəhd edin.',
  } satisfies Record<ReviewFailure, string>,

  /** The card on the order screen, the job screen and the master's home. */
  prompt: {
    title: 'Rəy bildirin',
    subtitle: {
      customer: 'Usta necə işlədi? Qiymət verin.',
      master: 'Müştəri ilə iş necə keçdi? Qiymət verin.',
    } satisfies Record<ReviewAuthorRole, string>,
  },
} as const;
