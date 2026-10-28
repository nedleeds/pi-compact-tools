# Development

## Setup and checks

```bash
npm ci
npm run check
pi -e .
```

Development dependencies pin Pi 1.3.0; the peer minimum is Pi 0.85.1. CI checks Pi 0.85.1, 0.99.1, 1.0.0, 1.0.2, 1.1.0, 1.2.0, and 1.3.0 on Node 22.19.0 and 24.

`npm run check` runs TypeScript, rendering tests, resource validation, and packaging checks. Rendering and resource tests run separately so packaging subprocesses do not disturb animation tests. Schema validation and deterministic test clocks are development-only dependencies.

Renders are pinned in `tests/golden/`. After an intentional rendering change, run `UPDATE_GOLDEN=1 npm test` and review the diff. Style parity is checked against real Claude Code and Codex CLI references in `tests/fixtures/`. Current tool-row references are [Claude Code 2.1.312](../tests/fixtures/claude-code-2.1.312.md) and [Codex CLI 0.165.0](../tests/fixtures/codex-0.165.0.md), checked against live rendering and implementation sources. These fixtures also record deliberate Pi differences; Codex's collapsed rows follow its owned-transcript compact renderer, not its legacy history display.

For an informational before/after performance comparison:

```bash
npx tsx tests/benchmark.ts /path/to/clean-baseline
```

Use the same host dependencies in both directories; benchmarks are not timing-sensitive test assertions.

For the shared animation clock, using an unmodified 0.16.2 clock module as baseline:

```bash
npx tsx scripts/benchmark-animation.ts /path/to/baseline/extensions/compact-tools-clock.ts
```

This exercises Pi 1.3's native render scheduler with a synthetic 7.2-second tool/label workload, not terminal I/O or real CPU latency. On Pi 1.3 the independent timers produce 240 paint boundaries; the shared timer produces 160 while preserving 160 indicator and 90 label updates. Slower 80ms animations are quantized to the next 45ms tick only while an indicator is active (less than one fast tick of deferral, without cumulative drift); otherwise the clock returns to 80ms. The last subscriber stops it. Do not interpret fewer paint boundaries as an equal end-to-end speedup.

## UI-only integration and compatibility

The extension does not register or activate agent tools, add model-facing messages, schemas, or prompt text, or change shell prefixes and image resizing.

- Pi 1.0.2+: the public renderer API also styles HTML exports.
- Older hosts: terminal-only compatibility rendering; HTML exports keep native rows.
- Pi 1.1+: final durations use recorded `durationMs`, including restored sessions, and rows follow `outputPad` (0 or 1).
- Older hosts retain event-based timing and original margins.
- Native codemode summaries are verified on Pi 1.2+. They use host-provided nested-call events and saved records. They retain only names and statuses—not arguments, results, or edit diff totals. Reload, resume, and `/tree` restore counts and outcomes. Hosts without those records keep normal previews.

Renderer-bearing overrides of built-in names, such as `read` and `bash`, follow `custom_tools` and its exclusions. Custom rendering intentionally takes precedence over earlier fallback resolvers using `next() ?? mine`; exclude a tool or disable `custom_tools` to preserve its fallback renderer.

## UI ownership and partial failures

`compact-tools-transcript.ts` owns the invisible TUI probe, one-shot startup reconciliation and the private host-row refresh boundary. The extension factory owns the controller inventory through `enableUI` / `detachUI`: live off preserves the current run phase, while session replacement and shutdown release it. Each cleanup step is attempted even if a previous host operation fails. Controllers detach their own state before host UI cleanup so observers cannot recreate timers or widgets while off after a cleanup exception.

Row failures are collected independently; healthy rows continue switching. A single warning per transition reports partial failure and recommends `/reload` for affected UI. The extension does not claim failed rows recovered, silently swallow errors, restart model work or force a reload. This is not a transaction: if the host rejects text/widget removal, stale UI can remain inactive until a later bind replaces it or `/reload` rebuilds it. Controller-local contexts and activation flags still detach; a rejected host unsubscribe cannot guarantee that the host removed its callback. If the warning UI itself throws, reporting falls back to `console.warn` without skipping the remaining shutdown bookkeeping. Failure messages identify failed stages rather than claiming an exact exception count (nested cleanup may fail more than once). `ui-lifecycle.test.ts` uses a strict UI API mock, actual host tool components and both renderer paths to test startup-off, live off, session replacement, reload, shutdown, bad-row getters, explicit retries and cleanup failure followed by streaming events. Native shell timers remain owned by Pi while off.

Execution timing is observed from top-level host events and row contexts only. The obsolete `createTimedExecute` wrapper and its private nested-call set were removed; nested-summary observation remains independent. Retention tests cover both live timing sources. The larger rendering-function extraction, cache snapshot restructuring and phase-tracker unification are intentionally deferred to avoid mixing unnecessary behavioral risk into this lifecycle cleanup.

## Live native/off switching

All four styles use the same UI-only command path, even while the agent is busy. Native/off does not reload or abort the session. The public path remembers the original renderer definition for each wrapper; a style transition re-resolves existing rows, reconciles their shell and clears renderer component caches. Rows first created while off are wrapped when a style is re-enabled. The legacy path invalidates its existing resolver generation.

Off detaches progress, thinking-key, silent, grouping and viewport controllers, resets the hidden-thinking label to Pi's default (rebuilding existing and streaming Markdown), and stops compact animation subscriptions without discarding execution timings or active call identities. Progress and silent activity retain only their current phase while detached, so re-enabling can resume mid-answer or mid-tool correctly. Native shell and (when available) bundled codemode elapsed timers are paused when leaving native rendering, guarded by exact built-in renderer fingerprints; author overrides' state/timers remain untouched. The optional bundled codemode renderer is loaded at session start for fingerprinting, without importing its execution path; missing/unsupported host internals fall back without preventing UI load. Delegated native codemode previews cannot restart a second clock under compact rendering, even if the preview is later collapsed. Observed start and end times are preserved when entering native rendering late.

`live-off-public.test.ts` covers both renderer APIs and startup-off/on, partial results, same-shell author renderers, silent visibility and phase, newly created native rows, repeated switches and timer cleanup. `off-host-reload.test.ts` loads the actual extension file through Pi's loader and drives the real SDK command dispatcher with simulated busy flags and verifies zero reloads, retained busy state, unchanged model loadout/messages, and persistence across a later explicit reload. These are deterministic tests, not a network-provider or real-terminal end-to-end test.

## Record README GIFs

Requires `pi`, `vhs`, `ffmpeg`, `rsync`, `node`, `zsh`, and configured model credentials.

```bash
scripts/record-demos.sh                 # all seven demos
scripts/record-demos.sh nested-calls    # one demo
DEMO_MODEL=gpt-5.5 scripts/record-demos.sh  # with OpenAI Codex configured
DEMO_SOURCE=/path/to/checkout scripts/record-demos.sh
```

The recorder creates a temporary project and isolated settings, reuses credentials without committing them, and leaves your working files and saved style preferences untouched.

- Prompt entry and initial model startup are hidden; GIFs begin with tool rows.
- Tool activity is captured in real time at 12 fps in the final GIFs, without cuts between calls or playback acceleration.
- Thinking defaults to `off`, clamped to the selected model's supported levels. Override with `DEMO_THINKING`; `DEMO_MODEL` otherwise defaults to your configured model.
- Independent calls share an assistant response, avoiding unnecessary model round trips while respecting test-before-edit and write-before-read dependencies.
- The live silent-mode demo keeps a two-second command delay so it can toggle during real tool execution.
- The history demo creates and reopens a real saved session with 18 tool calls and two exchanges, then checks that display toggles leave the saved messages unchanged.
- Fixtures and prompts live in `scripts/demos/`. Ignored `scripts/demos/out/` contains review frames and verification reports with the actual model, thinking level, and call batches.

The published npm package excludes development scripts, tests, these developer docs, and local recording output. README GIFs are hosted in the repository's `assets/` directory.

## Release

Add an entry for the new version in `release-notes.json` (`[]` for no in-app notice), bump both package manifests, and run `npm run check`.

Push the matching `vX.Y.Z` tag after the commit reaches `main`. The [release workflow](../.github/workflows/release.yml) first calls the reusable CI workflow and waits for every supported Pi/Node combination, then validates the version, runs the package checks, publishes to npm with provenance through Trusted Publishing, and creates the GitHub release. No local npm token is needed.
