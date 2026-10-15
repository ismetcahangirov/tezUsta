import type { PartyRating } from './review.js';

/**
 * The master's public profile and photo portfolio (EPIC 19,
 * [ADR-0045](../../../docs/decisions/ADR-0045-master-portfolio.md)).
 *
 * **URLs, never keys.** Every image here is a public URL the API built from a
 * rendition's key; no storage key crosses the HTTP boundary (ADR-0045 § 5).
 * **Photos only:** ADR-0045 § 7 defers video.
 */

/** One photo in a post: its two renditions and the display size, for layout before it loads. */
export interface PortfolioMedia {
  readonly id: string;
  /** 480 px on the long edge: the grid tile. */
  readonly thumbUrl: string;
  /** 1440 px on the long edge: the viewer. */
  readonly displayUrl: string;
  readonly width: number;
  readonly height: number;
}

/** The service a post is tagged with. Absent while the master no longer offers it (ADR-0045 § 3). */
export interface PortfolioPostService {
  readonly serviceId: string;
  readonly name: string;
}

/**
 * One published post, as a profile reader sees it. Its photos in the order the
 * master chose. No publication date: ADR-0045 § 1 does not list one, and
 * ADR-0054 § 3 shows none.
 */
export interface PortfolioPost {
  readonly id: string;
  readonly caption: string | null;
  readonly service: PortfolioPostService | null;
  readonly media: readonly PortfolioMedia[];
}

/** An active service on the profile, with the master's own price. */
export interface MasterPublicService {
  readonly serviceId: string;
  readonly name: string;
  /** Integer minor units; null when the service is inspection-priced. */
  readonly priceMinor: number | null;
}

/**
 * The profile a customer of one of the master's orders, or the master, reads
 * (ADR-0045 § 1 is the whole list of fields; § 2 says who may read it).
 */
export interface MasterPublicProfile {
  readonly masterId: string;
  readonly displayName: string;
  readonly bio: string | null;
  /**
   * The avatar's 128 px square (`avatar-sm`, `avatar-md`) and 512 px square
   * (`avatar-lg`), the same pair `Master` carries (#309), or `null` for none.
   */
  readonly avatarUrl: string | null;
  readonly avatarLargeUrl: string | null;
  readonly rating: PartyRating;
  readonly services: readonly MasterPublicService[];
  /** The first page of posts, newest first. */
  readonly posts: readonly PortfolioPost[];
  /** Opaque: pass it back for the next page. Null on the last page. */
  readonly nextCursor: string | null;
}

/**
 * A post as its own master sees it in the editor (#308): every status but
 * `deleted`, with each photo's progress, so the editor can show what is
 * still uploading, processing or failed.
 */
export type OwnPortfolioPostStatus = 'draft' | 'processing' | 'published' | 'failed';

export type OwnPortfolioMediaStatus =
  'awaiting_upload' | 'uploaded' | 'processing' | 'ready' | 'failed';

/** Why a photo could not be used. Stable: the app maps each to its own message. */
export type PortfolioMediaFailureCode =
  | 'missing'
  | 'too_large'
  | 'heic_unsupported'
  | 'unsupported_format'
  | 'too_many_pixels'
  | 'undecodable'
  | 'processing_failed';

/** One photo in the editor. URLs and size only once it is `ready`. */
export interface OwnPortfolioMedia {
  readonly id: string;
  /** 0-based place in the post. */
  readonly position: number;
  readonly status: OwnPortfolioMediaStatus;
  readonly failureCode: PortfolioMediaFailureCode | null;
  readonly thumbUrl: string | null;
  readonly displayUrl: string | null;
  readonly width: number | null;
  readonly height: number | null;
}

export interface OwnPortfolioPost {
  readonly id: string;
  readonly status: OwnPortfolioPostStatus;
  readonly caption: string | null;
  readonly service: PortfolioPostService | null;
  /** In position order. */
  readonly media: readonly OwnPortfolioMedia[];
  /** The first failed photo's code, in position order, when the post is `failed`. */
  readonly failureCode: PortfolioMediaFailureCode | null;
  /** Set when an admin removed the post (ADR-0045 § 6). It stays out of the profile. */
  readonly removedAt: string | null;
  readonly createdAt: string;
  readonly publishedAt: string | null;
}

/** A presigned upload for one photo. The URL is a PUT to the private bucket. */
export interface PortfolioMediaUpload {
  readonly mediaId: string;
  readonly uploadUrl: string;
  readonly expiresAt: string;
  readonly contentType: string;
  /** Enforced at confirm against the stored object, not by the URL (ADR-0024). */
  readonly maxBytes: number;
}

/** An avatar upload's progress (#309). The avatar itself is on `Master`. */
export type MasterAvatarUploadStatus =
  'awaiting_upload' | 'uploaded' | 'processing' | 'ready' | 'failed';

export interface MasterAvatarUpload {
  readonly uploadId: string;
  readonly status: MasterAvatarUploadStatus;
  /** Why it failed; `cancelled` when the avatar was removed while it processed. */
  readonly failureCode: PortfolioMediaFailureCode | 'cancelled' | null;
}

/** A presigned avatar upload: a PUT to the private bucket. */
export interface MasterAvatarPresign {
  readonly uploadId: string;
  readonly uploadUrl: string;
  readonly expiresAt: string;
  readonly contentType: string;
  /** Enforced at confirm against the stored object (ADR-0024). */
  readonly maxBytes: number;
}

/** Where a removed post's evidence stands (ADR-0045 § 6). */
export type AdminPortfolioEvidence = 'none' | 'pending_move' | 'kept' | 'purged';

/** A post as a moderator lists it (#312). Every status, removed ones included. */
export interface AdminPortfolioPost {
  readonly id: string;
  readonly masterId: string;
  readonly masterName: string;
  readonly masterStatus: string;
  readonly status: 'draft' | 'processing' | 'published' | 'failed' | 'deleted';
  readonly caption: string | null;
  readonly mediaCount: number;
  readonly createdAt: string;
  readonly publishedAt: string | null;
  readonly removedAt: string | null;
  readonly removedByAdminId: string | null;
  readonly removalReason: string | null;
  /**
   * `none` for a post never removed; `pending_move` while a removed post's
   * renditions are still public; `kept` while they are evidence in the private
   * bucket; `purged` once the retention window deleted them.
   */
  readonly evidence: AdminPortfolioEvidence;
}

/** One photo in a moderator's view. A URL only while there is something to show. */
export interface AdminPortfolioMedia {
  readonly id: string;
  readonly position: number;
  readonly status: OwnPortfolioMediaStatus;
  /** Public for a live post; a short-lived presigned URL for kept evidence. */
  readonly thumbUrl: string | null;
  readonly displayUrl: string | null;
  readonly width: number | null;
  readonly height: number | null;
}

export interface AdminPortfolioPostDetail extends AdminPortfolioPost {
  readonly media: readonly AdminPortfolioMedia[];
}
