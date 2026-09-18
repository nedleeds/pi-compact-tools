# pi-compact-tools

Compact, expandable rendering for Pi's built-in tools, with a polished GitHub Dark theme.

> Formerly `@nedleeds/pi-compact-ui`. New installations should use `pi-compact-tools`.

## Demo

The UI uses portable Unicode symbols and does not require a Nerd Font.

### Compact tool workflow

Active, successful, and failed tool calls stay compact while preserving useful status and timing information.

![Compact tool workflow with Nerd Font](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/nerd-font-workflow-optimized.gif)

### Progress and duration display

The working label above the prompt carries a soft light sweep. Tool rows use a hollow pending circle, then return to a green success circle or red failure circle. Elapsed time remains visible in the neutral control color.

![Spinner and elapsed-time display](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/spinner-duration-optimized.gif)

### Bounded result previews

Completed `edit` rows show a concise preview by default. The per-tool `auto_compact` setting chooses between hidden results and a bounded preview; click or `Ctrl+O` uses Pi's normal expansion flow to reveal the complete result.

![Edit diff](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/edit-diff.gif)

## Features

- Compact rendering for `read`, `write`, `edit`, `bash`, `powershell`, `grep`, `find`, and `ls`
- One continuously glowing working label above the input prompt across thinking and tool execution
- Four-step `Ctrl+T` thinking cycle when provider detail is available: summary, detail, summary, then hidden
- Millisecond-precision duration and completed output line counts with neutral status text
- Per-tool hidden or bounded-preview initial state with `auto_compact: true` or `false`
- Primary invocation targets such as paths, patterns, and shell commands stay visible
- Click and `Ctrl+O` follow Pi's built-in hidden/expanded sequence
- Configurable `previewLines` prevents large diffs, HTML, and shell output from flooding the transcript
- Width-cached expanded results and edit-diff processing for responsive fullscreen scrolling
- Dark `│` and `└─` visual grouping
- Distinct cool-blue thinking text
- Windows, Unix, and classic Mac line-ending support
- No Nerd Font requirement

## Install

```bash
pi install npm:pi-compact-tools
```

Or install from GitHub:

```bash
pi install git:github.com/nedleeds/pi-compact-tools
```

Restart Pi or run `/reload`.

Migrating from the previous package name:

```bash
pi remove npm:@nedleeds/pi-compact-ui
pi install npm:pi-compact-tools
```

## Theme

Select `github-dark-pro` in Pi's settings, or add it to `~/.pi/agent/settings.json`:

```json
{
  "theme": "github-dark-pro"
}
```

## Configuration

Configuration is optional. Create `~/.pi/agent/compact-tools.json` for global settings or `<project>/.pi/compact-tools.json` for a trusted project.

Default configuration:

```json
{
  "$schema": "https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/schemas/compact-tools.schema.json",
  "tools": ["read", "write", "edit", "bash"],
  "previewLines": 10,
  "auto_compact": {
    "read": true,
    "write": true,
    "edit": false,
    "bash": true
  }
}
```

Running call titles use a hollow `○`, successful titles use a green `●`, and failed titles use a red `●`. `Done`, `Failed`, and elapsed time use the same neutral control color. A single Pi working label animates independently of token arrival and reports `Thinking…`, `Responding…`, or the active tool and target above the prompt. No spinner glyph is shown above the prompt or animated inside tool rows.

`auto_compact` controls each tool's initial result state:

- `true` starts with the result hidden.
- `false` starts with at most `previewLines` rendered rows visible.
- Clicking or pressing `Ctrl+O` expands the complete result through Pi's built-in expansion state.

`previewLines` accepts `1`–`100` and defaults to `10`. It limits only the initial preview; the complete result remains available. Unspecified entries inherit the previous configuration layer. By default, `read`, `write`, and `bash` start hidden, while `edit` starts with a short diff preview.

To enable all Unix-compatible tools:

```json
{
  "tools": ["read", "write", "edit", "bash", "grep", "find", "ls"]
}
```

Add `"powershell"` on Windows if desired.

## Controls

`Ctrl+T` cycles every thinking block through:

```text
one-line summary → summary + │-indented detail → one-line summary → Thinking...
```

Standalone bold lines and Markdown headings split one provider thinking run into logical sections. Each section gets its own summary and optional `│`-indented detail. The control row appears only on sections for which the provider returned expandable detail; when no thinking detail exists, no toggle hint is shown and `Ctrl+T` falls back to Pi's normal visible/hidden toggle instead of showing a duplicate detail phase. While thinking streams, a soft highlight sweeps across Pi's sky-blue working label at a steady interval rather than depending on token updates. The transcript summary remains visually stable. The transformation is display-only; complete thinking remains unchanged in the session and model context.

Primary invocation targets stay visible, including paths, patterns, and shell commands. After every supported tool completes, the status reports the expanded result size as `Done in …s (N lines)` instead of repeating options such as context and limit. Counts use the returned text for reads, searches, listings, and shell commands, written content for `write`, and the rendered diff for `edit`. The count is computed once after completion and cached with the row, so streaming and repeated expansion do not add ongoing work. Large payloads represented as results, such as write content and edit diffs, follow the result toggle.

A mouse click toggles one row using Pi's native result state. `Ctrl+O` remains owned by Pi and expands or collapses all tool rows consistently, including tools not rendered by this extension. A row that begins in preview mode expands fully on the first explicit expansion and collapses normally afterward. The extension does not intercept the global keybinding.

## Notes

- Pi `0.85.1+` and Node.js 20+ are recommended.
- The working indicator and mouse interaction are provided by Pi's TUI; `Ctrl+O` also works in regular mode.
- Duration covers the full rendered tool-call lifecycle, including streamed `write` and `edit` arguments.
- Selected tools override Pi's built-in definitions; other extensions overriding the same names may conflict by load order.

## Development

```bash
npm install
npm run check
pi -e .
```

Pi extensions execute with full system access. Review third-party extension source before installation.

## License

MIT
