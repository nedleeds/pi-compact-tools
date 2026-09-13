# pi-compact-ui

Compact, expandable rendering for pi's built-in `read`, `write`, `edit`, and `bash` tools, bundled with a polished GitHub Dark theme.

Designed for a focused, low-noise terminal workflow.

![Spinner and duration indicators](https://raw.githubusercontent.com/nedleeds/pi-compact-ui/main/assets/spinner-status.gif)

## Demo

**Keyboard expansion** – press `Ctrl+O` to cycle through detail levels.

![Ctrl+O expansion](https://raw.githubusercontent.com/nedleeds/pi-compact-ui/main/assets/keyboard-expand.gif)

**Edit diffs** – click a finished `edit` row to reveal the diff, click again to collapse.

![Edit diff expansion](https://raw.githubusercontent.com/nedleeds/pi-compact-ui/main/assets/edit-diff.gif)

## Features

- Compact one-line rendering for configurable built-in tools
- Supports `read`, `write`, `edit`, `bash`, `powershell`, `grep`, `find`, and `ls`
- Click or `Ctrl+O` to cycle through available detail levels
- Skips argument and output levels that contain no additional information
- Animated, configurable tool spinner
- Execution duration with configurable indicators
- Short and full output previews
- Clean edit diffs without duplicate JSON arguments or leading blank lines
- GitHub Dark theme with distinct tool, output, success, and error colors
- No Nerd Font requirement

## Requirements

- pi `0.85.1` or newer is recommended
- Node.js 20 or newer
- Fullscreen TUI mode is required for mouse-click expansion; `Ctrl+O` works without it

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
    { "underMs": 1000, "icon": "⚡️" },
    { "underMs": 10000, "icon": "🚀" },
    { "underMs": 30000, "icon": "🔥" },
    { "icon": "⏳" }
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

`durationIndicators` must use ascending `underMs` values. The final entry must omit `underMs` and acts as the fallback.

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
- Duration is measured from the first execution render and is intended as a UI estimate.
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
