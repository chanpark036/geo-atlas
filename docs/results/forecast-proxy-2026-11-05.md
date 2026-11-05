# Subway forecast proxy results — 2026-11-05

These results compare MTA arrival-field forecast timestamps with inferred windows when the feed changed from approaching/in transit to stopped at the same station. They describe **proxy discrepancies in a selected sample**, rather than verified physical-arrival accuracy.

MTA's `arrival.time` can represent transit time at intermediate stops, which may target a different event from `STOPPED_AT`. Reporting lag is also unknown. Neither uncertainty is covered by the numerical window bounds. See the [MTA reference](https://api.mta.info/GTFS.pdf) and the [method and exclusions](../history.md#comparing-arrival-field-forecasts-with-reported-stops).

The [full aggregate JSON](forecast-proxy-2026-11-05.json) contains every route's coverage, all 30 scored route/horizon groups, the precise input hashes, capture windows and review record. It excludes individual forecast examples, raw packets, Parquet files and machine-specific paths.

## Sample and coverage

- Analysis code: [`e5cd468`](https://github.com/chanpark036/geo-atlas/commit/e5cd468b37947e31916292e7cf192b4b7de19867). Report generated at **2026-11-05T05:07:12.661127+00:00**.
- Inputs: eight locally recorded feed parts on **2026-11-03, approximately 19:05:58–19:13:45 UTC** (128 captures), plus **G feed, 2026-10-31 12:00–13:00 UTC** from Subway Data NYC (480 captures). This is a short live collection and one historical feed/hour, not continuous citywide history.
- Canonical data: **608 captures**, **825,373 arrival/departure forecast observations**, and **19,614 vehicle observations**.
- Arrival-field forecasts: **414,026 total**, **374,874 eligible**, and **39,152 excluded by eligibility checks**.
- Matched: **4,662 forecasts across 587 distinct reported stop events**; **1.24% of eligible forecasts**. Another **370,212 eligible forecasts** lacked a usable match.
- The 16 ACE captures were rejected by the live identity/reconciliation checks. Their raw evidence remains retained, but they do not drive these statistics. This does not establish whether the source data or our identity policy caused the rejection.
- Incomplete recording windows, forecasts for stops after recording ended, missing approach evidence and ambiguous cases can reduce coverage. Coverage is a property of this selected analysis, not an estimate of MTA reporting completeness.

## Forecasts issued 0–2 minutes before the first stopped report

All time statistics below are in **seconds**; variance is in **seconds squared**. Ranges are rounded, conditional bounds from the inferred stop windows, not observed minimum-to-maximum errors or statistical confidence intervals. Each forecast receives equal weight, so several forecasts may share one stop event.

| Route                      | Forecasts | Stop events | Mean absolute discrepancy | Median absolute discrepancy | p95 absolute discrepancy |
| -------------------------- | --------: | ----------: | ------------------------: | --------------------------: | -----------------------: |
| 1                          |       276 |          83 |               25.12–53.78 |                 21.00–51.00 |             74.00–106.25 |
| 2                          |       275 |          86 |               29.95–59.39 |                 23.00–53.00 |             85.00–115.00 |
| 3                          |       215 |          66 |               33.17–62.87 |                 26.00–56.00 |            100.20–130.20 |
| 4                          |       186 |          56 |               34.74–64.41 |                 32.00–64.00 |             81.25–111.25 |
| 5                          |       204 |          62 |               35.15–64.79 |                 28.00–59.00 |             95.00–125.00 |
| 6                          |       298 |          89 |               28.82–58.25 |                 26.00–56.00 |              69.00–99.00 |
| 6X                         |        87 |          26 |               29.59–59.37 |                 24.00–54.00 |              63.40–93.40 |
| 7                          |       186 |          54 |               38.10–66.92 |                 17.00–47.00 |            148.50–178.50 |
| GS (Grand Central Shuttle) |         6 |           2 |               21.17–51.17 |                 22.50–52.50 |              33.00–63.00 |
| L                          |       233 |          63 |               23.75–52.12 |                 19.00–49.00 |              69.40–99.40 |

| Route                      | Standard deviation | Population variance (s²) | Mean signed discrepancy | Within 60 seconds (%) |
| -------------------------- | -----------------: | -----------------------: | ----------------------: | --------------------: |
| 1                          |        27.34–49.74 |           747.45–2474.46 |        −48.09 to −17.82 |           69.93–90.22 |
| 2                          |        27.85–50.86 |           775.52–2586.64 |        −53.25 to −22.96 |           57.82–87.64 |
| 3                          |        27.01–52.48 |           729.40–2753.73 |        −57.99 to −27.58 |           54.88–82.33 |
| 4                          |        33.48–56.23 |          1121.21–3161.63 |        −54.46 to −24.09 |           46.24–84.41 |
| 5                          |        28.74–55.76 |           826.23–3108.78 |        −57.80 to −27.55 |           51.47–84.80 |
| 6                          |        18.52–41.35 |           343.06–1709.76 |        −55.95 to −25.79 |           57.72–91.61 |
| 6X                         |        11.03–34.36 |           121.64–1180.62 |        −59.37 to −29.23 |           54.02–88.51 |
| 7                          |        63.10–89.23 |          3981.86–7961.94 |         −24.34 to +5.80 |           60.75–79.03 |
| GS (Grand Central Shuttle) |        10.08–20.19 |            101.56–407.81 |        −51.17 to −21.17 |          83.33–100.00 |
| L                          |        13.37–42.37 |           178.83–1795.43 |        −51.79 to −21.79 |           75.11–91.85 |

Negative signed discrepancy means the reported-stop proxy precedes the arrival-field forecast timestamp; positive means it follows it. This does not by itself establish that physical-arrival forecasts were too early or too late. Standard deviation and population variance describe variation around the sample's mean signed discrepancy, rather than distance from zero.

The 7 route has a median absolute proxy discrepancy of **17.00–47.00 seconds**, but a p95 of **148.50–178.50 seconds**. Its standard-deviation bounds (**63.10–89.23 seconds**) exceed L's (**13.37–42.37 seconds**): discrepancies vary more for the 7 in this sample. That is a sample comparison of proxy discrepancies, not a ranking of route service quality or verified forecast accuracy. The Shuttle has only **two** matched stop events, too few to support a useful comparison.

## Longer forecast horizons

Horizon means time from forecast publication to the first stopped report, rather than time to a known physical arrival. The full JSON includes median, bias, p95, dispersion and threshold statistics for each horizon. This table summarizes mean absolute proxy discrepancy in seconds.

| Route                      | 0–2 minutes ahead | 2–5 minutes ahead | 5–10 minutes ahead |
| -------------------------- | ----------------: | ----------------: | -----------------: |
| 1                          |       25.12–53.78 |       33.13–62.19 |        27.58–56.81 |
| 2                          |       29.95–59.39 |       40.15–69.27 |        45.30–75.39 |
| 3                          |       33.17–62.87 |       41.04–70.50 |        62.58–93.11 |
| 4                          |       34.74–64.41 |       40.73–70.39 |        51.86–81.27 |
| 5                          |       35.15–64.79 |       48.36–77.36 |        46.64–76.64 |
| 6                          |       28.82–58.25 |       28.46–57.41 |        37.27–66.76 |
| 6X                         |       29.59–59.37 |       38.90–68.97 |        51.74–81.49 |
| 7                          |       38.10–66.92 |       56.57–84.82 |        61.19–87.53 |
| GS (Grand Central Shuttle) |       21.17–51.17 |        6.71–36.71 |         2.00–32.00 |
| L                          |       23.75–52.12 |       25.99–54.28 |        30.39–59.53 |

No 10+ minute comparisons were available in this snapshot. Counts and stop-event membership differ across horizons; an apparent increase is not a controlled comparison of the same events.

## Route coverage across all horizons

Coverage below is matched forecasts divided by eligible arrival-field forecasts. Stop events are distinct trip/station matches across all horizons; they should not be summed again across horizon groups.

| Route                      | Eligible forecasts | Matched forecasts | Matched stop events |                    Coverage |
| -------------------------- | -----------------: | ----------------: | ------------------: | --------------------------: |
| 1                          |             12,920 |               653 |                  83 |                       5.05% |
| 2                          |             15,414 |               642 |                  86 |                       4.17% |
| 3                          |              8,757 |               521 |                  66 |                       5.95% |
| 4                          |              7,824 |               465 |                  56 |                       5.94% |
| 5                          |             10,827 |               453 |                  62 |                       4.18% |
| 6                          |             12,013 |               728 |                  89 |                       6.06% |
| 6X                         |              3,315 |               210 |                  26 |                       6.33% |
| 7                          |              7,764 |               428 |                  54 |                       5.51% |
| 7X                         |                 88 |                 0 |                   0 |                       0.00% |
| A                          |                  0 |                 0 |                   0 | N/A (no eligible forecasts) |
| B                          |             12,716 |                 0 |                   0 |                       0.00% |
| C                          |                  0 |                 0 |                   0 | N/A (no eligible forecasts) |
| D                          |             15,020 |                 0 |                   0 |                       0.00% |
| E                          |                  0 |                 0 |                   0 | N/A (no eligible forecasts) |
| F                          |             19,308 |                 0 |                   0 |                       0.00% |
| FS                         |                818 |                 0 |                   0 |                       0.00% |
| G                          |            166,975 |                 0 |                   0 |                       0.00% |
| GS (Grand Central Shuttle) |                219 |                19 |                   2 |                       8.68% |
| H                          |                  0 |                 0 |                   0 | N/A (no eligible forecasts) |
| J                          |              8,251 |                 0 |                   0 |                       0.00% |
| L                          |              7,272 |               543 |                  63 |                       7.47% |
| M                          |             14,486 |                 0 |                   0 |                       0.00% |
| N                          |             11,664 |                 0 |                   0 |                       0.00% |
| Q                          |             10,885 |                 0 |                   0 |                       0.00% |
| R                          |             19,920 |                 0 |                   0 |                       0.00% |
| SI                         |              2,068 |                 0 |                   0 |                       0.00% |
| W                          |              6,350 |                 0 |                   0 |                       0.00% |

Routes without matched stop events have **no discrepancy score**. A zero-coverage row does not mean zero discrepancy or perfect forecasts. In particular, the G historical hour adds many forecasts but no usable approach-to-stopped windows under the current strict rules. The report checks 27 route IDs present in these inputs, rather than claiming a score for all 29 route IDs supported by the live catalog.

## Verification and reproduction

An independent implementation reconstructed matches from canonical Parquet without calling `accuracy.py`, reproduced **420 metric values across 30 route/horizon groups**, and checked **3,000 randomized shared-arrival assignments** against the uncertainty bounds. Results agreed within two-decimal rounding tolerance. All **39 Python tests** passed. The review identified the arrival/transit target mismatch, now disclosed above and in the report metadata. This was a local review, not an active CI run.

The fixed within-event variance and uncertain between-event variance preserve the shared clock among forecasts about one stop event. Bounds are conservative; they are not statistical confidence intervals. The p95 uses continuous sample-quantile interpolation, so the interpolated value does not guarantee that at least 95% of a small finite sample lies at or below it.

To recompute with the original input dataset at the linked analysis commit:

```sh
uv sync --project analytics --frozen
pnpm history accuracy --dataset .data/history/parquet --output .data/history/reports/accuracy.json
```

Exact reproduction requires the nine original input batches identified in the JSON. These raw and Parquet files are retained locally and are not included in this commit. A fresh collection or another sampling interval can produce different results. The public historical source is [Subway Data NYC](https://subwaydata.nyc/programmatic-access); the selected G archive is identified by SHA-256 in the JSON and in the [existing pipeline benchmark](../benchmarks/history-sample.json).
