# Historical Market Data — source evaluation, schema, policy

## Evaluated repositories

| Repo | Coverage | Format/access | Maintenance | Verdict |
|---|---|---|---|---|
| `tejhq/tej-bazaar` | NSE 2010→today, BSE 2024-07→today; corp actions, back-adjusted closes, symbol history, point-in-time top-500 universe; daily cron; Yahoo-reconciled 96.88% ±1% | Parquet on HF (`tejhq/indian-markets`), R2 bulk, REST edge JSON; MIT code | Active (daily cron, 2026) | **PRIMARY** |
| `BennyThadikaran/eod2_data` | NSE EOD, split/bonus-adjusted CSVs, delivery data, ISIN map; weekly updates; sourced from NSE daily reports | Static CSVs on GitHub raw | Active (weekly) | **SECONDARY validation** |
| `ancap97/NSEDATA4ME` | NSE 2005→today, delisted incl. (survivorship-free claim), adj_factor, delivery, indices; ~430 MB snapshot on `data` branch | Parquet, pandas+pyarrow read path; GPL-3.0 | New, 0 stars, single maintainer | Alternative (heavier fetch, GPL) |
| `rahulkanadia/IndianMarkets_DataBackfill` | Nifty-500 1-min 2018→2025 (+indices) | Parquet (needs pyarrow/pandas) | Data dump, yearly repos | Intraday scope only; too heavy for phase 1 |
| `jugaad-py/jugaad-data` | Live + historical via new NSE site (stocks, F&O, indices, RBI/AMFI); 584 stars, maintained, CLI+lib | Live scraping (rate-limited, breakage-prone) | Active | Fallback live-fetcher, not the archive |
| `olo-labs/olo-testdata-nse` | 2 stars, no description, 2.8 MB, created 2026-08 | Test fixtures | — | Unsuitable (fixtures, not history) |
| Extras found: `marketcalls/openchart` (live API lib), `NSEDownload/NSEDownload`, `aswinv90/indian-market-historical-data` (static 1991+ dump) | — | — | — | Noted, not needed |

Selection rationale: tej-bazaar maximizes coverage × maintenance × local-first
access × licensing (MIT code; exchange bhavcopy claimed redistributable) with
adjustment/survivorship infrastructure upstream; eod2_data gives dependency-free
CSV cross-validation. Provider interface (`HistoricalDataProvider.fetch`)
stays vendor-neutral so NSEDATA4ME can be added later without touching callers.

## Schema (validated rows)

`symbol, date(YYYY-MM-DD), open, high, low, close, volume, turnover, trades,
adjusted:bool, source, ts(ms, derived)` → training bars / `DatasetBar`
(`instrument_id=NSE_EQ_<SYM>`, spread/`adv` as below).

## Adjustment policy

- tej-bazaar edge JSON: **raw bhavcopy, unadjusted** (`adjustment_policy:
  none-raw-bhavcopy`). Splits/bonuses/dividends/rights/symbol-changes are NOT
  applied by this adapter; upstream adjusted trees are parquet-only.
- eod2_data: **split/bonus-adjusted** (per its README; dividends unadjusted).
- Manifest records which representation was used. Never fabricated.
- Proof finding: RELIANCE cross-check showed ~50% pre-Oct-2024 divergence —
  the 1:1 bonus ex Oct-2024 — confirming tej=raw vs eod2=adjusted. INFY
  diff 0.0% (no 2022–2024 actions). The check works as designed.

## Survivorship bias

- tej edge serves currently-listed symbols; delisted names are NOT covered by
  this adapter → **limitation documented, not claimed bias-free**.
- Upstream tej-bazaar publishes a point-in-time monthly top-500 universe
  (explicitly survivorship-bias-free) and NSEDATA4ME ships delisted names —
  both are the documented upgrade paths; current proof universe (2 liquid
  large-caps) is for pipeline proving only.

## Quality gates

`validate_rows` → `PASS` / `QUARANTINE` (with reasons, preserved) / `BLOCK`.
Detects: malformed/duplicate/out-of-order timestamps, non-positive or
non-finite OHLC, negative volume, impossible OHLC (`high<max(O,C)` etc.),
missing weekdays (reported as evidence — the proof's 45 gaps are NSE holidays,
not corruption). Nothing is silently deleted: `n_raw == n_clean +
n_quarantined(non-gap)`.

## Point-in-time / leakage

Rows expose only date-T published values; features reuse `datasets.py`
(causal, indices ≤ T); labels use T+N closes only in the target; scaler fit on
TRAIN only; chronological splits asserted; adv trailing-20d includes T only.
Backtest run confirmed executions strictly after signal bars (and entries
correctly blocked on UNKNOWN spread per engine rules).

## Versioning / reproducibility

`source → raw (sha256 logged) → validated → features → manifest(version =
content hash) → checksum`. Rewrites with differing bytes are refused; spec
changes yield new versions. Initial proof dataset:
`aurix-nse-daily-0cd820389cb2` (RELIANCE+INFY, 2022-01-01→2024-12-31,
1476 bars → 1426 feature rows, checksum `2b0d972e…`, adjustment=raw).
Raw/processed/datasets live under `data/` (gitignored); only small manifests
are committed.

## Licensing

- tej-bazaar code MIT; data = exchange bhavcopy claimed redistributable —
  verify exchange terms before commercial use. AURIX stores locally, no
  redistribution claimed. `LICENSE_STATUS(data-redistribution) = UNKNOWN`
  for third-party sharing.
- eod2_data: no explicit license file found; NSE terms apply; local use only.
- NSEDATA4ME is GPL-3.0 (not vendored; kept at arm's length as a future
  optional source to avoid license contagion in this MIT-licensed repo).
