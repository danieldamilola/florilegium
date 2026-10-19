# Florilegium acceptance tests

End-to-end acceptance suite for the single-file app at the repo root
(`index.html`), driven with **puppeteer-core + Microsoft Edge** at the approved
mobile viewport **390 × 844**.

The suite exists to hold the line on one thing above all: **the reader must
show the whole book, not a preview.** The prototype sliced 14 paragraphs
(`renderReaderBody`), previews showed 3, and the reader ended with
"End of preview — the full text is free at Project Gutenberg". Those are the
exact regressions these tests fail on.

## Run

```powershell
$env:NODE_PATH="C:\Users\Daniel\AppData\Local\Temp\flori-tools\node_modules"
node --test tests/e2e.test.js
```

(The test file must be named explicitly — `node --test tests/` resolves the
directory as a module on Node 26.)

Single group:

```powershell
$env:NODE_PATH="C:\Users\Daniel\AppData\Local\Temp\flori-tools\node_modules"
node --test --test-name-pattern="^reader" tests/e2e.test.js
```

Helper self-check alone:

```powershell
node tests/check-helpers.js
```

Environment overrides:

| var | default | meaning |
| --- | --- | --- |
| `NODE_PATH` | — | must contain `puppeteer-core` |
| `FLORI_PORT` | `4181` | port for `python -m http.server` (reuses an already-listening port) |
| `FLORI_EDGE` | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` | browser binary |
| `FLORI_LIVE` | unset | `1` = hit the real Gutendex/Gutenberg instead of the stub |

No install step and no `package.json` on purpose: the repo is a single HTML file.

## Files

| file | role |
| --- | --- |
| `tests/e2e.test.js` | the 19 acceptance cases |
| `tests/helpers.js` | static server, Edge launcher, error collection, `__QA` DOM probes, `advanceOnce()` |
| `tests/netstub.js` | deterministic Gutendex / Project Gutenberg / Jina stubs, incl. a synthetic full Gutenberg text |
| `tests/check-helpers.js` | self-check that the in-page helper bundle escaped correctly (also runnable alone) |

## Why a network stub

Gutendex and `r.jina.ai` are slow and flaky, and a test that hangs on them is
worse than no test. `tests/netstub.js` reproduces the real response shapes
(catalogue JSON, `cleanBlocks`-compatible plain text, cover bytes) so the app's
own parsing runs for real while the run is reproducible and bounded. The
stubbed edition is ~144 prose paragraphs over 6 chapters, which is long enough
to tell "renders a full book" from "renders a preview".

`FLORI_LIVE=1` turns the stub off; search/browse then degrade to soft checks.

## Design rules the suite follows

- **No test passes by timing out.** Every wait is bounded and every loop has a
  stall counter, so a dead reader fails in seconds with a readable reason.
- **Implementation-agnostic probes.** `__QA` looks for "some paragraph
  container", "some next affordance", "some end marker" rather than hard-coded
  selectors, so the full-book rewrite can restructure the DOM without the suite
  becoming meaningless.
- **Whole-book, not single-render.** The reader may render everything at once or
  a screen at a time; the tests accumulate *distinct paragraphs across
  page turns* and require at least 40, so both designs pass and a 14-paragraph
  stub cannot.
- **Soft vs hard.** Network-only conditions (a search result count, a retry
  button inside an error state) are soft and are printed in the run summary.
  Product requirements are hard asserts.

## Baseline status (commit `df6206e`, prototype)

**16 pass / 3 fail, ~67 s.** The three failures are exactly the full-book
requirement:

1. `reader: renders the whole book, not a 14-paragraph preview`
   — *max 7 paragraphs on screen, 7 distinct across 3 page turns*
2. `reader: next/continue advances through the book and previous returns`
   — *no paging action found in the reader overlay*
3. `reader: shows progress/chapter position and reaches a true end of book`
   — *walked 3 pages, 7 distinct openings, progress 0px -> 0px*

Everything else — home, deck, preview, settings, save, shelf filters, search,
browse, reset, zero page errors — already passes and now guards against
regression.

The suite was validated in the other direction too: against a reference
full-book reader (built in a throwaway copy outside the repo, never committed)
all **19/19** cases pass in ~24 s.