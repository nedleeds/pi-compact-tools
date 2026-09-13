# pi-compact-tools

Compact, expandable rendering for Pi's built-in tools, with a polished GitHub Dark theme.

> Formerly `@nedleeds/pi-compact-ui`. New installations should use `pi-compact-tools`.

## Demo

The recordings below use the optional [Nerd Font](#nerd-font-preset) preset. **The default configuration does not require a Nerd Font**: it uses portable emoji and standard Unicode icons instead, with the same spinner, timing, and expansion behavior.

### Compact tool workflow

Active, successful, and failed tool calls stay compact while preserving useful status and timing information.

![Compact tool workflow with Nerd Font](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/nerd-font-workflow.gif)

### Spinner and duration indicators

The spinner animates during execution, then changes to a duration-aware completion icon.

![Spinner and duration indicators](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/spinner-duration.gif)

### Expandable edit diffs

Click a completed `edit` row, or press `Ctrl+O`, to reveal and collapse its diff.

![Expandable edit diff](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/edit-diff.gif)

## Features

- Compact rendering for `read`, `write`, `edit`, `bash`, `powershell`, `grep`, `find`, and `ls`
- Animated configurable spinner in fullscreen TUI mode
- Millisecond-precision duration and configurable completion icons
- Click or `Ctrl+O` to cycle through meaningful detail levels
- Short previews, full output, and clean edit diffs
- Dark `│` and `└─` visual grouping
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
  "spinner": {
    "frames": ["◐", "◓", "◑", "◒"],
    "intervalMs": 120
  },
  "durationIndicators": [
    { "underMs": 1000, "icon": "⚡️", "color": "warning" },
    { "underMs": 10000, "icon": "🔥", "color": "#D95C3F" },
    { "underMs": 30000, "icon": "○", "color": "#79C0FF" },
    { "icon": "⏳", "color": "#D2A8FF" }
  ]
}
```

These defaults use emoji and standard Unicode, so they work without a Nerd Font. Fast tools finish immediately; no artificial spinner delay is added.

`durationIndicators` must have ascending `underMs` values, with a final fallback entry that omits `underMs`. `color` is optional and accepts a supported theme color or six-digit hex value. Existing icon-only configurations remain compatible.

To enable all Unix-compatible tools:

```json
{
  "tools": ["read", "write", "edit", "bash", "grep", "find", "ls"]
}
```

Add `"powershell"` on Windows if desired.

## Nerd Font preset

If your terminal uses a [Nerd Font](https://www.nerdfonts.com/), this preset enables all eight tools and the icons shown in the demos:

```json
{
  "$schema": "https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/schemas/compact-tools.schema.json",
  "tools": ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"],
  "previewLines": 10,
  "spinner": {
    "frames": ["✽", "✻", "✲", "✢", "✲", "✻"],
    "intervalMs": 80
  },
  "durationIndicators": [
    { "underMs": 1000, "icon": "\uf0e7", "color": "warning" },
    { "underMs": 10000, "icon": "\uf490", "color": "#D95C3F" },
    { "underMs": 30000, "icon": "\udb81\udde3", "color": "#79C0FF" },
    { "icon": "\udb81\udd1f", "color": "#D2A8FF" }
  ]
}
```

The escaped code points remain readable on GitHub and are decoded to Nerd Font icons when JSON is loaded. Remove `"powershell"` on systems where it is unavailable.

## Controls

`Ctrl+O` or a mouse click cycles only through available content:

```text
summary → arguments → output preview → full output → summary
```

For `edit`:

```text
summary → diff → summary
```

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
