# freepi-cull

Viewport culling for the [free-pi](https://www.npmjs.com/package/free-pi-cli) coding-agent
transcript. Long sessions stop re-rendering every line they have ever printed on
every frame, so scrolling and streaming stay smooth instead of turning into
multi-hundred-millisecond repaints.

It is a small patch for the bundled `@earendil-works/pi-tui`: one new module
(`cull.js`) plus eight anchored edits in `tui.js`, `layout.js` and
`tui-alt-screen.js`. No dependencies, no build step, no changes to your session
data.

```
messages   20000
rows       420004
cull on    15.90 ms/frame
cull off   77.95 ms/frame
saved      80%  (4.9x faster)
```

## The problem

A `ScrollView` renders its whole content child every frame, and `Container.render`
renders every child in turn. A scroll view therefore rebuilds the entire
transcript — thousands of lines, all of them already fixed — just to paint the
40 rows that fit on screen. Cost grows linearly with the conversation:

| messages | rows    | before   | after    | saved |
| -------- | ------- | -------- | -------- | ----- |
| 400      | 8,404   | 1.39 ms  | 0.17 ms  | 88%   |
| 2,000    | 42,004  | 8.57 ms  | 5.14 ms  | 40%   |
| 6,000    | 126,004 | 28.30 ms | 8.13 ms  | 71%   |
| 20,000   | 420,004 | 77.95 ms | 15.90 ms | 80%   |

Median of 120 frames, both configurations rendering the same transcript in
alternating blocks, Node 20 on one laptop — treat it as the shape of the curve,
not a hardware benchmark.

## How it works

The layout pass tells the cull module which rows are on screen
(`beginCull(scrollTop, viewportHeight, followingEnd)`), and containers skip every
child that sits entirely outside that window plus an overscan margin
(`max(24, height/2)` rows on each side). A skipped child contributes:

* its **height**, from a cache filled the last time it really rendered, so total
  content height, scrollbar geometry and `scrollTo` keep working;
* its **OSC 133 prompt markers**, pinned into the line array, so jump-to-prompt
  still sees the whole history.

The result is a sparse `Array(totalRows)` with holes where nothing is painted.
Nothing is copied, and a container that culls its own children reports just its
surviving segments upwards instead of a full line array.

Safety rules baked in:

* the last four children are always measured — that is where new output lands;
* `invalidate()` drops a child's cached height, so a re-laid-out message is
  measured again;
* after a large upward scroll correction the next frame is rendered in full;
* alt-screen search turns culling off while it is open (the search index needs
  every line) and back on when it closes;
* `FREEPI_NO_CULL=1` disables everything at runtime.

Correctness is guarded by paint-equality tests: the same frame is rendered with
culling on and off, and the two screens must be byte-identical.

## Install

```sh
git clone https://github.com/kyelisz/freepi-cull
cd freepi-cull
python3 install.py --check     # what would change
python3 install.py             # apply (backs up every file it touches)
```

`install.py` finds the `pi-tui` bundle in your npx caches
(`~/.npm/_npx/*/node_modules/free-pi-cli/node_modules/@earendil-works/pi-tui/dist`)
and in global npm locations. Somewhere else?

```sh
python3 install.py --target ~/path/to/@earendil-works/pi-tui/dist
```

Each patched file is backed up once as `*.cull-backup`, and re-running the
installer is a no-op ("already applied").

```sh
python3 install.py --uninstall   # restore the stock files, remove cull.js
```

Restart free-pi afterwards (`npx free-pi-cli@latest`).

### Surviving upgrades

`npx free-pi-cli@latest` fetches a fresh bundle, which drops the patch. Either
re-run `python3 install.py` after an upgrade, or call it from whatever wrapper
starts free-pi — that is the simplest way to keep it applied:

```sh
#!/bin/sh
python3 "$HOME/freepi-cull/install.py" >/dev/null 2>&1
exec npx free-pi-cli@latest "$@"
```

The patch is anchored on exact source text, not on line numbers. If a future
`pi-tui` changes one of those blocks, that one edit prints
`SKIP — unexpected counts` and the rest still apply, so an incompatible bundle
degrades to unpatched instead of corrupting the install.

## Tests

```sh
npm test                     # paint-equality + prompt markers + content height
node bench/frame-bench.mjs 6000
```

* `test/cull.test.mjs` — scrolled to top / middle / near end / following the end,
  a big jump upwards, streaming tail growth, appended messages while scrolled up,
  `invalidate()` on an off-screen message, settling back at the end.
* `test/transcript.test.mjs` — the same checks with free-pi's real
  `AssistantMessageComponent` and chat viewport, plus a check that all 251 OSC 133
  prompt markers survive culling and that the content height is unchanged.

Both resolve the bundle via `PI_TUI_DIST` / `PI_AGENT_DIST`, a local
`node_modules`, or the newest npx cache, so they run against whatever install you
have.

## Limitations

* The cull pass itself is O(children): every frame walks the child list to decide
  what to keep, which is why 20k messages still cost ~16 ms/frame instead of
  ~1 ms. An indexed child map is the obvious next step.
* A middle message that changes height without `invalidate()` is transiently one
  row off until the layout settles at the end of the transcript.
* Prompt markers for fully culled messages are pinned, but the exact line content
  around them is not, so a search that needs the entire buffer forces culling off
  (see `tui-alt-screen.js`).
* Written against `pi-tui` 1.2.0 / `free-pi-cli` 0.6.x. Nothing here is
  upstream (yet) — if this belongs in `pi-tui` proper, a PR would be the better
  home.

## License

MIT
