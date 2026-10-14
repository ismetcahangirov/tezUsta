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

/** The avatar's two square renditions (ADR-0045 § 8). */
export interface MasterAvatar {
  /** 128 px: `avatar-sm` and `avatar-md`. */
  readonly thumbUrl: string;
  /** 512 px: `avatar-lg`. */
  readonly displayUrl: string;
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
  readonly avatar: MasterAvatar | null;
  readonly rating: PartyRating;
  readonly services: readonly MasterPublicService[];
  /** The first page of posts, newest first. */
  readonly posts: readonly PortfolioPost[];
  /** Opaque: pass it back for the next page. Null on the last page. */
  readonly nextCursor: string | null;
}
