/**
 * The mail support-mediated recovery sends (ADR-0074 § 5, #515).
 *
 * **Placeholder wording**, like `otp-code.ts`'s templates and for the same
 * reason: the copy is the owner's (CLAUDE.md § 17). What each one must and
 * must not say is decided, and is what the tests hold it to:
 *
 * - none carries a sign-in code or a sign-in link;
 * - the only link anywhere is the cancel link, and only in the notice that
 *   opens the hold;
 * - the old address only ever sees the new one masked.
 */

interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
}

/** Baku has had no daylight saving since 2016, but the zone, not an offset, is what stays right. */
const BAKU_TIME = new Intl.DateTimeFormat('az-Latn-AZ', {
  timeZone: 'Asia/Baku',
  dateStyle: 'long',
  timeStyle: 'short',
});

export function formatBakuTime(at: Date): string {
  return BAKU_TIME.format(at);
}

/**
 * The code to the **new** address, which the user reads back to support. Says
 * plainly that it is not a sign-in code and is for support only, so a user
 * who did not ask for this has something to recognise.
 */
export function renderRecoveryCodeEmail(code: string, ttlMinutes: number): RenderedEmail {
  return {
    subject: `${code} — TezUsta hesabının bərpası`,
    text:
      `${code} — TezUsta hesabınızın bu ünvana keçirilməsi üçün təsdiq kodu. ` +
      'Bu, giriş kodu deyil: onu yalnız sizinlə yazışan TezUsta dəstək əməkdaşına deyin. ' +
      `Kod ${String(ttlMinutes)} dəqiqə ərzində etibarlıdır. ` +
      'Hesabın bərpasını siz istəməmisinizsə, bu məktuba məhəl qoymayın.',
  };
}

/**
 * The notice to the **old** address when the hold starts: what was asked, to
 * where (masked), when the move can happen at the earliest, and the one link
 * that stops it.
 */
export function renderRecoveryOpenedNotice(
  maskedNewEmail: string,
  earliestMove: Date,
  cancelLink: string,
): RenderedEmail {
  return {
    subject: 'TezUsta hesabınızın bərpası üçün sorğu açılıb',
    text:
      `TezUsta hesabınızın e-poçt ünvanının ${maskedNewEmail} ünvanına keçirilməsi üçün ` +
      'dəstəyə sorğu edilib. ' +
      `Köçürmə ən tezi ${formatBakuTime(earliestMove)} (Bakı vaxtı) olacaq. ` +
      'Bu vaxta qədər hesabınız adi qaydada işləyir. ' +
      `Bunu siz istəməmisinizsə, sorğunu bu keçidlə ləğv edin: ${cancelLink}`,
  };
}

/** To the old address when a hold it was told about is stopped. */
export function renderRecoveryCancelledNotice(): RenderedEmail {
  return {
    subject: 'TezUsta hesabınızın bərpa sorğusu ləğv edildi',
    text:
      'TezUsta hesabınızın e-poçt ünvanının dəyişdirilməsi üçün açılmış sorğu ləğv edildi. ' +
      'Hesabınız əvvəlki ünvanla qalır.',
  };
}

/** To **both** addresses once the move is done. Only the masked new address is named. */
export function renderRecoveryMovedNotice(maskedNewEmail: string): RenderedEmail {
  return {
    subject: 'TezUsta hesabınız yeni e-poçt ünvanına keçirildi',
    text:
      `TezUsta hesabınız dəstək vasitəsilə ${maskedNewEmail} ünvanına keçirildi və ` +
      'bütün cihazlarda hesabdan çıxış edildi. Bundan sonra yeni ünvanla daxil olun. ' +
      'Bunu siz istəməmisinizsə, dərhal dəstəklə əlaqə saxlayın.',
  };
}
