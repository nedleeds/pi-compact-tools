# pi-compact-tools

Compact, expandable rendering for Pi's built-in tools, with a polished GitHub Dark theme.

> Formerly `@nedleeds/pi-compact-ui`. New installations should use `pi-compact-tools`.

## Demo

The recordings below use the optional [Nerd Font](#nerd-font-spinner-preset) spinner preset. **The default configuration does not require a Nerd Font**.

### Compact tool workflow

Active, successful, and failed tool calls stay compact while preserving useful status and timing information.

![Compact tool workflow with Nerd Font](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/nerd-font-workflow-optimized.gif)

### Spinner and duration display

The spinner animates during execution, then returns to a green success circle or red failure circle. Elapsed time remains visible in the neutral control color.

![Spinner and elapsed-time display](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/spinner-duration-optimized.gif)

### Initially visible edit diffs

Completed `edit` rows show their full diff initially by default. The per-tool `auto_compact` setting controls which tools start with their result hidden without disabling click or `Ctrl+O` interaction.

![Edit diff](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/edit-diff.gif)

## Features

- Compact rendering for `read`, `write`, `edit`, `bash`, `powershell`, `grep`, `find`, and `ls`
- Animated configurable spinner in fullscreen TUI mode
- Three-state `Ctrl+T` thinking view: summary, detail, then hidden
- Millisecond-precision duration with neutral status text
- Per-tool initial compaction and global-toggle participation with `auto_compact: true` or `false`
- Tool invocation details are always fully visible
- Click toggles one result between hidden and fully visible; `Ctrl+O` toggles all participating rows
- Full output on expansion and initially visible edit diffs by default
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
  "auto_compact": {
    "read": true,
    "write": true,
    "edit": false,
    "bash": true
  },
  "spinner": {
    "frames": ["◐", "◓", "◑", "◒"],
    "intervalMs": 120
  }
}
```

Successful call titles use a green `●`, while failed call titles use a red `●`. `Done`, `Failed`, and elapsed time use the same neutral control color. Fast tools finish immediately; no artificial spinner delay is added.

For a minimal blinking spinner, copy [`examples/compact-tools-2.json`](examples/compact-tools-2.json). Its frames use `● ● (blank) ● ●` at 120 ms intervals. The renderer's built-in frame dimming turns this into a fade-out/fade-in animation. Rename it to `compact-tools.json` or copy its contents to the active configuration path.

`auto_compact` controls each tool's initial state and whether it participates in the global `Ctrl+O` toggle:

- `true` starts with the result hidden and participates in `Ctrl+O`.
- `false` starts with the full result visible and is unaffected by `Ctrl+O`.
- Clicking any compact-rendered row still toggles that row's result.

Unspecified entries inherit the previous configuration layer. By default, `read`, `write`, and `bash` start compact and participate in the global toggle, while `edit` starts expanded and remains unaffected so code diffs stay visible.

To enable all Unix-compatible tools:

```json
{
  "tools": ["read", "write", "edit", "bash", "grep", "find", "ls"]
}
```

Add `"powershell"` on Windows if desired.

## Nerd Font spinner preset

If your terminal uses a [Nerd Font](https://www.nerdfonts.com/), this preset enables all eight tools and the spinner shown in the demos:

```json
{
  "$schema": "https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/schemas/compact-tools.schema.json",
  "tools": ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"],
  "spinner": {
    "frames": ["✽", "✻", "✲", "✢", "✲", "✻"],
    "intervalMs": 80
  }
}
```

Remove `"powershell"` on systems where it is unavailable.

## Controls

`Ctrl+T` cycles every thinking block through:

```text
one-line summary + controls → summary + │-indented detail + controls → Thinking...
```

Standalone bold lines and Markdown headings split one provider thinking run into logical sections. Each section gets its own summary, optional `│`-indented detail, and control row; `Ctrl+T` cycles all sections together. While thinking streams, a text-color highlight sweeps across summaries using streaming updates; no spinner glyph or title circle is shown. The transformation is display-only; complete thinking remains unchanged in the session and model context.

Relevant invocation details stay visible, including paths, patterns, shell commands, and auxiliary arguments. Read calls omit offset and limit noise, then report the number of lines read after completion. Large payloads represented as results, such as write content and edit diffs, follow the result toggle.

A mouse click toggles one row's result:

```text
result hidden ↔ full result
```

`Ctrl+O` operates on all rows whose tool has `auto_compact: true`:

- If any participating row is not fully expanded, it expands all participating rows.
- If every participating row is fully expanded, it collapses all participating rows.
- Rows whose tool has `auto_compact: false` are left unchanged.

The extension handles and consumes `Ctrl+O` directly, so no Pi keybinding changes are required. With the default `edit: false`, edit diffs start visible and are excluded from the global toggle, while clicking an edit row still collapses or expands it.

## Notes

- Pi `0.85.1+` and Node.js 20+ are recommended.
- Fullscreen TUI mode is required for spinner animation and mouse interaction; `Ctrl+O` also works in regular mode.
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
