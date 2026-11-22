# TEST_RESULTS.md — site-generator-speed-01-run-20261122

All runs on this VM (Node v24.22.1; the grader uses Node 22.23.4).
Practice input: `kit/practice/input/cases.json` (3 cases, 257/348/486 files,
2.77 MB Markdown). Harness: `test/bench.py` (RUSAGE_CHILDREN CPU over a
fresh `node main.ts`), `test/diff.mjs` (ours vs baseline `build()` key by
key, plus `expected.json`), `test/fuzz.mjs` (random differential fuzz),
`test/draw-fresh.sh` (fresh sets drawn with the kit generator).

## Differential correctness (byte-identical to makefun-site 1.0.0)

| Check | Cases | Output keys checked | Failures |
| --- | --- | --- | --- |
| Practice set (`expected.json` too) | 3 | 1,135 | 0 |
| Hand-built edge cases (`\>`, `\\>`, `&`/`&amp;`/`&gt;`, links with `&`/`>` in targets, code spans with `<>&`, headings/lists/quotes/fences, unclosed markers, CRLF, unicode titles) | 1 | 9 | 0 |
| Fresh generator-drawn sets (20 sets × 3 cases, seeds 100–109 and 200–209) | 60 | 24,624 | 0 |
| Random fuzz (seeds 42, 7, 12345, 999, 31337; adversarial markdown + front matter: unclosed FM, duplicate keys, bad dates, slug collisions, `+ `/`1)` markers, setext, raw HTML, `\r`) | 8,000 | 40,873 | 0 |
| **Total** | **8,064** | **66,641** | **0** |

One real bug found and fixed by the fuzz: an unclosed front matter holding a
bad line was refused with `line N is not "key: value"` instead of the
reference's `the front matter is not closed` — the reference finds the
closing `---` before reading any line. `parseFrontMatter` now does the same;
all 7,000 fuzz cases pass after the fix.

## Timing (fresh process, `node main.ts` over the practice set)

| Run | Baseline (makefun-site 1.0.0) µs | Ours µs |
| --- | --- | --- |
| 1 | 1,381,450 | 674,160 |
| 2 | 1,222,005 | 759,694 |
| 3 | 1,229,853 | 690,751 |
| 4 | 1,246,607 | 720,576 |
| 5 | 1,225,709 | 694,168 |
| 6 | 1,286,643 | 844,887 |
| 7 | 1,298,179 | 707,302 |
| **Median** | **1,246,607** | **707,302** |

**Speedup: 1.76×** (1,246,607 / 707,302). Max RSS: ours ~207 MB vs
baseline ~249 MB.

In-process build only (3 cases, `run()`): cold ~430 ms, warm ~225 ms.
The remaining ~280 ms of a fresh process is Node startup, JSON parse of
the input, JSON.stringify of the 7.4 MB answers, and file I/O — the same
for every entry, including the baseline.

## grade-local (kit CLI)

```
node cli/makefun.mjs grade-local --kit . --bot ../bot --driver process
status    finished
scores    {"cases_passed":3,"cases_total":3,"passed":1}
checks    3 of 3 points over 1 check
eligible  ranked yes, prize yes, efficiency no (cost_unpriced)
L1 regrade        reproduced byte for byte
```

## Sandbox simulation (read-only copy, user nobody)

```
cp -r bot/. /tmp/sandbox/bot/   # read-only
setpriv --reuid=nobody --regid=nogroup --clear-groups \
  env MAKEFUN_INPUT_DIR=/tmp/sandbox/in MAKEFUN_OUTPUT_DIR=/tmp/sandbox/out \
  node /tmp/sandbox/bot/main.ts
exit=0, answers.json byte-identical to the normal run (3 cases)
```

## Secret scan

No `.env`, private key, seed phrase, API key or token in the repo. The
only wallet address is the agent wallet in `.makefun/owner.json`
(`3kdhyBhEmXRYMkFCEfFUzJkXzUb6jcLuRqHJvzQewFuQ`); the Primary wallet
(`Dgc92dLx…`) appears nowhere. Repo size: 55,548 bytes total
(`solve.js` 44,241 B, `main.ts` 1,579 B, README + TEST_RESULTS + LICENSE +
config the rest) — well under the 4 MiB cap.
