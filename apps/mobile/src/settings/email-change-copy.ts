/**
 * Every word on the address-change screen (#516). **Placeholders**: the copy
 * is the owner's (CLAUDE.md § 17); these are the plainest factual
 * Azerbaijani that makes the screen usable until it is written.
 */
export const EMAIL_CHANGE_COPY = {
  /** The Settings → Hesab button that opens the screen. */
  entry: 'E-poçt ünvanını dəyiş',

  title: 'E-poçt ünvanını dəyiş',
  addressIntro: 'Yeni ünvanı yazın. Həm hazırkı, həm də yeni ünvanınıza bir kod göndərəcəyik.',
  newEmailLabel: 'Yeni e-poçt ünvanı',
  newEmailPlaceholder: 'ad@example.com',
  sendCodes: 'Kodları göndər',

  codesIntro:
    'Hər iki ünvana gələn kodu yazın. Təsdiqdən sonra yeni ünvanla yenidən daxil olacaqsınız.',
  codeFor: (email: string): string => `${email} ünvanına gələn kod`,
  confirm: 'Təsdiqlə',
  resend: 'Kodları yenidən göndər',
  resent: 'Hər iki ünvana yeni kod göndərildi.',
  changeAddress: 'Başqa ünvan yaz',
  back: 'Geri',

  /** Refusals, one per answer the API gives (#514). */
  errors: {
    malformed: 'E-poçt ünvanı düzgün deyil.',
    sameAddress: 'Bu, artıq daxil olduğunuz ünvandır.',
    taken: 'Bu ünvan başqa hesabda istifadə olunur.',
    codeInvalid: 'Kodlardan biri yanlışdır və ya vaxtı keçib.',
    tooManyAttempts: 'Çox cəhd edildi. Bir az sonra yenidən yoxlayın.',
    sendCapReached: 'Kod göndərmək hazırda mümkün olmadı. Bir az sonra yenidən yoxlayın.',
    recoveryPending:
      'Hesabınız üçün dəstək vasitəsilə bərpa sorğusu açılıb. O bağlanana qədər ünvanı dəyişmək olmur.',
    generic: 'Alınmadı. Yenidən cəhd edin.',
  },
} as const;
