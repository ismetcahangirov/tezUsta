/**
 * Every string on the master's services screen (ADR-0063), in one file.
 *
 * **Placeholder copy, for the owner to accept or replace** — the standing
 * `master-jobs-copy.ts` has. The price strings repeat the inspection quote's
 * (ADR-0060) on purpose: one price field in the app, one way of describing it.
 */
export const MASTER_SERVICES_COPY = {
  title: 'Xidmətlərim',
  back: 'Geri',
  loading: 'Yüklənir',
  errorTitle: 'Xidmətlər yüklənmədi',
  retry: 'Yenidən cəhd et',
  emptyTitle: 'Hələ xidmət əlavə etməmisiniz',
  emptyDescription: 'Sifarişlər yalnız göstərdiyiniz xidmətlər üzrə gəlir.',
  add: 'Xidmət əlavə et',
  /** The add step once every catalogue service is already on the list. */
  allAdded: 'Kataloqdakı bütün xidmətləri artıq göstərmisiniz.',
  priceLabel: 'Qiymət (AZN)',
  priceInvalid: 'Qiyməti düzgün yazın, məsələn 45 və ya 45,50.',
  priceAfterInspection: 'Qiymət baxışdan sonra',
  inspectionHint: 'Bu xidmətin qiyməti ünvanda, baxışdan sonra təyin olunur.',
  confirmAdd: 'Əlavə et',
  save: 'Yadda saxla',
  pause: 'Müvəqqəti dayandır',
  resume: 'Yenidən aktiv et',
  /** Under a paused service's name: the price is kept, dispatch skips it. */
  paused: 'Dayandırılıb — sifariş gəlmir',
  remove: 'Xidməti sil',
  cancel: 'Ləğv et',
  /** A service the master still offers that the catalogue has since retired. */
  retired: 'Artıq kataloqda olmayan xidmət',
  failed: 'Alınmadı. Yenidən cəhd edin.',
} as const;
