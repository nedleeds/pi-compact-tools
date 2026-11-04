# Pi 1.5 compatibility audit — 0.17.0

Baseline: `b586349` (0.16.7). Target: the published Pi 1.5.0 family and the matching installed host source. Existing unrelated working directories were left unchanged; this audit used a clean clone.

## Changes

- Pin development host dependencies to 1.5.0 and add 1.4.0/1.5.0 to the release-gating Node 22.19/24 compatibility matrix. Keep the 0.85.1 peer minimum.
- Treat the new injected `keyText`/`keyHint` render-context fields as optional across supported hosts. Claude and Codex output disclosures use the injected expand key, not an imported host singleton. Empty bindings omit the hint. Key text participates in result-cache invalidation.
- Ship `CHANGELOG.md`, generated from `release-notes.json`. Resource checks reject missing or stale generated notes; packaging tests require the file in the tarball. GitHub, native and legacy release notes share one source of text.
- Let Pi 1.5 own normal Extension Updates behavior. A per-user migration bridge preserves the first native-supported update notice for users who already have a pre-0.17.0 legacy notice marker, including upgrades that skip 0.17.0. Fresh native installs are quiet; resumed sessions defer the bridge; after consumption, repeats and subsequent updates are native-only. Native changelogs need package source metadata, so standalone extension files do not receive them.
- Initialize app keybindings in test fixtures, as InteractiveMode does, instead of accepting the TUI-only singleton's missing app bindings. No production host keybindings are changed.

## Reviewed and retained

- **UI-only invariant:** no tool registration/activation, schema, execution, prompt or session-message changes. Existing SDK token-neutrality and loadout-snapshot tests remain release gates.
- **Lifecycle:** progress and silent activity finish at `agent_settled`. Tool-row eligibility stops at `agent_end`, because orphaned calls from a completed low-level run must not animate through retry backoff. These signals are intentionally different.
- **Pi 1.5 streaming:** `updateArgs()` defers rendering to the next frame. New real-host tests cover latest arguments, exploration-to-execution transitions, and coalescing across both public/legacy routes and all three styles. Streaming JSON snapshots are immutable, so argument-identity grouping caches remain valid.
- **Private UI boundary:** the host's chat/container structure and row cache/state fields still support grouping, silent mode, viewport retention and live off/on. Existing reload, failure cleanup, timer, author-renderer and native restoration tests remain unchanged.
- **Nested calls:** existing event/persisted-record tests cover reload, resume and tree navigation. New real-sandbox tests add two simultaneous codemode parents, interleaved successful/failed children, reversed parent completion, and overlapping/prefix-related parent IDs. Parent summaries stay independent and model-facing metadata is unchanged.
- **Theme/layout:** existing golden renders, narrow widths, Unicode, padding, duration, animation and resource validation tests remain unchanged. No golden output was re-recorded to hide a regression.
- **Pi 1.5 validation changes:** production code does not depend on TypeBox-only validation features. Resource JSON validation stays dev-only; no new runtime dependency is needed.

## Deliberately not changed

- Pi's `CodeHighlighter` is not a public entry-point export. Adding a private import solely for an unmeasured speedup is not justified; existing lazy highlighting and component reuse stay in place.
- Do not replace `agent_end` with `agent_settled` indiscriminately.
- Thinking-toggle key handling and group controls are not rewritten as part of output-hint support. Their behavior involves input ownership, not just renderer labels.
- Pi 1.5 has no complete public replacement for grouping/silent/viewport patches. Keep the guarded compatibility path and its tests rather than raising the supported minimum without a demonstrated need.

## Verification and independent review

The local 1.5.0 `npm run check` passes TypeScript, 438 rendering/behavior/host tests (437 passed, one Windows-only POSIX-permissions skip), all three resource tests, and generated-changelog validation. Full checks also pass locally on Pi 1.4.0 (434 passed, four platform/capability skips; three resource tests passed) and 0.85.1 (424 passed, fourteen platform/capability skips; two resource tests passed and the unsupported strict-theme test skipped). An extracted npm tarball also passes the real SDK live off/on and reload smoke test without an extension-local dependency tree. No tests are marked TODO, and the golden render files are unchanged.

Claude Code independently reviewed the baseline against the installed 1.5.0 source, reproduced the missing key-context typing, and exercised deferred arguments and parallel codemode in separate scratch tests. Its actionable migration-notice finding was implemented with regression tests. Final staged-diff review approved deployment after independently replaying the full suite and targeted follow-up tests; its remaining requirement was successful final full checks on all three locally exercised host versions, now satisfied. The release workflow independently gates publication on every configured Pi/Node combination.

These are deterministic component/SDK/sandbox tests. They do not claim real-provider end-to-end coverage or an end-to-end rendering speedup. Remaining private host dependencies continue to require compatibility testing on future Pi releases.
