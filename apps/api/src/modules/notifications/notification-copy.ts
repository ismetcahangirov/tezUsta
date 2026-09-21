import type { NotificationKind, NotificationRequest } from './notification.types';

/**
 * What a notification says.
 *
 * **Every string below is placeholder copy and is labelled as such.** Which
 * languages TezUsta ships at launch is an open owner decision (CLAUDE.md §1),
 * and the words a customer reads are the owner's (§17), not something to
 * invent here. What this file settles is the *shape* — a kind plus parameters
 * resolves to a title and a body at the last possible moment — so answering
 * either question later is an edit to this table rather than a migration, a
 * queue drain, or a change to anything that already enqueued a job.
 *
 * The text is Azerbaijani because `az` is the required locale every read
 * resolves to ([ADR-0019](../../../../../docs/decisions/ADR-0019-localized-catalogue-names.md)),
 * and a placeholder in the wrong language would be a worse placeholder. It is
 * still a placeholder.
 *
 * **Rendering happens in the worker, not at enqueue.** A job carries the kind
 * and the ids (ADR-0025); the words are produced here, immediately before the
 * push leaves. That is what makes a copy change take effect on jobs already
 * sitting in the queue instead of delivering last week's wording.
 */
export interface NotificationCopy {
  readonly title: string;
  readonly body: string;
}

type CopyFactory = (request: NotificationRequest) => NotificationCopy;

/**
 * Exhaustive over {@link NotificationKind} by type, so adding a kind without
 * words for it does not compile.
 */
const COPY: Readonly<Record<NotificationKind, CopyFactory>> = Object.freeze({
  // PLACEHOLDER COPY — owner approval outstanding.
  'order-offer': () => ({
    title: 'Yaxınlıqda yeni sifariş',
    body: 'Sizin xidmətinizə uyğun sifariş var. Baxmaq üçün toxunun.',
  }),
  'order-accepted': () => ({
    title: 'Usta tapıldı',
    body: 'Bir usta sifarişinizi qəbul etdi.',
  }),
  'order-status-changed': () => ({
    title: 'Sifarişiniz yeniləndi',
    body: 'Sifarişinizin vəziyyəti dəyişdi. Ətraflı baxmaq üçün toxunun.',
  }),
  'order-cancelled': () => ({
    title: 'Sifariş ləğv edildi',
    body: 'Sifariş ləğv edildi.',
  }),
  'order-redispatched': () => ({
    title: 'Yeni usta axtarılır',
    body: 'Təyin olunan usta gələ bilmədi. Sizin üçün yeni usta axtarırıq.',
  }),
  'order-no-master-found': () => ({
    title: 'Usta tapılmadı',
    body: 'Hazırda uyğun usta tapa bilmədik. Yenidən cəhd edə bilərsiniz.',
  }),
});

/**
 * The words for one notification.
 *
 * **Nothing about the order goes into the text**, and that is a rule rather
 * than a gap. A notification renders on a lock screen, which is the one
 * surface this product shows to somebody who has not authenticated, so the
 * body says that something changed and the app says what — after the client
 * has asked the API, which is the request that is actually ownership-checked
 * (CLAUDE.md §11, `security.md` § PII and privacy).
 */
export function renderNotification(request: NotificationRequest): NotificationCopy {
  return COPY[request.kind](request);
}
