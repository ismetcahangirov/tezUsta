import type { NotificationCategory } from '@tezusta/types';

/**
 * The strings this feature shows, in one place.
 *
 * Only one of them is user-visible today, and it is not visible inside the
 * app: Android renders a notification channel's name in the system settings
 * screen where a user turns categories off. It is written here rather than
 * inline so that the day the app is translated, the channel name is not the
 * one string nobody finds.
 */
export const notificationsCopy = {
  /**
   * The channel every notification currently lands in.
   *
   * Named for what it carries rather than for the product, because it sits in
   * a list of the phone's own making: "TezUsta → Sifariş bildirişləri" reads
   * as a category, "TezUsta → Default" reads as an oversight.
   */
  defaultChannelName: 'Sifariş bildirişləri',

  /**
   * The preferences section in settings (issue #147).
   *
   * **Every string below this line is a placeholder and is labelled as one on
   * purpose.** What a category is called, how a locked one is explained, and
   * where the OS-permission warning sits are the owner's (CLAUDE.md §17); the
   * design system settles colour, type and the component inventory and
   * nothing about how this screen reads. They are written out rather than left
   * empty so the screen can be built and reviewed, and they are gathered here
   * so replacing them is one file.
   */
  preferences: {
    sectionTitle: 'Bildirişlər',
    loadFailed: 'Bildiriş parametrləri yüklənmədi.',
    retry: 'Yenidən cəhd et',
    saveFailed: 'Dəyişiklik yadda saxlanmadı. Yenidən cəhd edin.',
    /** Shown beside a category the server will not let anyone switch off. */
    lockedPill: 'Həmişə açıq',
    on: 'Açıq',
    off: 'Bağlı',
    /**
     * Shown when the operating system is blocking notifications outright.
     *
     * One string rather than a title and a body, because `Banner` takes one
     * `message` — a two-part banner would mean a new component, and the
     * inventory is settled (ADR-0011, CLAUDE.md §17).
     */
    osBlocked:
      'Bildirişlər telefon tənzimləmələrində bağlıdır. Aşağıdakı seçimlər yalnız icazə verdikdən sonra işləyəcək.',
    openSystemSettings: 'Tənzimləmələri aç',
  },

  /**
   * What each category is called, and why a locked one is locked.
   *
   * **A lookup, not the list that drives the screen.** What is rendered comes
   * from `GET /notification-preferences`; this only names what arrived. A
   * category the server adds still renders — under its own key, until somebody
   * writes it a name — and `satisfies` makes the missing name a compile error
   * rather than something noticed in production.
   */
  categories: {
    'order-offers': {
      title: 'Yeni sifariş təklifləri',
      lockedReason: 'Təklifi görmədən iş qəbul etmək mümkün deyil.',
    },
    'order-accepted': {
      title: 'Usta sifarişi qəbul etdi',
      lockedReason: 'Gözlədiyiniz cavabdır.',
    },
    'order-progress': {
      title: 'Sifarişin gedişatı',
      lockedReason: '',
    },
    'order-cancelled': {
      title: 'Sifariş ləğv edildi',
      lockedReason: 'Gözlədiyiniz cavabdır.',
    },
    'order-no-master-found': {
      title: 'Usta tapılmadı',
      lockedReason: 'Gözlədiyiniz cavabdır.',
    },
    messages: {
      title: 'Sifariş üzrə mesajlar',
      lockedReason: 'Qarşı tərəf işlə bağlı cavabınızı gözləyir.',
    },
  },

  /** For a category the server sent and nobody has named yet. */
  unnamedCategoryLockedReason: 'Bu bildiriş söndürülə bilməz.',
} as const;

/** Type-checked at the point of declaration, read through {@link categoryCopy}. */
const _categoriesAreComplete: Record<
  NotificationCategory,
  { readonly title: string; readonly lockedReason: string }
> = notificationsCopy.categories;

/**
 * The name and explanation for one category, falling back to its own key.
 *
 * The fallback is what keeps the screen honest about a category the server has
 * and the app has not been taught: it renders, under an ugly name, rather than
 * disappearing. A disappeared toggle reads as a missing feature.
 */
export function categoryCopy(category: NotificationCategory): {
  readonly title: string;
  readonly lockedReason: string;
} {
  return (
    _categoriesAreComplete[category] ?? {
      title: category,
      lockedReason: notificationsCopy.unnamedCategoryLockedReason,
    }
  );
}
