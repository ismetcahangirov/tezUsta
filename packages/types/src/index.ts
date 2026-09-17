/**
 * The barrel every consumer imports from. One entry point, so a contract's
 * file can be split or renamed without touching either app.
 */
export type { Customer } from './customer.js';
export type {
  CursorPage,
  Service,
  ServiceCategory,
  ServicePricing,
  ServicePricingKind,
} from './service-catalogue.js';
