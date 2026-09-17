import type { LocalizedText } from '../../../common/i18n/localized-text.types';

/**
 * How a seeded service is priced, before it is a database row.
 *
 * The amount lives *inside* the discriminant rather than beside it, so a seed
 * entry that pairs `inspection` with a price does not compile. The database
 * enforces the same rule (`services_pricing_shape`); this is the earlier of
 * the two failures, and the one that costs nothing to hit.
 */
export type SeededServicePricing =
  { readonly kind: 'fixed'; readonly basePriceMinor: number } | { readonly kind: 'inspection' };

export interface SeededService {
  readonly slug: string;
  readonly name: LocalizedText;
  readonly pricing: SeededServicePricing;
}

export interface SeededServiceCategory {
  readonly slug: string;
  readonly name: LocalizedText;
  readonly services: readonly SeededService[];
}

/**
 * The launch catalogue: the ten categories in
 * `docs/product/product-overview.md` § Service categories, and the jobs inside
 * each one.
 *
 * **This is seed data, not configuration.** Nothing reads it at runtime — it is
 * written once into `service_categories` / `services` by
 * `seed-service-catalogue.ts`, and from that moment the database is the
 * authority. An admin who renames a service, reprices it, or deactivates it
 * (EPIC 13) is not fighting this file: the seed inserts what is missing and
 * never overwrites what is there.
 *
 * **The prices are reference figures, and the owner's to revise.** Per
 * [ADR-0010](docs/decisions/ADR-0010-pricing-and-commission.md) the master sets
 * the authoritative price on their own `master_services` row (EPIC 5); what a
 * `fixed` amount here does is let the app say "from 25 AZN" before any master
 * has been matched. They are plausible Baku figures, not researched market
 * rates, and revising one is an `UPDATE` — never a release.
 *
 * **Which jobs are `inspection` is not arbitrary.** A fridge that will not cool
 * is a compressor, a thermostat, or a door seal, and no honest number exists
 * until somebody has looked at it. A job whose scope is already visible from
 * the customer's description is `fixed`.
 *
 * Names carry `az` and `en`. `ru` is absent on purpose: the launch language set
 * is an open owner decision (CLAUDE.md §1), and
 * [ADR-0019](docs/decisions/ADR-0019-localized-catalogue-names.md) is what makes
 * adding it a row edit rather than a migration.
 *
 * Display order is array order, for the categories and for the services inside
 * them. `other` is last because it is the fallback, not somewhere anybody
 * browses to.
 */
export const SERVICE_CATALOGUE_SEED: readonly SeededServiceCategory[] = [
  {
    slug: 'plumbing',
    name: { az: 'Santexnika', en: 'Plumbing' },
    services: [
      {
        slug: 'leak-repair',
        name: { az: 'Su sızmasının aradan qaldırılması', en: 'Leak repair' },
        pricing: { kind: 'fixed', basePriceMinor: 2500 },
      },
      {
        slug: 'drain-unblocking',
        name: { az: 'Kanalizasiya tıxacının açılması', en: 'Drain unblocking' },
        pricing: { kind: 'fixed', basePriceMinor: 3000 },
      },
      {
        slug: 'tap-replacement',
        name: { az: 'Kranın dəyişdirilməsi', en: 'Tap replacement' },
        pricing: { kind: 'fixed', basePriceMinor: 2000 },
      },
      {
        slug: 'toilet-repair',
        name: { az: 'Unitazın təmiri', en: 'Toilet repair' },
        pricing: { kind: 'fixed', basePriceMinor: 3000 },
      },
      {
        slug: 'water-heater-repair',
        name: { az: 'Su qızdırıcısının təmiri', en: 'Water heater repair' },
        pricing: { kind: 'inspection' },
      },
    ],
  },
  {
    slug: 'locks',
    name: { az: 'Qapı və kilid', en: 'Locks' },
    services: [
      {
        slug: 'lockout-entry',
        name: { az: 'Bağlı qapının açılması', en: 'Lockout entry' },
        pricing: { kind: 'fixed', basePriceMinor: 3000 },
      },
      {
        slug: 'lock-replacement',
        name: { az: 'Kilidin dəyişdirilməsi', en: 'Lock replacement' },
        pricing: { kind: 'fixed', basePriceMinor: 3500 },
      },
      {
        slug: 'door-lock-repair',
        name: { az: 'Qapı kilidinin təmiri', en: 'Door lock repair' },
        pricing: { kind: 'fixed', basePriceMinor: 2500 },
      },
    ],
  },
  {
    slug: 'electrical',
    name: { az: 'Elektrik', en: 'Electrical' },
    services: [
      {
        slug: 'socket-replacement',
        name: { az: 'Rozetkanın dəyişdirilməsi', en: 'Socket replacement' },
        pricing: { kind: 'fixed', basePriceMinor: 1500 },
      },
      {
        slug: 'light-fitting-installation',
        name: { az: 'İşıq cihazının quraşdırılması', en: 'Light fitting installation' },
        pricing: { kind: 'fixed', basePriceMinor: 2000 },
      },
      {
        slug: 'circuit-breaker-replacement',
        name: { az: 'Avtomatın dəyişdirilməsi', en: 'Circuit breaker replacement' },
        pricing: { kind: 'fixed', basePriceMinor: 2000 },
      },
      {
        slug: 'wiring-fault-diagnosis',
        name: { az: 'Elektrik nasazlığının axtarışı', en: 'Wiring fault diagnosis' },
        pricing: { kind: 'inspection' },
      },
    ],
  },
  {
    slug: 'air-conditioning',
    name: { az: 'Kondisioner', en: 'Air conditioning' },
    services: [
      {
        slug: 'air-conditioner-service',
        name: { az: 'Kondisionerin təmizlənməsi', en: 'Air conditioner service' },
        pricing: { kind: 'fixed', basePriceMinor: 4000 },
      },
      {
        slug: 'air-conditioner-installation',
        name: { az: 'Kondisionerin quraşdırılması', en: 'Air conditioner installation' },
        pricing: { kind: 'fixed', basePriceMinor: 8000 },
      },
      {
        slug: 'refrigerant-refill',
        name: { az: 'Freonun doldurulması', en: 'Refrigerant refill' },
        pricing: { kind: 'fixed', basePriceMinor: 5000 },
      },
      {
        slug: 'air-conditioner-not-cooling',
        name: { az: 'Kondisioner soyutmur', en: 'Air conditioner not cooling' },
        pricing: { kind: 'inspection' },
      },
    ],
  },
  {
    slug: 'appliance-repair',
    name: { az: 'Məişət texnikasının təmiri', en: 'Appliance repair' },
    services: [
      {
        slug: 'washing-machine-repair',
        name: { az: 'Paltaryuyan maşının təmiri', en: 'Washing machine repair' },
        pricing: { kind: 'inspection' },
      },
      {
        slug: 'refrigerator-repair',
        name: { az: 'Soyuducunun təmiri', en: 'Refrigerator repair' },
        pricing: { kind: 'inspection' },
      },
      {
        slug: 'oven-repair',
        name: { az: 'Sobanın təmiri', en: 'Oven repair' },
        pricing: { kind: 'inspection' },
      },
      {
        slug: 'dishwasher-repair',
        name: { az: 'Qabyuyan maşının təmiri', en: 'Dishwasher repair' },
        pricing: { kind: 'inspection' },
      },
    ],
  },
  {
    slug: 'small-construction',
    name: { az: 'Kiçik tikinti və təmir', en: 'Small construction and repair' },
    services: [
      {
        slug: 'drilling-and-mounting',
        name: { az: 'Deşik açılması və montaj', en: 'Drilling and mounting' },
        pricing: { kind: 'fixed', basePriceMinor: 1500 },
      },
      {
        slug: 'wall-patching',
        name: { az: 'Divarın bərpası', en: 'Wall patching' },
        pricing: { kind: 'fixed', basePriceMinor: 4000 },
      },
      {
        slug: 'tile-repair',
        name: { az: 'Kafel işlərinin təmiri', en: 'Tile repair' },
        pricing: { kind: 'inspection' },
      },
    ],
  },
  {
    slug: 'furniture-assembly',
    name: { az: 'Mebel yığılması', en: 'Furniture assembly' },
    services: [
      {
        slug: 'flat-pack-assembly',
        name: { az: 'Hazır mebelin yığılması', en: 'Flat-pack assembly' },
        pricing: { kind: 'fixed', basePriceMinor: 3000 },
      },
      {
        slug: 'kitchen-unit-assembly',
        name: { az: 'Mətbəx mebelinin yığılması', en: 'Kitchen unit assembly' },
        pricing: { kind: 'inspection' },
      },
      {
        slug: 'furniture-repair',
        name: { az: 'Mebelin təmiri', en: 'Furniture repair' },
        pricing: { kind: 'inspection' },
      },
    ],
  },
  {
    slug: 'painting',
    name: { az: 'Rəngsaz işləri', en: 'Painting' },
    services: [
      {
        slug: 'wall-touch-up',
        name: { az: 'Divarın kiçik həcmli rənglənməsi', en: 'Small wall touch-up' },
        pricing: { kind: 'fixed', basePriceMinor: 5000 },
      },
      {
        slug: 'room-painting',
        name: { az: 'Otağın rənglənməsi', en: 'Room painting' },
        pricing: { kind: 'inspection' },
      },
      {
        slug: 'wallpapering',
        name: { az: 'Divar kağızının yapışdırılması', en: 'Wallpapering' },
        pricing: { kind: 'inspection' },
      },
    ],
  },
  {
    slug: 'cleaning',
    name: { az: 'Təmizlik', en: 'Cleaning' },
    services: [
      {
        slug: 'apartment-cleaning',
        name: { az: 'Mənzilin təmizlənməsi', en: 'Apartment cleaning' },
        pricing: { kind: 'fixed', basePriceMinor: 5000 },
      },
      {
        slug: 'window-cleaning',
        name: { az: 'Pəncərələrin yuyulması', en: 'Window cleaning' },
        pricing: { kind: 'fixed', basePriceMinor: 3000 },
      },
      {
        slug: 'post-renovation-cleaning',
        name: { az: 'Təmirdən sonra təmizlik', en: 'Post-renovation cleaning' },
        pricing: { kind: 'inspection' },
      },
    ],
  },
  {
    slug: 'other',
    name: { az: 'Digər', en: 'Other' },
    services: [
      {
        slug: 'other-request',
        name: { az: 'Digər sorğu', en: 'Other request' },
        pricing: { kind: 'inspection' },
      },
    ],
  },
];
