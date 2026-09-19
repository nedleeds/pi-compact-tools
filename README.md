# pi-compact-tools

Compact, expandable rendering for Pi's built-in tools, with a GitHub Dark theme.

![Compact tool workflow](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/nerd-font-workflow-optimized.gif)

![Spinner and elapsed-time display](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/spinner-duration-optimized.gif)

![Edit diff](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/edit-diff.gif)

## Features

- Compact rows for `read`, `write`, `edit`, `bash`, `powershell`, `grep`, `find`, and `ls`, with status, duration, and line count
- Syntax-highlighted edit diffs and numbered `read`/`write` code views, including Markdown code fences
- Animated working label above the prompt and a `Ctrl+T` thinking summary/detail cycle
- No Nerd Font required

## Install

```bash
pi install npm:pi-compact-tools
```

Then restart Pi or run `/reload`. For the bundled theme, set `"theme": "github-dark-pro"` in `~/.pi/agent/settings.json`.

## Configuration

Optional. Put it in `~/.pi/agent/compact-tools.json` or `<project>/.pi/compact-tools.json`:

```json
{
  "tools": ["read", "write", "edit", "bash"],
  "previewLines": 10,
  "auto_compact": { "read": true, "write": true, "edit": false, "bash": true }
}
```

- `tools`: tools to render compactly. Also available: `grep`, `find`, `ls`, `powershell`.
- `auto_compact`: `true` starts hidden, `false` starts with a preview of up to `previewLines` rows (`1`–`100`).

## Controls

- Click a row or press `Ctrl+O` to expand or collapse results.
- `Ctrl+T` cycles thinking: summary → detail → summary → hidden.

## Development

```bash
npm install
npm run check
pi -e .
```

## License

MIT
