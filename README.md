# pi-compact-tools

Compact, expandable tool rows for Pi in its own compact style or Claude Code's, with a silent mode and a GitHub Dark theme. Works with custom tools from other packages.

![The compact style, then the Claude style, each switched to silent mode mid-run and back](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/overview.gif)

## Install

```bash
pi install npm:pi-compact-tools
```

Restart Pi or run `/reload`. For the bundled theme, set `"theme": "github-dark-pro"` in `~/.pi/agent/settings.json`.

## Usage

Pick a style. Silent mode works on top of either.

| | Setting | Shows | How |
|---|---|---|---|
| **Compact** | Style | every tool call as its own compact, expandable row | `"style": "compact"` (default) |
| **Claude** | Style | reads and searches folded into one line, like Claude Code | `"style": "claude"` |
| **Silent** | Mode | only your prompts and the answers | `Ctrl+'` or `/silent` |

Set `"style"` in the config below, then `/reload`. `"style": "off"` restores Pi's own rows.

### Style: Compact

![Compact style: searches, reads, a test run, and an edit with its diff, each call with its status](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/compact-workflow.gif)

- Each call: what it ran, then its status, duration, and line count.
- Edits show a highlighted diff with `(+3 -1)`; reads and writes show numbered code.

### Style: Claude

![Claude style: reads and searches folded into one line, then Bash and Update rows](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/claude-style.gif)

- Reads, searches, and listings fold into one line: `Searched for 2 patterns, read 3 files`.
- `Bash`, `Update`, `Write`, and custom tools keep their own rows with short previews.

### Mode: Silent

![Silent mode switched on mid-run: the rows fold into a moving light, the answer stays, and every row comes back when it is off](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/silent-mode.gif)

Shows only your prompts and the answers, in either style.

- Toggle with `Ctrl+'` or `/silent`. Tool rows and thinking fold into a moving light while the agent works.
- Turn it off and every row comes back. `"mode": "silent"` starts sessions with it on.

## Configuration

Optional, in `~/.pi/agent/compact-tools.json` or `<project>/.pi/compact-tools.json`:

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

- `tools`: built-ins to compact. Also `grep`, `find`, `ls`, `powershell`.
- `auto_compact`: `true` starts a row collapsed; `false` shows up to `previewLines` rows. Custom tool names work too.
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

Renders are pinned in `tests/golden/render.json`. After an intended change to the output, record it with `UPDATE_GOLDEN=1 npm test` and review the diff. Before publishing, add the version's notes to `release-notes.json` (`[]` for none).

## License

MIT
