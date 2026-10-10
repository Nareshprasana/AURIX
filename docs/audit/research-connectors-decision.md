# Research Connectors — Decision Record (P1-8)

Date: 2026-10-10. Status: DECIDED (intake-only scope cut, no new connectors).

## Inventory (existing, no new code)

| Source | Purpose | Data | Access | Provenance |
|---|---|---|---|---|
| `TejBazaarProvider` (`aurix_ai/history.py`) | Historical EOD OHLCV for training/backtest datasets | NSE bhavcopy-derived JSON via public edge | No key; browser UA; rate-polite | Per-row source + fetch sha256 in fetch log; manifest records source/version |
| `Eod2Provider` (`aurix_ai/history.py`) | Secondary cross-validation (split/bonus-adjusted CSVs) | Static GitHub CSVs | No key | Same manifest treatment; cross-check diffs recorded |
| `jugaad-data` library | None in code (docs mention only, as unevaluated fallback) | — | — | Not vendored, not depended on |

## Options considered

1. **Build live NSE-announcement/filing fetchers.** Rejected: no approved source or cadence in architecture/Master Spec references; scraping risks ToS violations; no credentials may be invented; maintenance burden on a local-first box.
2. **Vendor `jugaad-data` as a live fetcher.** Rejected: adds an unaudited third-party runtime dependency with its own breakage modes for zero approved use case.
3. **Intake-only scope cut (chosen).** Research agents consume caller-supplied evidence by architectural design (Amendment: observations only; boundary lint forbids gateway/broker imports in research). Historical market data flows through the two inventoried providers above, which are already implemented, validated, and checksum-pinned.

## Decision

Research stays intake-only. Market-data acquisition stays with the two existing providers. No scraping, no new connectors, no credentials. Revisit only with an approved source + cadence + license review.

## Trade-offs

- Pro: no ToS risk, no new dependencies, deterministic offline behavior preserved.
- Con: research cannot self-refresh from live world events; event intelligence remains fixture/caller-fed until a sourced, licensed feed is approved.
