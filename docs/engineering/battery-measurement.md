# Measuring the location budget on a real shift

This is the procedure for issue #173. It replaces the location budget's
hypothesis in
[`realtime-architecture.md`](../architecture/realtime-architecture.md)
§ Location update budget with measured numbers.

It exists because a measurement nobody can repeat can only be argued with.
Follow the steps, fill in the results template at the end, and a later
measurement can be compared line by line with this one.

**This document is the method, not the result.** Nobody has run it yet. It
needs a physical mid-range Android phone and several hours of real use, and
no amount of code replaces that (#173 § Technical considerations).

## What is being measured

| Question                                                                                     | Why it matters                                                                           |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Battery drain per hour in each reporter state: `online`, `travelling`, `working`             | The budget table's whole justification.                                                  |
| Drain over a realistic shift                                                                 | EPIC 9's last acceptance criterion.                                                      |
| The cadence the phone **actually achieved** in each state, against the budget                | A floor that Android battery optimisation silently stretches breaks dispatch (ADR-0026). |
| How many times the reporter went stale, and for how long                                     | Whether the staleness warning fires in practice, and whether it fires wrongly.           |
| How the customer's marker feels at the travelling cadence, and whether fan-out can be slower | #173 asks whether `REALTIME_POSITION_FANOUT_SECONDS` can be relaxed.                     |

## The device

- **A physical mid-range Android phone**, bought as this market buys it. A
  flagship does not settle this (CLAUDE.md §12), and neither does an emulator,
  because an emulator has no GNSS radio and no battery.
- Record the **model, Android version, security patch level, battery capacity
  (mAh) and battery health** if the phone reports it.
- **Stock settings.** Leave battery optimisation for TezUsta **on**, as a new
  master's phone will have it. Its interference is a finding, not noise
  (#173). If time allows, a second run with optimisation off shows how much it
  costs.
- SIM with mobile data, Wi-Fi off, and brightness fixed at one value, recorded.
  Screen use is by far the largest drain, and it has to be the same between
  runs.

## The build

- A **release** build (`eas build --profile preview` or equivalent), not the
  dev client. The dev client's JS debugging and Metro connection distort both
  CPU and network.
- Record the commit SHA and the values of `LOCATION_BUDGET`
  (`apps/mobile/src/location/location-budget.ts`) that the build contains.
- The API it talks to runs with production defaults for
  `REALTIME_POSITION_FANOUT_SECONDS`, `MASTER_LOCATION_RATE_LIMIT_PER_USER_HOUR`
  and `PRESENCE_*`. Record them.

## The shift

About six hours, in this order, so every state gets a comparable stretch. The
times are targets; record what actually happened.

| Block | Duration   | What the master does                                                                                 | Reporter state          |
| ----- | ---------- | ---------------------------------------------------------------------------------------------------- | ----------------------- |
| A     | 60 min     | Online, phone locked in a pocket, stationary indoors                                                 | `online`                |
| B     | 60 min     | Online, moving around the city (walking or public transport), phone locked                           | `online`                |
| C     | 3 × 60 min | Three jobs. Each one: accept, ~20 min travelling with the phone locked, then ~40 min arrived/working | `travelling`, `working` |
| D     | 60 min     | Online again, stationary, app backgrounded and then **not reopened**                                 | `online` (background)   |

A second phone acts as the customer, to create the orders and watch the map
during block C.

## Collecting the numbers

Before the shift, with the phone charged to 100 % and connected over USB:

```bash
adb shell dumpsys batterystats --reset
adb shell dumpsys batterystats --enable full-wake-history
```

Unplug and start block A. Write down the battery percentage and the clock time
at every block boundary. Nothing needs to be connected during the shift.

After the shift, plug in and capture:

```bash
adb shell dumpsys batterystats > batterystats.txt
adb bugreport bugreport.zip          # for Battery Historian
```

- **Per-app drain.** Read the `Estimated power use (mAh)` section of
  `batterystats.txt` for the app's uid. Report the app's own mAh, not only the
  whole-phone percentage.
- **GNSS time.** Read the app's `Gps` / location on-time from the same dump.
  This is the number the `needsFreshFix` choice was made on.
- **Wakelocks and the foreground service.** Open `bugreport.zip` in
  [Battery Historian](https://github.com/google/battery-historian) and check
  that the location foreground service starts at each accept and stops at
  each completion. A service that outlives its job is a privacy bug, not a
  battery finding.

## The cadence the phone actually achieved

The server already records every accepted report. For the test master's id,
over the shift window:

```sql
select recorded_at,
       extract(epoch from recorded_at - lag(recorded_at) over (order by recorded_at)) as gap_s
  from master_locations
 where master_id = $1
   and recorded_at between $2 and $3
 order by recorded_at;
```

Split the gaps by block and report the **median, the 95th percentile and the
maximum** gap per block. Compare each against its floor: 90 s online, 12 s
travelling, 120 s working. A 95th percentile above
`DISPATCH_MAX_POSITION_AGE_SECONDS` in the `online` blocks means masters are
dropping out of dispatch.

`MASTER_LOCATION_TRAIL_MINUTES` prunes rows (default 60). **Raise it for the
test environment** before the shift, or export the rows at each block
boundary. Otherwise the first blocks will be gone before you query them.

## The customer's side

During each block-C travelling stretch, screen-record the customer phone's
order screen (#172's map). From each recording, note:

- whether the marker ever shows as stale while the master is moving;
- whether movement looks continuous or jumps;
- the visible lag behind the master's real position, estimated from a known
  landmark.

Then repeat one travelling stretch with `REALTIME_POSITION_FANOUT_SECONDS`
raised (for example to 30 s) and compare. That is the evidence for or against
a slower fan-out.

## Re-deriving the dependent values

The two values below are derived from the budget. Re-derive both from the
measured numbers, and **write the derivation down even when a value does not
change.**

- **`DISPATCH_MAX_POSITION_AGE_SECONDS`** (ADR-0026) = idle floor + one missed
  floor + 60 s tolerance. Today that is 120 + 120 + 60 = 300. The app's idle
  floor is 90 s, inside the documented 60–120 s band. If the achieved 95th
  percentile gap in blocks A, B and D is well above the floor, the bound has
  to cover it, or the floor has to be made to hold.
- **`MASTER_LOCATION_RATE_LIMIT_PER_USER_HOUR`** (default 600) must sit above
  the fastest state's reports per hour, with room for retries. Travelling at
  12 s is 300 floor reports an hour plus distance-filtered surplus. Count the
  measured peak reports in any one hour of block C and keep at least 1.5×
  headroom above it.

**A number that contradicts a decision, rather than tuning it, needs a new
ADR.** An example would be a floor that cannot be held on the market device
at all. Never edit an accepted ADR (CLAUDE.md §16).

## Results template

Copy this into #173 and into the budget section of
`realtime-architecture.md`, replacing the "requires field validation"
heading.

```
Device:           <model>, Android <version>, patch <date>, <capacity> mAh
Build:            <commit SHA>, release; LOCATION_BUDGET = <values>
Server:           FANOUT=<s>, RATE_LIMIT=<n>/h, PRESENCE_TTL=<s>
Settings:         battery optimisation <on|off>, brightness <value>, mobile data, Wi-Fi off
Date / duration:  <date>, <start>–<end>

Block | State        | Minutes | Battery % start→end | App mAh | GNSS on-time | Gap median / p95 / max (s)
A     | online       |         |                     |         |              |
B     | online (move)|         |                     |         |              |
C     | travelling   |         |                     |         |              |
C     | working      |         |                     |         |              |
D     | online (bg)  |         |                     |         |              |

Whole shift: <x> % over <y> h (<z> %/h); app share <mAh> of <mAh>
Stale warnings: <count>, longest <s>
Foreground service: started at each accept <yes|no>; stopped at each end <yes|no>
Marker at 12 s floor / 15 s fan-out: <observations>; at 30 s fan-out: <observations>
Derived: DISPATCH_MAX_POSITION_AGE_SECONDS <old> → <new> because <…>
         MASTER_LOCATION_RATE_LIMIT_PER_USER_HOUR <old> → <new> because <…>
```
