import type { AppConfig } from '../config/app-config.types';

/**
 * The surfaces that carry a rate limit, and the complete list of them.
 *
 * Three of the five are authentication. `geocode` is here because it shares
 * `otp-request`'s shape of abuse rather than the credential-guessing one:
 * **every allowed call spends money at Google** ([ADR-0004](../../../../docs/decisions/ADR-0004-location-and-maps.md)),
 * so an authenticated account looping the endpoint is a billing incident rather
 * than a security one. The geocode cache is the first defence and this is the
 * second; neither alone is enough, because a loop over *distinct* addresses
 * misses the cache every time by construction.
 *
 * There are three, not four, authentication policies, and the missing one is
 * deliberate. `docs/architecture/authentication.md` § Rate limiting states it
 * outright: "OTP request and OTP verify **are** sign-in on the consumer path —
 * there is no third endpoint to throttle, and listing one invites somebody to
 * build it." So `sign-in` is the name of the limit that OTP *verify* carries
 * today and that the admin email + password + TOTP form will carry when
 * EPIC 13 lands (ADR-0014); it is one policy because it is one concern —
 * guessing a credential — and not because the two endpoints are the same
 * endpoint.
 *
 * `otp-request` is separate because its abuse is financial rather than
 * credential-guessing: every allowed request spends money on an SMS
 * (ADR-0008), which is why its budget is much smaller than the others'.
 *
 * `document-upload` joined for `geocode`'s reason rather than `sign-in`'s: a
 * presigned upload URL is permission to write bytes into a paid bucket
 * ([ADR-0005](../../../../docs/decisions/ADR-0005-object-storage.md)), so an
 * authenticated master looping the endpoint is a storage and bandwidth bill,
 * not a credential attack. The structural cap — at most one outstanding
 * presign per document type, enforced by a partial unique index — bounds how
 * many URLs are live at once but not how fast they can be minted, which is
 * what this bounds.
 *
 * `price-range` (issue #84) is neither: nothing about
 * `GET /services/:id/price-range` costs money at a third party, and it is not
 * a credential to guess. What it costs is a join-plus-aggregate over
 * `master_services` — set to become the largest table in the schema — on an
 * **unauthenticated, uncached** route: ADR-0020's "the first page is answered
 * from cache" mitigation, which is why the catalogue reads carry no limit,
 * cannot apply here by construction, because ADR-0013 requires this specific
 * read to be computed live on every call. A budget is therefore the only
 * defence this route has. Identified by user id where a caller is signed in,
 * the same as `geocode`/`document-upload`; an anonymous caller (the common
 * case — this route is `@Public()`) falls through to the per-IP half alone,
 * which is legitimate and still in force.
 *
 * `location-report` (issue #98) is the first policy that is not defending a
 * resource at all — it is **enforcing a documented interval**.
 * `docs/architecture/realtime-architecture.md` § Location update budget states
 * that location updates are "a budget, not a stream" and that the server, not
 * the client, decides how often a master may report. Without a limit that
 * sentence is a suggestion an app can ignore by shipping a bad `setInterval`,
 * and every ignored suggestion writes another row of somebody's movements into
 * the most sensitive table in the schema. So this budget is a privacy control
 * and a write-volume control at once, which is why it is sized from the
 * fastest documented interval rather than from a load test.
 *
 * WebSocket message flooding is a limit too, and it is NOT here: it is a
 * per-connection budget measured in messages per second against a live
 * socket, not a per-identifier budget on an HTTP request
 * (`docs/architecture/realtime-architecture.md`). Forcing it into this enum
 * would give it the wrong shape.
 */
export type RateLimitPolicyName =
  | 'otp-request'
  | 'sign-in'
  | 'refresh'
  | 'geocode'
  | 'document-upload'
  | 'order-creation'
  | 'price-range'
  | 'location-report'
  | 'offer-response'
  | 'offer-feed';

export interface RateLimitPolicy {
  /** Per phone number, per admin email, per session id — whichever this policy identifies by. */
  readonly perIdentifier: number;
  readonly perIp: number;
  readonly windowMs: number;
  readonly backoffCeilingMs: number;
}

export interface RateLimitConfig {
  /**
   * HMAC key under which every subject is hashed into its Redis key.
   *
   * A *keyed* digest, not a bare SHA-256, and the difference is the whole
   * control. An Azerbaijani mobile number is `+994` plus nine digits — under
   * 10^9 candidates, which is a few seconds of unsalted SHA-256 on a laptop.
   * Anyone holding `KEYS`/`MONITOR` on this Redis (an operator, a backup, a
   * misconfigured managed instance) could therefore turn an unkeyed key space
   * straight back into the list of every phone number that tried to sign in.
   * `docs/engineering/security.md` forbids storing full phone numbers, and a
   * reversible hash of one is a stored phone number.
   *
   * This is the same reasoning `docs/engineering/dependency-policy.md` already
   * recorded for OTP codes ("the control that actually closes the
   * database-dump path is a **keyed** digest — HMAC-SHA256 under a config-held
   * pepper"), applied to the other value with a small keyspace.
   *
   * Deliberately its own secret rather than a reuse of `JWT_ACCESS_SECRET`:
   * one secret with two purposes cannot be rotated for one of them, and a
   * pepper leak would otherwise be a token-forgery incident.
   */
  readonly keySecret: string;
  readonly policies: Readonly<Record<RateLimitPolicyName, RateLimitPolicy>>;
}

/**
 * Thrown from the provider factory so it surfaces during `NestFactory.create`
 * and `main.ts` turns it into a clear message plus a non-zero exit — the same
 * fail-fast path `MissingAuthSecretError` takes, and for the same reason.
 *
 * Booting without the pepper is not an option worth having. The two
 * alternatives to failing here are both worse: hashing unkeyed silently
 * downgrades the control described above with nothing in the logs to say so,
 * and generating a random pepper per process would give every instance a
 * different key space — which is precisely the per-instance counter this
 * module exists to avoid.
 */
export class MissingRateLimitKeySecretError extends Error {
  constructor() {
    super(
      'RATE_LIMIT_KEY_SECRET is not set. Authentication rate limiting hashes every ' +
        'phone number and IP into its Redis key under this pepper, and cannot do so ' +
        'without it — generate one with `openssl rand -base64 48` and set it in the ' +
        'environment (see .env.example). It must differ from JWT_ACCESS_SECRET and ' +
        'JWT_REFRESH_SECRET.',
    );
    this.name = 'MissingRateLimitKeySecretError';
    Object.setPrototypeOf(this, MissingRateLimitKeySecretError.prototype);
  }
}

/**
 * Every configured limit is expressed per hour, so the window is an hour.
 *
 * That is not a free choice: the variable names say so
 * (`OTP_RATE_LIMIT_PER_PHONE_HOUR`), and a knob that reads "5 per hour" while
 * the code enforced it over ten minutes would be a lie an operator could not
 * see. A shorter window is available by lowering the count, not by editing
 * this constant.
 */
const WINDOW_MS = 3_600_000;

/**
 * Builds the module's configuration from the validated {@link AppConfig}.
 *
 * The OTP numbers come from `config.sms.otp` — where `.env.example` has
 * always grouped them, under ADR-0008 — and the two newer policies from
 * `config.rateLimit`. Two homes for one concern is not ideal, but moving the
 * OTP knobs would rename environment variables that are already documented
 * and deployed, and a renamed variable silently reverts to its default.
 */
export function createRateLimitConfig(config: AppConfig): RateLimitConfig {
  const { keySecret } = config.rateLimit;

  if (keySecret === undefined) {
    throw new MissingRateLimitKeySecretError();
  }

  // Length, character set, the placeholder check and "must differ from the
  // JWT secrets" are already enforced by `env.schema.ts`; this function only
  // decides presence, exactly like `createAuthConfig`.
  const backoffCeilingMs = WINDOW_MS * config.rateLimit.backoffMultiplier;

  return Object.freeze({
    keySecret,
    policies: Object.freeze({
      'otp-request': Object.freeze({
        perIdentifier: config.sms.otp.rateLimitPerPhoneHour,
        perIp: config.sms.otp.rateLimitPerIpHour,
        windowMs: WINDOW_MS,
        backoffCeilingMs,
      }),
      'sign-in': Object.freeze({
        perIdentifier: config.rateLimit.signInPerIdentifierHour,
        perIp: config.rateLimit.signInPerIpHour,
        windowMs: WINDOW_MS,
        backoffCeilingMs,
      }),
      refresh: Object.freeze({
        perIdentifier: config.rateLimit.refreshPerSessionHour,
        perIp: config.rateLimit.refreshPerIpHour,
        windowMs: WINDOW_MS,
        backoffCeilingMs,
      }),
      // Identified by user id rather than by phone number or session: the
      // budget belongs to the account spending the money, and a user with
      // three devices should not get three budgets for one Maps bill.
      geocode: Object.freeze({
        perIdentifier: config.maps.geocodePerUserHour,
        perIp: config.maps.geocodePerIpHour,
        windowMs: WINDOW_MS,
        backoffCeilingMs,
      }),
      // Identified by user id, like `geocode` and for the same reason: the
      // budget belongs to the account spending the money. Three documents,
      // a few retries each, and room for a master who photographs an ID card
      // badly several times before giving up — but not a loop. Shared with
      // customer problem-photo presigns (issue #83) rather than given a
      // second policy: the abuse is identical — permission to write bytes
      // into a paid bucket — and the number was already sized generously
      // enough to cover a handful of retried photo uploads too.
      'document-upload': Object.freeze({
        perIdentifier: config.storage.uploadPresignPerUserHour,
        perIp: config.storage.uploadPresignPerIpHour,
        windowMs: WINDOW_MS,
        backoffCeilingMs,
      }),
      // Identified by user id where there is one, for the same reason as
      // `geocode`/`document-upload` — but the common caller here is
      // anonymous (the route is `@Public()`), so the per-IP half is this
      // policy's primary defence, not a fallback for an edge case.
      'price-range': Object.freeze({
        perIdentifier: config.rateLimit.priceRangePerUserHour,
        perIp: config.rateLimit.priceRangePerIpHour,
        windowMs: WINDOW_MS,
        backoffCeilingMs,
      }),
      // Identified by user id. What this bounds is neither a bill nor a
      // credential guess: every created order broadcasts to nearby masters
      // (ADR-0009), so a loop here rings real phones, and the masters would
      // stop trusting the notification long before anyone found the cause.
      'order-creation': Object.freeze({
        perIdentifier: config.orders.createPerUserHour,
        perIp: config.orders.createPerIpHour,
        windowMs: WINDOW_MS,
        backoffCeilingMs,
      }),
      // Identified by user id — the budget belongs to the master whose trail
      // is being written, and one master with two devices must not get two
      // budgets for one person's movements. The per-IP half is much looser
      // than every other policy's on purpose: masters are on mobile networks
      // where a carrier NAT hides an unknown number of them behind one
      // address, so a tight per-IP number would throttle a city block for one
      // phone's bug. See `MASTER_LOCATION_RATE_LIMIT_PER_IP_HOUR`.
      'location-report': Object.freeze({
        perIdentifier: config.masterLocation.reportPerUserHour,
        perIp: config.masterLocation.reportPerIpHour,
        windowMs: WINDOW_MS,
        backoffCeilingMs,
      }),
      // Identified by user id — the budget belongs to the master responding,
      // and one master with two devices must not get two. What it bounds is
      // neither a bill nor a credential guess: on ADR-0009's
      // first-accept-wins model an unthrottled `accept` loop is how one
      // scripted client takes every job in the city from the masters
      // answering by hand. `location-report`'s reasoning for a loose per-IP
      // half applies unchanged — it is the same population behind the same
      // carrier NATs.
      'offer-response': Object.freeze({
        perIdentifier: config.masterOffers.responsePerUserHour,
        perIp: config.masterOffers.responsePerIpHour,
        windowMs: WINDOW_MS,
        backoffCeilingMs,
      }),
      // Identified by user id, like every other master-facing policy. This
      // one is **sized from a polling interval rather than from abuse**: the
      // offer feed is what an online master's app polls until EPIC 9's
      // realtime channel lands, so the budget has to be generous enough that
      // honest polling never reaches it — the default assumes a five-second
      // poll (720/hour) with headroom — while still being a ceiling, which a
      // route with no policy at all is not. See
      // `MASTER_OFFER_FEED_RATE_LIMIT_PER_USER_HOUR`.
      'offer-feed': Object.freeze({
        perIdentifier: config.masterOffers.feedPerUserHour,
        perIp: config.masterOffers.feedPerIpHour,
        windowMs: WINDOW_MS,
        backoffCeilingMs,
      }),
    }),
  });
}
