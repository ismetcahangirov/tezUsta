# ADR-0071 — Hosting: DigitalOcean Frankfurt, once a lawyer clears hosting abroad

- **Status:** **Proposed**
- **Date:** 2026-10-28
- **Decided by:** Not yet. The owner decides once a lawyer has answered § 1.
- **Context:** issue [#467]; blocks EPIC 17 ([#18]) and the production half of EPIC 20 ([#327])

[#467]: https://github.com/ismetcahangirov/tezUsta/issues/467
[#18]: https://github.com/ismetcahangirov/tezUsta/issues/18
[#327]: https://github.com/ismetcahangirov/tezUsta/issues/327

## Context

Nothing runs anywhere but a laptop. EPIC 17 needs staging and production, and
"Hosting / cloud provider" is on CLAUDE.md § 1's list of open decisions.

**What has to run** is already containerised and provider-neutral (ADR-0052,
ADR-0056):

- the API and its BullMQ workers: 2+ stateless containers behind a load
  balancer that carries WebSockets;
- Postgres 17 with PostGIS: managed, with point-in-time restore and a standby;
- a Redis-compatible store, for BullMQ, presence, rate limits and pub/sub;
- the admin SPA on the API's origin, and the web subscription page;
- LiveKit for voice calls (ADR-0034);
- object storage, already chosen separately (ADR-0005 recommends Cloudflare R2).

**What it holds.** Phone numbers, home addresses, live positions of masters,
order photos of the inside of homes, and masters' identity documents. That is
why the legal question in § 1 comes first.

**Latency from Baku.** On 27 October 2026 the owner's network measured the best
TCP connect over 5 tries as 79 ms to AWS Frankfurt, 81 ms to Hetzner Falkenstein
and 77 ms to AWS Milan. Gulf regions are slower: 178 ms to AWS UAE. None of AWS,
Google Cloud or Azure has a region in Azerbaijan. The full table is on #467.

## Decision (proposed)

### 1. A lawyer answers the residency questions before any account is opened

The Law on Personal Data (No. 998-IIIQ of 11 May 2010) was read on
28 October 2026, in the text consolidated to the amendment of 17 February 2023.
Several commercial guides say personal data must stay on servers in Azerbaijan;
**that text has no such clause.** What it does have:

| Article   | What it says                                                                                                                                                          | Why it matters here                                                                 |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 14.2      | Cross-border transfer is **prohibited** if it threatens national security, or if the receiving country's law does not protect the data to the level Azerbaijan's does | A host in Frankfurt is a transfer to another country                                |
| 14.3      | Transfer is allowed **regardless of the protection level** when the data subject consents, or to protect their life and health                                        | Consent at sign-up is a possible basis                                              |
| 15.1–15.2 | A personal-data information system must be **registered** with the competent executive body; collecting data without registration is prohibited                       | Applies wherever the system is hosted                                               |
| 9.14      | Forming personal-data information resources, creating information systems and serving them requires a **special permit (licence)**                                    | It is unclear whether this binds a private app's own database or only service firms |

A secondary law-tracking source lists an amendment of 28 June 2024 that
changed the rules on cross-border transfer. Its text was not found. A new
data-protection law was reported in draft and under review in October 2025.

**The questions for the lawyer.** They join the legal review already owed for
SMS (ADR-0059), which sends phone numbers to Plivo and Twilio abroad:

1. May TezUsta's database be hosted in the EU (Germany)? Is Germany's protection
   "adequate" under 14.2.2? Who decides that?
2. If not, does explicit consent at sign-up (14.3) suffice? What must the
   consent text say?
3. Does 15.1 registration apply to TezUsta? Does it apply before the pilot,
   which has fewer users?
4. Does 9.14's licence apply to TezUsta itself?
5. Did the June 2024 amendment, or the draft new law, add a localization
   requirement?
6. The same questions for the processors already chosen or proposed:
   Cloudflare R2 (photos, identity documents), Plivo and Twilio (phone numbers),
   Google Maps (addresses for geocoding), and LiveKit Cloud (call audio and
   metadata).

**If the answer is that data must stay in Azerbaijan, §§ 2–3 fall away.** Only
a host in Baku would qualify. No managed Postgres was found there: AzInTelecom
documents virtual servers and backup, mostly for government customers. TezUsta
would then run Postgres, Redis and backups itself on rented servers, and
EPIC 17's estimate grows to match.

### 2. If hosting abroad is allowed: DigitalOcean, Frankfurt (FRA1)

| Component             | Service                                                                      |
| --------------------- | ---------------------------------------------------------------------------- |
| Postgres 17 + PostGIS | Managed PostgreSQL, **Standard** edition, primary + standby                  |
| Redis-compatible      | Managed Valkey                                                               |
| API, admin, web       | App Platform or Droplets behind a load balancer that carries WebSockets      |
| Staging               | Same region; smallest sizes; no production third-party credentials (EPIC 17) |

### 3. LiveKit: LiveKit Cloud for the pilot

It removes running TURN and UDP ports ourselves. Revisit when call volume makes
usage pricing matter. Self-hosting stays possible: the server side already runs
against a self-hosted LiveKit in docker-compose and CI (ADR-0038).

## Why

- **DigitalOcean is the simplest host that meets EPIC 17's hard requirements.**
  It has managed Postgres 17 with PostGIS, a Redis-compatible store, backups
  with restore, and a WebSocket-capable load balancer.
  - PostGIS for PostgreSQL 14–17 is listed in the Standard edition. The
    Advanced edition restricts `CREATE EXTENSION`, so it must be Standard.
  - Listed prices start at $15.15/month for Postgres and $15/month for Valkey.
- **Frankfurt is as close as anything that is managed.** It is ~80 ms from
  Baku, the same as AWS Frankfurt. EU law is the strongest case for 14.2.2
  adequacy.
- **AWS meets everything too**, at more cost and setup, for a scale the pilot
  does not have.
- **Hetzner is cheaper but has no managed Postgres.** EPIC 17's "managed PostGIS"
  and "a tested restore" would be our own operations from day one.
- **Leaving is a migration, not a rewrite.** The images are provider-neutral, and
  nothing in the code names a host.

## Alternatives considered

| Option                                | Why not                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| AWS Frankfurt (RDS, ElastiCache, ECS) | Meets every requirement; more line items, cost and IAM setup than a pilot needs                           |
| Hetzner Falkenstein                   | No managed Postgres or Redis: backups, failover and upgrades become ours                                  |
| Google Cloud / Azure                  | No Azerbaijan region either; no advantage over Frankfurt for this workload                                |
| AWS UAE / Gulf regions                | 178 ms from Baku, more than twice Frankfurt                                                               |
| AzInTelecom (Baku)                    | Local, but no managed Postgres found and prices not public. **The only option if § 1 requires residency** |

## Trade-offs accepted

- **A US company holds the data, in Germany.** DigitalOcean is subject to US law,
  and the lawyer's answer to § 1 should cover that.
- **~80 ms** to every request from Baku, compared with a few milliseconds locally.
  For a dispatch app on mobile networks this is small, and no local host offers
  the managed services.
- **A pilot cost of roughly $100–200/month** from listed prices, before LiveKit.
  This is an estimate, not a quote.
- **Managed limits:** DigitalOcean's extension list and Postgres versions bound
  what migrations can use.

## Consequences

- **Accepting this ADR** moves "Hosting / cloud provider" from CLAUDE.md § 1's
  open list to the settled one, and updates the roadmap.
- **EPIC 17 sub-issues follow, to be checked on a real cluster before building
  on it:**
  - PostGIS ≥ 3.5, and every migration's GiST indexes and `ST_*` functions apply
    (`select postgis_full_version()`);
  - BullMQ runs on Valkey: run the API's queue tests against it;
  - a WebSocket outlives the load balancer's idle timeout with the realtime
    heartbeat;
  - a restore drill: restore a backup into a scratch cluster and serve traffic
    from it.
- **If § 1 allows hosting abroad only with consent,** the sign-up flow gains a
  consent step (owner copy) before the first real user.

## Revisit when

- The lawyer answers § 1, or the new personal-data law is adopted.
- A cloud with managed Postgres opens a region in Azerbaijan or the Caucasus.
- Load or cost outgrows DigitalOcean's managed tiers.
