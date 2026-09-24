# pi-compact-tools

Compact, expandable rendering for Pi's built-in tools and for custom tools from other packages, with a GitHub Dark theme.

![Compact rows for built-in and custom tools, including a web search and an edit with its diff and line counts](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/compact-workflow.gif)

![Syntax-highlighted edit diff with lines added and removed](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/edit-diff.gif)

![Numbered read code view](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/code-aware-results.gif)

## Features

- Compact rows for `read`, `write`, `edit`, `bash`, `powershell`, `grep`, `find`, and `ls`, with status, duration, and line count
- The same compact rows for custom tools registered by other packages, such as web search or MCP tools, with no setup
- Syntax-highlighted edit diffs and numbered `read`/`write` code views, including Markdown code fences
- Edits report what they changed on their status line, lines added and removed in the diff colors: `(+3 -1)`
- Animated working label above the prompt, lit in the session's own thinking-level color, and a `Ctrl+T` thinking summary/detail cycle
- Theme-agnostic chrome: rails, the tool indicator, and the working label are derived from the active theme and stay legible on light and dark backgrounds
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
- `auto_compact`: `true` starts hidden, `false` starts with a preview of up to `previewLines` rows (`1`–`100`). Custom tools can be listed by name too, such as `"web_search": false`.
- `mode`: `"normal"` (default) or `"silent"`. See [Silent mode](#silent-mode).
- `custom_tools`: compact rendering for tools from other packages. See [Custom tools](#custom-tools).

## Custom tools

Tools registered by other packages get the same row as the built-ins: a status indicator, the tool name, a one-line summary of the call, then duration and line count once it finishes. It works for any tool, whichever package registered it, with nothing to configure.

Expanding a row shows the call's arguments and then the result as the tool's own package renders it, so a package's custom result view is kept. Tools without a result renderer show their text output.

```json
{
  "custom_tools": { "enabled": true, "auto_compact": true, "exclude": ["my_tool"] }
}
```

- `enabled`: `false` leaves every custom tool with its own renderer. `"custom_tools": false` is shorthand.
- `auto_compact`: like the built-in setting, `true` starts rows hidden and `false` starts with a preview. A tool named in the top-level `auto_compact` uses its own setting instead.
- `exclude`: tool names that keep their own renderer.

Built-in tools follow `tools` above: a built-in left out of that list keeps Pi's default renderer.

Pi has no public API for changing how another package's tool is drawn, so this wraps the renderer lookup of Pi's tool row component. Nothing in Pi's installation is modified, and it only applies while this extension is loaded. If a Pi release changes that component, custom tools fall back to their own renderers and Pi shows a warning once.

## Silent mode

![Silent mode switched on mid-run: the tool rows fold away into a moving light, the answer stays, and every row comes back when it is off](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/silent-mode.gif)

Silent mode shows only your prompts and the final answers. Tool calls (including custom tools from other packages), the assistant's in-between turns, thinking, error and abort notices, extension notices such as web-search progress, and Pi's own status lines are hidden while the animated working label shows what is running.

- While the agent works, a light runs back and forth along a short line beneath your latest prompt, above the working label and just as long, leaving a fading afterimage in the thinking level's color. It steps aside once the answer starts.
- `Ctrl+'` or `/silent` toggles it for the current session; `/silent on` and `/silent off` set it explicitly.
- `Ctrl+'` needs a terminal that reports it as its own key (the Kitty keyboard protocol: Ghostty, Kitty, WezTerm, and others). Where it only types `'`, use `/silent`.
- Set `"mode": "silent"` in `compact-tools.json` to start every session silent.
- Turning it off brings back every hidden row. Nothing is removed from the session or the model's context.
- Errors are hidden too, so a run that fails ends without an answer. Turn silent mode off to see what went wrong.

Pi has no public API for hiding other extensions' tool rows, so silent mode wraps Pi's transcript components. If a future Pi release changes them, `/silent` reports that it is unavailable and the transcript renders normally.

## Controls

- Click a row or press `Ctrl+O` to expand or collapse results.
- In fullscreen mode, expanding or collapsing every row, cycling thinking, and toggling silent mode keep the text you were reading in place instead of jumping.
- `Ctrl+T` cycles thinking: summary → detail → summary → hidden.
- `Ctrl+'` or `/silent` toggles silent mode.

## Release notes

After an update, the next new conversation opens with a bordered "What's new" block, the way Pi shows its own changelog: once, listing every release since the last one shown. A resumed session keeps it for the next new one, and so does silent mode. The block lives only in the TUI; it is never saved to the session or sent to the model. When publishing a new version, add its changes to `release-notes.json`; `npm run check` requires an entry matching `package.json`.

## Development

```bash
npm install
npm run check
pi -e .
```

## License

MIT
