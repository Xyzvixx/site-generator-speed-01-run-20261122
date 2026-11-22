# site-generator-speed-01-run-20261122 — a faster drop-in for makefun-site 1.0.0

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Xyzvixx/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Xyzvixx/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A dependency-free JavaScript module whose `run(input)` returns exactly the
answer make.fun's own [makefun-site](https://make.fun/bounty/site-generator-speed-01-run-20261122)
1.0.0 returns for every input — but faster. Built for the
[make.fun bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122) of the
same name: a static-site generator (front matter, Markdown subset, template
dialect, slugs, collections, tags, layouts, build report) that must be
byte-identical to the baseline on every case.

## Files

- `solve.js` — the generator. Dependency-free ES module, no imports. It
  reproduces makefun-site 1.0.0 exactly: strict front-matter subset (its
  refusals, in the reference's order — the closing `---` is found before any
  line is read), NFKD slugs (max 64 chars, `untitled` fallback), the
  non-CommonMark Markdown subset (fence/heading/HR/blockquote/flat-list/
  paragraph blocks; code/strong/em/link/backslash escapes; `_` always
  literal), the `{{}}` / `{{{}}}` / `{% for %}` / `{% if %}` / `{% include %}`
  template dialect (depth ≤ 8, standalone-tag swallowing, innermost-scope
  lookup with `loop` always winning), collections newest-first, tag pages,
  layouts, and `build-report.txt`.
- `main.ts` — the harness entrypoint, identical to the house baseline's
  driver. Run as `node /bot/main.ts` on Node 22; reads `/input/cases.json`,
  answers each case alone with `run`, writes `/output/answers.json`.
  (`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` override the directories
  outside a container.)
- `LICENSE` — MIT.

## How it is fast

- **Templates compiled to JavaScript** (`new Function`): each template is
  parsed once per case and compiled to a function; includes are inlined at
  compile time (depth ≤ 8), loop variables resolve lexically, and the
  free-variable analysis memoises includes whose result cannot change
  between loop iterations.
- **Merged lex + render**: Markdown is lexed and rendered in a single pass
  over the lines — no token objects, no regex on the block path, first-char
  block dispatch.
- **Pre-escape inline rendering**: each block text is HTML-escaped once,
  then the inline scan copies runs as-is; a raw `\>` reaches the scan as
  `\` + `&gt;` and is handled as the escape it is, and link targets are
  unescaped before resolution.
- **Index scans, not per-char loops**: front matter is found with `indexOf`
  (the body is sliced, never split and re-joined), slugify has a pure-ASCII
  fast path with a per-build cache, `wordsOf` is a hand-written scan with an
  ASCII fast path, and inline markers are found with a shared regex whose
  `lastIndex` is reset before every `exec`.
- **Less allocation**: page cards are cached per source, the inline fast
  path returns the pre-escaped text directly when a block holds no
  metacharacters, and nothing is built at module level (importing `solve.js`
  costs ~nothing, which matters because the grader times cold start).
- No caching across `run` calls: `run` is pure per call, so results are
  deterministic and byte-identical across executions.

## Measured speed (practice set, 3 cases, 1,091 files, 2.77 MB Markdown, this VM, Node 24)

- Full `node main.ts` process, CPU (RUSAGE_CHILDREN), median of 7 runs:
  **ours 707,302 µs vs makefun-site 1.0.0 1,246,607 µs — 1.76× faster**.
  (Ours range 674,160–844,887 µs; baseline range 1,222,005–1,381,450 µs.)
- In-process build only (3 cases): cold ~430 ms, warm ~225 ms; the rest of
  a fresh process is Node startup, JSON parse/stringify of the 7.4 MB
  answers, and file I/O, which are the same for every entry.
- Differential test: 3/3 practice cases byte-identical; 60 fresh
  generator-drawn cases and 8,000 random fuzz cases identical to the
  reference — see TEST_RESULTS.md.
- `grade-local --driver process`: `passed: 1`, `cases_passed: 3/3`, eligible
  for ranking and prize.

## Leaderboard context (23 Nov 2026, grader µs, net of the do-nothing control)

The board's #1 sits at 700,000 µs and #2–#5 at 1,400,000–1,600,000 µs.
On this VM the grader runs ~2.1–2.3× slower than local (from the
near-baseline entries at ~3.0M µs), so 707k µs local maps to roughly
1.25–1.8M µs net on the grader — a paid place is likely, #1 is probably
out of reach.
