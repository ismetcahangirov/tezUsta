/**
 * Parses an RFC 9110 §12.5.4 `Accept-Language` header into an ordered list of
 * language preferences, expressed as lowercased primary subtags (`en-GB`
 * becomes `en`).
 *
 * **Why primary subtags rather than full BCP 47 tags**: `resolveLocalizedText`
 * (`./resolve-localized-text.ts`) matches against `LocalizedText`, which is
 * keyed by ISO 639-1 code (`az`, `en`) — the language set a translator fills
 * in, not the region variants a browser sends. A caller who asks for `en-GB`
 * and a row translated only into `en` should still get that translation;
 * collapsing to the primary subtag here is what makes that match happen,
 * once, in the one place that knows about headers, rather than in every
 * caller of the resolver.
 *
 * **Why this is framework-free**: this file has no Nest, Fastify or HTTP
 * import on purpose. A header is just a string wherever it comes from, and
 * keeping this pure is what lets it be unit-tested without spinning up a
 * request pipeline, and moved into `packages/validation` (ADR-0016) as a file
 * move rather than a rewrite the day a second consumer needs it.
 *
 * **Why this is defensive rather than a straightforward parser**: an
 * `Accept-Language` header is attacker-controlled input reaching a public
 * catalogue endpoint before any authentication runs. Nothing below may throw,
 * and nothing below may cost more than a bounded, linear amount of work — see
 * `MAX_SEGMENTS` and `MAX_TAG_LENGTH`.
 */

/**
 * Upper bound on how many comma-separated segments are parsed. A header is
 * free-form attacker-controlled text; without a cap, `"a,a,a,a,…"` repeated
 * thousands of times would make this function do proportionally unbounded
 * work on every request that carries it. Twenty is far more than any real
 * browser or client sends — Chrome and Firefox both send under six — so this
 * never clips a legitimate preference list.
 */
const MAX_SEGMENTS = 20;

/**
 * Upper bound on a single language tag's length. BCP 47 tags are short in
 * practice (`en`, `az-Latn-AZ`); 35 characters is a generous practical cap
 * used by other implementations (e.g. Node's own `Intl.Locale`) and rejects
 * the pathological long strings a hostile header could otherwise pack into
 * every segment.
 */
const MAX_TAG_LENGTH = 35;

/**
 * A BCP 47 language tag, loosely: a 2-3 letter primary subtag followed by any
 * number of 2-8 character alphanumeric subtags. This is deliberately looser
 * than the full BCP 47 grammar (it does not distinguish script, region and
 * variant subtags) — this module only ever needs the primary subtag, so
 * accepting a superset of valid tags and then taking the first segment is
 * simpler than implementing the full grammar and gives the same answer.
 */
const TAG_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

/**
 * One successfully parsed `language-range[;q=value]` segment, before
 * duplicate primary subtags are collapsed.
 */
interface ParsedPreference {
  /** Lowercased primary subtag — the only part `resolveLocalizedText` uses. */
  readonly primary: string;
  /** Quality value in `(0, 1]`. `q=0` segments never reach this shape. */
  readonly q: number;
  /**
   * Position among the segments that were actually parsed. Used purely as a
   * tie-break so that two preferences of equal `q` keep the order the caller
   * sent them in — `Array.prototype.sort` is stable in every engine this
   * repository targets, but an explicit index tie-break makes that guarantee
   * a property of this code rather than of the runtime, and survives someone
   * later swapping the sort for something that is not stable.
   */
  readonly index: number;
}

/**
 * Parses one comma-separated segment (`"en-GB;q=0.8"`) into a preference, or
 * `undefined` if the segment should be dropped — because it is empty, the
 * wildcard, structurally malformed, or carries an unusable `q`.
 *
 * Returning `undefined` rather than throwing is the point of this function:
 * one bad segment in a header must never take down every other, well-formed
 * segment alongside it.
 */
function parseSegment(rawSegment: string, index: number): ParsedPreference | undefined {
  const trimmedSegment = rawSegment.trim();
  if (trimmedSegment.length === 0) {
    return undefined;
  }

  const parts = trimmedSegment.split(';').map((part) => part.trim());
  const tag = parts[0];
  if (tag === undefined || tag.length === 0) {
    return undefined;
  }

  // `*` means "anything is acceptable", which tells a fallback-based resolver
  // nothing about which language to prefer — it carries no signal, so it is
  // dropped rather than kept as a preference.
  if (tag === '*') {
    return undefined;
  }

  if (tag.length > MAX_TAG_LENGTH || !TAG_PATTERN.test(tag)) {
    return undefined;
  }

  // `q` defaults to 1 when absent (RFC 9110 §12.4.2). Every parameter after
  // the tag is scanned for it; a header may in principle carry other
  // parameters, and Accept-Language has none that matter here, so anything
  // that is not a `q` parameter is ignored rather than treated as a reason to
  // distrust the whole segment.
  let q = 1;
  for (const param of parts.slice(1)) {
    if (param.length === 0) {
      continue;
    }

    const qMatch = /^q=(.*)$/i.exec(param);
    if (qMatch === null) {
      continue;
    }

    const qValueText = qMatch[1];
    const qValue = qValueText === undefined || qValueText.length === 0 ? NaN : Number(qValueText);

    // A `q` that does not parse as a finite number in [0, 1] makes the whole
    // segment malformed — `az;q=abc` and `az;q=` both land here — rather than
    // silently substituting a default, which would let a typo'd, supposedly
    // low-priority preference win as if it had been sent as `q=1`.
    if (!Number.isFinite(qValue) || qValue < 0 || qValue > 1) {
      return undefined;
    }

    q = qValue;
  }

  // `q=0` is RFC 9110's explicit spelling of "not acceptable at all" — the
  // one case where an explicit value, not a parsing failure, means "drop
  // this tag", so it is handled after parsing succeeds rather than folded
  // into the malformed-value check above.
  if (q === 0) {
    return undefined;
  }

  const primary = (tag.split('-')[0] ?? tag).toLowerCase();
  return { primary, q, index };
}

/**
 * Parses an `Accept-Language` header value into the caller's language
 * preferences, most-preferred first, as lowercased primary subtags.
 *
 * `header` is `string | undefined` because that is exactly what reading a
 * possibly-absent HTTP header looks like at the call site — this module
 * takes the raw value so the caller does not need a framework-specific
 * "header present" check before calling in.
 */
export function parseAcceptLanguage(header: string | undefined): readonly string[] {
  if (header === undefined) {
    return [];
  }

  const trimmedHeader = header.trim();
  if (trimmedHeader.length === 0) {
    return [];
  }

  const segments = trimmedHeader.split(',').slice(0, MAX_SEGMENTS);

  const parsed: ParsedPreference[] = [];
  segments.forEach((segment, index) => {
    const preference = parseSegment(segment, index);
    if (preference !== undefined) {
      parsed.push(preference);
    }
  });

  // Collapse duplicate primary subtags (`en-GB` and `en` both mean `en`),
  // keeping whichever occurrence carries the higher `q`. On a tie, the first
  // occurrence already holds the slot — a `Map` never revisits a key it has
  // already set unless this loop overwrites it — so first-seen wins without
  // extra bookkeeping.
  const byPrimary = new Map<string, ParsedPreference>();
  for (const preference of parsed) {
    const existing = byPrimary.get(preference.primary);
    if (existing === undefined || preference.q > existing.q) {
      byPrimary.set(preference.primary, preference);
    }
  }

  return Array.from(byPrimary.values())
    .sort((a, b) => (b.q !== a.q ? b.q - a.q : a.index - b.index))
    .map((preference) => preference.primary);
}
