/**
 * The barrel every consumer imports from. One entry point, so a contract's
 * file can be split or renamed without touching either app.
 */
export type { Address } from './address.js';
export type { Customer } from './customer.js';
export type {
  MasterDocument,
  MasterDocumentDownload,
  MasterDocumentStatus,
  MasterDocumentType,
  MasterDocumentUpload,
  MasterVerificationSubmission,
} from './master-document.js';
export type {
  Master,
  MasterAvailability,
  MasterService,
  MasterVerificationStatus,
} from './master.js';
export type {
  ForwardGeocodeResult,
  GeocodedLocation,
  ReverseGeocodeResult,
  ReverseGeocodedAddress,
} from './geocoding.js';
export type {
  CursorPage,
  Service,
  ServiceCategory,
  ServicePricing,
  ServicePricingKind,
} from './service-catalogue.js';
export type { OrderActorKind, OrderStatus } from './order.js';
