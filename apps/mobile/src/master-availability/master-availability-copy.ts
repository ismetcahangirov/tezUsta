/**
 * Every string this feature shows, in one place.
 *
 * No i18n layer exists yet — TezUsta has not chosen its launch languages — so
 * this follows `service-catalogue-copy.ts`: Azerbaijani literals gathered into
 * one `as const` object, which is what moves into a real i18n layer when one
 * lands rather than being hunted through components.
 *
 * The wording carries weight here. `docs/product/master-flow.md` is explicit
 * that "a master who believes they are offline while the app still reports
 * location will lose trust in the product permanently", so the stale case has
 * its own sentence saying plainly that offers are not arriving, rather than a
 * softer phrase that lets a master assume the work is just quiet today.
 */
export const MASTER_AVAILABILITY_COPY = {
  title: 'İş vəziyyəti',
  online: 'Onlayn',
  offline: 'Oflayn',
  /** Shown while the master is genuinely reachable. */
  liveLabel: 'Sifariş qəbul edirsiniz',
  /** Shown while the master is off by their own choice. */
  offlineLabel: 'Sifariş gəlmir',
  /**
   * The divergence case: the toggle says online, the server has not heard from
   * this app inside the presence window. Names the likely cause, because on a
   * mid-range Android the likely cause is battery optimisation and the master
   * can actually do something about it.
   */
  staleTitle: 'Bağlantı itdi — sifariş gəlmir',
  staleDescription:
    'Tətbiq serverlə əlaqəni itirib. İnterneti yoxlayın və tətbiqin arxa planda işləməsinə icazə verin.',
  /** The master is not verified yet, or is suspended: going online is refused. */
  notEligibleTitle: 'Hələ onlayn ola bilmirsiniz',
  pendingVerification: 'Profiliniz yoxlanılır. Təsdiqdən sonra sifariş qəbul edə biləcəksiniz.',
  changesRequested: 'Sənədlərinizdə çatışmazlıq var. Onları yeniləyib yenidən göndərin.',
  rejected: 'Profiliniz təsdiqlənmədi.',
  suspended: 'Hesabınız dayandırılıb, ona görə sifariş qəbul edə bilməzsiniz.',
  /**
   * Location permission refused. The app still works — offers arrive, an order
   * can be accepted and finished — but dispatch cannot rank a master it cannot
   * place, so the sentence says what the refusal costs rather than just that it
   * happened (issue #171).
   */
  locationBlockedTitle: 'Məkan icazəsi yoxdur',
  locationBlockedDescription:
    'Məkanınız olmadan sizə yaxın sifarişlər göndərilə bilmir. Tətbiq parametrlərindən məkan icazəsini açın.',
  reportingStaleDescription:
    'Məkanınız bir neçə dəqiqədir göndərilmir. Telefon batareya qənaəti tətbiqi dayandırmış ola bilər.',
  loadFailed: 'Vəziyyət yüklənmədi',
  retry: 'Yenidən cəhd et',
} as const;
