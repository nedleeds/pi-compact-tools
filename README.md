# pi-compact-ui

Compact, expandable rendering for all of Pi's built-in tools, bundled with a polished GitHub Dark theme.

Designed for a focused, low-noise terminal workflow.

![Built-in tool support](https://raw.githubusercontent.com/nedleeds/pi-compact-ui/main/assets/built-in-tool-support.png)

## Demo

**Spinner and status** – track active execution and see duration-aware completion indicators.

![Spinner and duration indicators](https://raw.githubusercontent.com/nedleeds/pi-compact-ui/main/assets/spinner-status.gif)

**Keyboard expansion** – press `Ctrl+O` to cycle through detail levels.

![Ctrl+O expansion](https://raw.githubusercontent.com/nedleeds/pi-compact-ui/main/assets/keyboard-expand.gif)

**Edit diffs** – click a finished `edit` row to reveal the diff, click again to collapse.

![Edit diff expansion](https://raw.githubusercontent.com/nedleeds/pi-compact-ui/main/assets/edit-diff.gif)

## Features

- Compact one-line rendering for configurable built-in tools
- Supports `read`, `write`, `edit`, `bash`, `powershell`, `grep`, `find`, and `ls`
- Click or `Ctrl+O` to cycle through available detail levels
- Skips argument and output levels that contain no additional information
- Animated, configurable tool spinner with a bright → dark → bright frame tone cycle
- Millisecond-precision execution duration with configurable indicators
- Short and full output previews with dark `│` / `└─` visual grouping
- Clean edit diffs without duplicate JSON arguments or leading blank lines
- GitHub Dark theme with distinct tool, output, success, and error colors
- No Nerd Font requirement

## Supported tools

| Tool | Purpose | Compact by default |
| --- | --- | :---: |
| `read` | Read files and images | Yes |
| `write` | Create or overwrite files | Yes |
| `edit` | Apply exact text replacements with clean diffs | Yes |
| `bash` | Run shell commands | Yes |
| `grep` | Search file contents | Opt-in |
| `find` | Find files by glob pattern | Opt-in |
| `ls` | List directory contents | Opt-in |
| `powershell` | Run PowerShell commands | Opt-in |

Enable opt-in tools with the [`tools` configuration](#configuration). PowerShell is intended for Windows; the other seven tools are demonstrated above on macOS.

## Requirements

- pi `0.85.1` or newer is recommended
- Node.js 20 or newer
- Fullscreen TUI mode is required for spinner animation and mouse-click expansion; `Ctrl+O` works without it

## Install

From npm:

```bash
pi install npm:@nedleeds/pi-compact-ui
```

Or directly from GitHub:

```bash
pi install git:github.com/nedleeds/pi-compact-ui
```

Restart pi or run `/reload` after installation.

## Theme

The package includes the `github-dark-pro` theme. Select it from pi's settings UI or set it in `~/.pi/agent/settings.json`:

```json
{
  "theme": "github-dark-pro"
}
```

## Configuration

The extension works without a configuration file. Its defaults are defined in the source code.

To customize it globally, create `~/.pi/agent/compact-tools.json` using the example below. The included JSON Schema provides completion and validation in compatible editors.

For project-specific settings, create:

```text
<project>/.pi/compact-tools.json
```

Project configuration is loaded only for trusted projects. Values are merged in this order:

```text
built-in defaults
→ ~/.pi/agent/compact-tools.json
→ <project>/.pi/compact-tools.json
```

Default configuration:

```json
{
  "$schema": "https://raw.githubusercontent.com/nedleeds/pi-compact-ui/main/schemas/compact-tools.schema.json",
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

`tools` selects which built-in definitions receive compact rendering. Omitted tools retain Pi's default renderer. The array replaces, rather than extends, the previous configuration layer. To enable every Unix-compatible tool:

```json
{
  "tools": ["read", "write", "edit", "bash", "grep", "find", "ls"]
}
```

`powershell` is also supported and can be selected explicitly on Windows. Unsupported names are ignored with a warning.

Spinner frames automatically use a bright → dark → bright tone cycle (`muted` → `dim` → `border` → `dim` → `muted`). Fast tools are never delayed artificially: they transition directly to their success or failure state.

`durationIndicators` must use ascending `underMs` values. The final entry must omit `underMs` and acts as the fallback. Durations are displayed with millisecond precision, for example `Done in 0.023s`. The optional `color` field applies color to the icon only; when omitted, it defaults to `dim`. Existing icon-only configurations remain fully compatible, including configurations copied from older releases of this README:

```json
{ "underMs": 1000, "icon": "⚡️" }
```

Icons are arbitrary strings and do not require Nerd Font glyphs. Emoji, ASCII text, or terminal-safe Unicode symbols can be used instead. `color` accepts semantic theme colors such as `warning`, `accent`, `success`, `error`, `muted`, `dim`, `border`, and `text`, as well as six-digit hex colors such as `#800020` or `#FFFFFF`. Hex colors use truecolor when available and fall back to the nearest ANSI-256 color.

### Recommended Nerd Font preset

If your terminal uses a [Nerd Font](https://www.nerdfonts.com/), the following configuration is recommended. It enables compact rendering for all eight built-in tools and uses single-width Nerd Font duration icons:

```json
{
  "$schema": "https://raw.githubusercontent.com/nedleeds/pi-compact-ui/main/schemas/compact-tools.schema.json",
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

The escaped code points keep the preset readable on GitHub, whose web-font stack does not include Nerd Font glyphs. JSON automatically decodes them to the intended icons when the configuration is loaded. On systems without PowerShell, remove `"powershell"` from `tools`. The default Unicode configuration remains the most portable option and does not require a Nerd Font.

## Expansion levels

Only levels with meaningful content are included. Depending on the tool call, the cycle may be:

```text
summary → arguments → output preview → full output → summary
summary → output → summary
summary only
```

`edit` uses:

```text
summary → diff → summary
```

## Compatibility and limitations

- The package overrides only the built-in definitions selected by `tools`, while preserving their execution behavior and metadata.
- Another extension overriding the same tool names may conflict depending on extension load order.
- Tools registered by other extensions are not modified.
- Duration is measured from the first rendered tool call through completion of the built-in tool's `execute()` call. This includes streamed arguments for large `write` and `edit` calls. Timing survives `/reload` within the same process, but is unavailable after a full process restart.
- `timeout` tool arguments are execution limits, not measured durations, and are intentionally omitted from the compact shell summary.
- Windows (`CRLF`), Unix/macOS (`LF`), and classic Mac (`CR`) output is normalized before line counting and preview rendering.
- Spinner animation is disabled in regular TUI mode to avoid unsafe redraws of transcript rows above the viewport.
- Separator glyphs use the theme's `border` color; actual darkness depends on the selected theme.
- Emoji appearance depends on terminal and system font support. All default duration icons use Unicode 6.0 or earlier.

## Development

```bash
npm install
npm run check
pi -e .
```

When testing with `pi -e .`, disable any local copy of `compact-tools.ts` to avoid duplicate tool overrides.

## Security

Pi extensions execute with full system access. Review extension source before installing third-party packages.

## License

MIT
