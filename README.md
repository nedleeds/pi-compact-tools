# pi-compact-tools

Compact, expandable tool rows for Pi, including custom tools from other packages, with a GitHub Dark theme.

![Syntax-highlighted edit diff with lines added and removed](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/edit-diff.gif)

![Numbered read code view](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/code-aware-results.gif)

## Features

- Compact rows for `read`, `write`, `edit`, `bash`, `powershell`, `grep`, `find`, and `ls`, with status, duration, and line count
- The same rows for custom tools from other packages, with no setup
- Syntax-highlighted edit diffs, with lines added and removed: `(+3 -1)`
- Numbered code views for `read` and `write`
- Silent mode: only prompts and final answers
- Works with any theme; no Nerd Font required

## Install

```bash
pi install npm:pi-compact-tools
```

Restart Pi or run `/reload`. For the bundled theme, set `"theme": "github-dark-pro"` in `~/.pi/agent/settings.json`.

## Configuration

All settings go in one optional file: `~/.pi/agent/compact-tools.json`, or `<project>/.pi/compact-tools.json` for one project. Every key is optional.

```json
{
  "tools": ["read", "write", "edit", "bash"],
  "previewLines": 10,
  "auto_compact": { "read": true, "write": true, "edit": false, "bash": true },
  "mode": "normal",
  "custom_tools": { "enabled": true, "auto_compact": true, "exclude": [] }
}
```

- `tools`: built-in tools to compact. Also available: `grep`, `find`, `ls`, `powershell`.
- `auto_compact`: `true` starts a row hidden, `false` shows a preview of up to `previewLines` rows. Custom tool names work too.
- `mode`: `"normal"` or `"silent"`. See [Silent mode](#silent-mode).
- `custom_tools`: see [Custom tools](#custom-tools).

## Custom tools

![Compact rows for built-in and custom tools, including a web search and an edit with its diff and line counts](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/compact-workflow.gif)

Tools from other packages get compact rows automatically. Expanding a row shows the tool's own result view.

Set them with the `custom_tools` key in the same `compact-tools.json`:

```json
{
  "auto_compact": { "web_search": false },
  "custom_tools": { "enabled": true, "auto_compact": true, "exclude": ["my_tool"] }
}
```

- `enabled`: `false` turns this off for every custom tool.
- `auto_compact`: the default for every custom tool. Override one tool in the top-level `auto_compact`, like `web_search` above.
- `exclude`: tools that keep their original look.

## Silent mode

![Silent mode switched on mid-run: the tool rows fold away into a moving light, the answer stays, and every row comes back when it is off](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/silent-mode.gif)

Shows only your prompts and the final answers. Tool calls, thinking, and notices are hidden while a light under the prompt shows the agent is working.

- Toggle with `Ctrl+'` or `/silent` (`/silent on`, `/silent off`). `Ctrl+'` needs a terminal with the Kitty keyboard protocol, such as Ghostty, Kitty, or WezTerm.
- Start every session silent with `"mode": "silent"`.
- Turning it off brings every hidden row back.
- Errors are hidden too. If a run ends without an answer, turn silent mode off to see why.

## Controls

- Click a row or press `Ctrl+O` to expand or collapse results.
- `Ctrl+T` cycles thinking: summary → detail → summary → hidden.
- `Ctrl+'` or `/silent` toggles silent mode.

## Development

```bash
npm install
npm run check
pi -e .
```

Before publishing, add the new version's notes to `release-notes.json`. Pi shows them once after users update.

## License

MIT
