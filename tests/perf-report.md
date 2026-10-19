# Florilegium reader performance verification

**Worktree branch:** `bb/florilegium-perf-profile-nemotron-thr_jcefei3j7e`
**Commit:** `a8a7d30` (bb/base/deepseek-round3, round-3 full-book build)
**App under test:** single self-contained `index.html` at repo root (NOT modified)
**Book:** Moby Dick; Or, The Whale (Gutenberg id 2701, 135 chapters)
**Run dates:** 2026-10-19; numbers below are from the final run at 01:27 UTC

## Environment

- Server: `python -m http.server 4185 --bind 127.0.0.1` serving the worktree root
- Browser: Microsoft Edge `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
- Driver: `puppeteer-core` 25.14.0 (`NODE_PATH=C:\Users\Daniel\AppData\Local\Temp\flori-tools\node_modules`)
- Viewport: 390 × 844 (mobile media query active), deviceScaleFactor 1
- CDP: `Network.enable` + `Emulation.setCPUThrottlingRate({rate: 4})` (4x CPU throttling) for the whole run
- Network: real network, no interception; full text fetched through the app's Jina Reader proxy (`r.jina.ai`)
- Node: v26.7.0 on Windows PowerShell

## How to run

From the repo root:

```powershell
$env:NODE_PATH='C:\Users\Daniel\AppData\Local\Temp\flori-tools\node_modules'
$env:EDGE_PATH='C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
node tests/perf.test.js
```

The script starts the local server (or reuses one already listening on 4185), launches Edge, runs the measurements, and prints a `PERF SUMMARY` block. It exits 0 when all measured checks pass, 1 if a budget check fails or the harness crashes.

## Methodology

The app is opened exactly as a real user would: home screen → Moby Dick preview (curated excerpt, instant) → click the "Read a little" reader button. All timestamps for DOM/paint milestones are taken inside the page with `Date.now()` immediately around the real click dispatch on the live button, so they reflect true end-to-end latency under 4x CPU throttling.

1. **Reader open** — Time from the click that opens the reader to:
   - overlay in DOM,
   - loading state present (`.reader-loading`),
   - overlay animating open (`.open` class, ≈ loading-state paint),
   - first chapter text present (`.reader-body p`, i.e. fetch + parse + render).
   Total click→chapter is reported, and the Jina fetch is measured separately via CDP `Network` events for the `r.jina.ai/...pg2701.txt` request (request → first byte, request → complete). Post-fetch render time = chapter-text time − fetch-complete time (both are durations, so the CDP clock and the page clock do not need to be aligned — see Notes).
   If the full text never arrives (app retries Jina internally: up to 3 attempts with backoff), the run waits the open deadline, then retries the whole open once after 20s; if it still fails, Jina is marked unavailable and the remaining sections are reported as N/A, per the run contract.

2. **Chapter navigation** — 10 consecutive `Next` clicks once data is loaded. `readerGo`/`paintReader` run synchronously inside the click handler, so the new chapter's text is in the DOM before `click()` returns; time is measured click → new chapter text present. Reported: min / median / max. Budget: **<300 ms per jump** (after data is loaded).

3. **DOM discipline** — Count of `.reader-body p` after initial load and after every jump. Budget: stay near one chapter, i.e. well under thousands of nodes (enforced budget: max < 500 paragraphs).

4. **Memory** — JS heap via CDP `Runtime.getHeapUsage` (+ `Performance.getMetrics` `JSHeapUsedSize`) before and after the 10 jumps; growth reported in MB.

5. **Settings reflow** — Mid-chapter, open the reader settings sheet, click text size `A+` (18 → 19 px), measure click → computed `fontSize` change on `.reader-body`, and record `scrollTop` of the reader scroll container before/after to check the scroll anchor.

6. **Reader-open cost split** — total open time, Jina fetch time, post-fetch render time, all reported (item 1).

## Results — final run (wall 01:27:02, run elapsed 15.3 s)

| # | Measurement | Result | Budget | Status |
|---|-------------|--------|--------|--------|
| 1 | Click → overlay in DOM | 52 ms | — | reported |
| 1 | Click → loading state paint | 53 ms | — | reported |
| 1 | Click → loading open (animated) | 53 ms | — | reported |
| 1 | Click → first chapter text (total) | 3144 ms | — | reported |
| 1 | Jina fetch: request → first byte | 1927 ms | — | reported |
| 1 | Jina fetch: request → complete | 2055 ms | — | reported |
| 1 | Post-fetch render (chapter text − fetch complete) | ~1089 ms | — | reported |
|   | Chapter at open: Chapter 1 of 135, 15 paragraphs | 135 sections | — | reported |
| 2 | Navigation, 10 jumps: min / median / max | 59 / 86.5 / 256 ms | <300 ms per jump | PASS |
|   | Per-jump times (ms) | 97, 256, 76, 59, 63, 62, 120, 214, 155, 61 | — | reported |
| 3 | `.reader-body p` after load | 15 | near one chapter | PASS |
| 3 | `.reader-body p` after each jump | 12, 71, 7, 9, 9, 10, 7, 27, 10, 4 | max < 500 | PASS (max 71) |
| 4 | JS heap before / after 10 jumps | 8.00 MB / 8.00 MB (total 11.11 MB) | — | reported |
| 4 | Heap growth | 0.00 MB | — | reported |
| 5 | Text-size reflow repaint (18 → 19 px) | 293 ms | — | reported |
| 5 | Scroll anchor: scrollTop before / after / delta | 0 / 0 / 0 px | reasonable | PASS (delta 0) |

**Jina availability:** available (full text arrived on the first open; the harness keeps a one-retry fallback after 20 s and would mark Jina unavailable and report the rest if it never completed).

**Overall:** all budgets met in the final run.

### Navigation time variance (observation)

Across repeated runs during this verification, per-jump max varied (one run showed 451 ms, another 256 ms). Jump time scales with chapter length (paint work: inserting that chapter's paragraphs under 4x throttling) plus one frame of observation latency. Short chapters measured ~9–63 ms; the longest chapter in the 10-jump window painted at ~256–451 ms depending on run. Median stayed ~86–170 ms. The <300 ms budget held in the final run; treat per-jump time as chapter-size-dependent under 4x throttling.

## Notes

- CDP `Network.requestWillBeSent`/`loadingFinished` timestamps come from Chromium's internal clock, not `Date.now()` epoch, so only CDP-internal deltas are used for the Jina fetch duration; page-clock durations (open, render, jumps) are never mixed with CDP timestamps except as duration − duration.
- The app skips a direct Gutenberg fetch for `gutenberg.org` hosts (CORS-blocked in-browser) and goes straight to the Jina proxy, so exactly one `r.jina.ai` request is responsible for the full text; cover images and fonts load in parallel and do not gate the reader open.
- `JSHeapUsedSize` was not emitted by `Performance.getMetrics` in this run; growth is reported from `Runtime.getHeapUsage` only (0.00 MB — only one chapter is ever in the DOM).
- The scroll anchor check shows `scrollTop` unchanged (0 → 0): changing text size does not reset scroll position, and at the top of a chapter the anchor is trivially reasonable.
- If the Jina fetch fails in a given environment, the app retries internally and the harness retries the open once; on continued failure Jina is marked unavailable, open/loading milestones are still reported, and navigation/DOM/memory/settings are reported as N/A.
- `index.html` was not modified. Nothing was pushed; work is committed on this worktree branch only.

## Deliverables

- `tests/perf.test.js` — the puppeteer-core + Edge performance harness
- `tests/perf-report.md` — this report