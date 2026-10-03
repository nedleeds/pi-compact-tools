# pi-compact-tools

Tool rows for Pi in three styles: **Claude**, **Codex**, and **Compact**. Pick the look you know from Claude Code or Codex CLI, or Pi's own compact rows, and switch any time with `/compact-tools`. Includes a silent mode and a GitHub Dark theme, and works with custom tools from other packages.

![One conversation drawn in the Compact style, switched to the Claude style, then the Codex style, then silent mode](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/overview.gif)

## Install

```bash
pi install npm:pi-compact-tools
```

Restart Pi or run `/reload`, then run `/compact-tools` to choose a style. To try it for one session without installing: `pi -e npm:pi-compact-tools`.

Requires Node.js 22.19+ and Pi 0.85.1+. It changes only how tool calls are drawn, not what they run or what the model sees.

## Styles

| Style | Looks like | Set with |
|---|---|---|
| **Claude** | Claude Code: reads and searches fold into one line, `⎿` results | `/compact-tools claude` |
| **Codex** | Codex CLI: `• Explored` groups, `• Ran` with the last output lines | `/compact-tools codex` |
| **Compact** | one expandable row per call, with its status and time (default) | `/compact-tools compact` |

Silent mode (`Ctrl+'` or `/silent`) works on top of any style. `/compact-tools off` restores Pi's own rows.

### Claude

![Claude style: reads and searches folded into one line, then Bash and Update rows](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/claude-style.gif)

- Reads, searches, and listings fold into one line: `Searched for 2 patterns, read 3 files`.
- `Bash`, `Update`, `Write`, and custom tools keep their own rows with `⎿` results and short previews.
- Matched against Claude Code 2.1.288 in a live terminal.

### Codex

![Codex style: an Explored group, Ran rows with their last output lines, and an Edited diff](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/codex-style.gif)

- Reads, searches, and listings fold into `• Explored`: `Read a.ts, b.ts`, `Search TODO in src`.
- Commands read `Ran` or `Failed (exit 2)` with their last three output lines; opened, `$ cmd`, all its output, and `✓ • 1.23s`.
- Edits preview their changed lines; custom tools read `• Called name`.
- Matched against Codex CLI 0.160.0 in a live terminal.

### Compact

![Compact style: searches, reads, a test run, and an edit with its diff, each call with its status](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/compact-workflow.gif)

- One row per call: what it ran, its status, duration, and line count.
- Edits show a highlighted diff with `(+3 -1)`; reads and writes show numbered code.

A command that writes or runs something, such as `tee`, `xargs`, or `find -delete`, always keeps its own row; only calls that just look around are folded into a group.

### Silent mode

![Silent mode switched on mid-run: the rows fold into a moving light, the answer stays, and every row comes back when it is off](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/silent-mode.gif)

Only your prompts and the answers. Toggle with `Ctrl+'` or `/silent`; `"mode": "silent"` starts sessions with it on.

## Commands

```text
/compact-tools                 # choose a style and where to save it
/compact-tools codex           # switch style, at once, even while tools run
/compact-tools claude project  # save for this trusted project
/compact-tools off             # restore Pi's own rows (reloads Pi)
/compact-tools status          # effective style, mode, and config paths
```

Without a scope, the style is saved where it is decided: in the trusted project if its settings choose a style, otherwise globally. Switching between Claude, Codex, and Compact redraws every row at once, even while tools run. Turning rows `off` or back on reloads Pi, so it waits until the response finishes. Your other settings are kept.

## Configuration

Optional, in `~/.pi/agent/compact-tools.json` or `<project>/.pi/compact-tools.json` (trusted projects only; they override global settings field by field). Add `"$schema": "https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/schemas/compact-tools.schema.json"` for editor validation.

```json
{
  "style": "compact",
  "mode": "normal",
  "tools": ["read", "write", "edit", "bash"],
  "previewLines": 10,
  "auto_compact": { "read": true, "write": true, "edit": false, "bash": true },
  "custom_tools": { "enabled": true, "auto_compact": true, "exclude": [] }
}
```

- `style`: `claude`, `codex`, `compact`, or `off`.
- `tools`: built-ins drawn in the style. Also `grep`, `find`, `ls`, `powershell`.
- `auto_compact`: `true` starts a Compact row collapsed; `false` shows up to `previewLines` rows. Custom tool names work too.
- `custom_tools`: rows for tools from other packages. `exclude` keeps a tool's own look.

## Controls

- Click a row or group, or press `Ctrl+O`, to expand and collapse.
- `Ctrl+T` cycles thinking: summary → detail → summary → hidden.

## Development

```bash
npm install
npm run check
pi -e .
```

Development dependencies are pinned to Pi 1.0.0; the peer minimum remains Pi 0.85.1. CI checks Pi 0.85.1, 0.99.1, and 1.0.0 on Node 22.19.0 and 24. Schema validation and deterministic test clocks are development-only dependencies, not runtime dependencies. Development scripts and tests are not included in the published package. `npm test` runs the rendering tests first and the resource/packaging checks separately so their subprocesses do not disturb animation tests.

For a local before/after performance comparison, run `npx tsx tests/benchmark.ts <clean-baseline-directory>` with the same host dependencies in both directories. Measurements are informational, not timing-sensitive test assertions.

Renders are pinned in `tests/golden/`. After an intended change to the output, record it with `UPDATE_GOLDEN=1 npm test` and review the diff. The Claude and Codex styles are checked against references captured from the real tools in `tests/fixtures/`. The README's GIFs are recorded with `scripts/record-demos.sh` (needs `vhs` and `ffmpeg`). Before publishing, add the version's notes to `release-notes.json` (`[]` for none).

## License

MIT
