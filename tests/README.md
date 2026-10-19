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
| `tests/check-helpers.js` | self-check that the in-page helper bundle escaped correctly and parses (also runnable alone) |
| `tests/live-verify.js` | standalone post-deploy gate against the public URL (no stub, real network) |
| `tests/refcheck.js` | builds a throwaway copy of `index.html` from any git ref and runs the suite against it |


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
- **No serving the wrong build.** The static server takes its own free port and
  fingerprints the bytes it serves against `index.html` on disk, so a leaked
  server from an aborted run cannot silently validate a stale copy.
- **The in-page bundle is a `String.raw` template** and is parse-checked by
  `tests/check-helpers.js`. Two escaping bugs (a `\b` that became a backspace,
  and a `\n` that broke the whole bundle) were caught this way.
- **End-of-book detection is structural**, never a bare `the end`: a real book
  contains "at the end of the Roman Republic" and tripped an earlier regex three
  chapters into a 45-chapter novel.
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

## Round-3 regression cases

Six cases guard the defects found in review of the full-book branch:

| # | Case | What it pins down |
| - | ---- | ------------------ |
| 1 | `regression: preview exposes a "Read a little" action...` | the preview CTA label and that it opens the reader |
| 2 | `regression: deck never offers shelf books...` | with a small catalogue that trips `applyCatalogue`'s fallback shuffle, no deck card may duplicate a shelf id, and every Keep must grow the shelf |
| 3 | `regression: the seeded demo shelf is persisted...` | 4 demo rows, present in localStorage, identical ids/statuses after a reload |
| 4 | `regression: a failed catalogue fetch ends the deck in a retryable state` | an outage must not be reported as "That's the folio for today."; retry must produce a card once the API returns |
| 5 | `regression: a 429 from the text service...` | rate limiting is reported as such, Retry is a 44x44 target, and flipping the stub to 200 lets Retry open the chapters |
| 6 | `regression: reader and preview controls are at least 44x44` | measured geometry of Prev/Next, reader Retry and preview Retry |

## Results

| build | pass / fail | failing cases |
| ----- | ----------- | ------------- |
| baseline `df6206e` | **17 / 25** | 4, 5, 6 (full book) · 18 (deck leaks shelf books) · 19 (shelf not persisted) · 20 (deck outage) · 21 (rate limit) · 22 (touch targets) |
| full-book `3538c6a` | **21 / 25** | 3 + 17 ("Read a little") · 18 (deck leaks shelf books) · 19 (shelf not persisted) |

The four failures on the implementation branch are exactly the round-3 items.
Cases 20, 21 and 22 already pass there, so those fixes landed in 9ac9fa3/3538c6a.

## Reference checks against any git ref

```powershell
$env:NODE_PATH="C:\Users\Daniel\AppData\Local\Temp\flori-tools\node_modules"
node tests/refcheck.js build 3538c6a "$env:TEMP\flori-ref-impl"   # git show <ref>:index.html -> a temp dir
node tests/refcheck.js run  "$env:TEMP\flori-ref-impl"             # run the suite against it
```

This is how "does the suite fail for the right reason?" is answered without
touching the working tree. It also prints the app size it is testing.

## Post-deploy gate (live URL)

```powershell
$env:NODE_PATH="C:\Users\Daniel\AppData\Local\Temp\flori-tools\node_modules"
node tests/live-verify.js
```

`tests/live-verify.js` drives the deployed site with real Gutendex / Gutenberg /
Jina at 390x844 and prints a PASS/FAIL checklist plus the tested URL; exit code 0
means every check passed. It checks the user journey end to end: home, preview
(cap of 3 paragraphs + END OF PREVIEW), the reader opening a real book,
accumulating >= 40 distinct paragraphs across page turns, Next/Previous, a true
end-of-book marker, saving from both the reader and a preview, and zero uncaught
page errors.

Unlike the stubbed suite it is deliberately tolerant of slow networks (generous
per-step deadlines) and will try up to `FLORI_MAX_BOOKS` deck books, because a
Gutenberg edition can be front matter or OCR noise. The full-book bar itself is
never softened.

Env: `FLORI_URL` (default `https://danieldamilola.github.io/florilegium/`),
`FLORI_READ_TIMEOUT`, `FLORI_MAX_PAGES`, `FLORI_MAX_BOOKS`, `FLORI_HEADFUL=1`.
