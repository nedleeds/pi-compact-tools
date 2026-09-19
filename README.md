# pi-compact-tools

Compact, expandable rendering for Pi's built-in tools, with a polished GitHub Dark theme.

> Formerly `@nedleeds/pi-compact-ui`. New installations should use `pi-compact-tools`.

## Demo

The UI uses portable Unicode symbols and does not require a Nerd Font.

### Compact tool workflow

Active, successful, and failed tool calls stay compact while preserving useful status and timing information.

![Compact tool workflow with Nerd Font](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/nerd-font-workflow-optimized.gif)

### Progress and duration display

The working label above the prompt uses the Thinking summary color with a soft white light sweep. Every tool state uses the same `⦁` glyph; running tools use a fourteen-frame cosine-eased RGB pulse between dim and bright gray, then settle to green on success or red on failure. Elapsed time remains visible in the neutral control color.

![Spinner and elapsed-time display](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/spinner-duration-optimized.gif)

### Code-aware results

Completed `edit` rows render a syntax-highlighted diff: a line-number and `+`/`-` gutter beside the code, tinted rows for additions and deletions, and `⋮` where context is skipped. Collapsed rows keep one line of context around each change so the edit itself stays visible; expanding with a click or `Ctrl+O` restores the full context the patch carries.

```text
⦁ edit src/load.ts
 │ 3   export async function load(path: string): Promise<string> {
 │ 4 -    const raw = await readFile(path, "utf8");
 │ 4 +    const raw = await readFile(path, "utf-8");
 │ 5      return raw.trim();
 └─ Done in 0.012s (2 lines)
```

`read` and `write` results use the same numbered, syntax-highlighted layout without the diff signs. `read` line numbers start at the requested `offset`, and Pi's continuation notice (`[Showing lines …]`) is shown as a dim note below the code. Markdown files keep their exact source but style headings, lists, quotes, links, emphasis, and inline code, while fenced blocks are highlighted in their declared language. Files without a recognized language keep the plain output color instead of a guessed highlight.

![Edit diff](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/edit-diff.gif)

## Features

- Compact rendering for `read`, `write`, `edit`, `bash`, `powershell`, `grep`, `find`, and `ls`
- One continuously glowing working label above the input prompt across thinking and tool execution
- Semantic built-in progress labels and automatically cleaned custom/MCP tool names; collapsed text-search rows include the searched pattern
- Four-step `Ctrl+T` thinking cycle when provider detail is available: summary, detail, summary, then hidden
- Millisecond-precision duration and completed output line counts with neutral status text
- Per-tool hidden or persistent bounded-preview collapsed state with `auto_compact: true` or `false`
- Primary invocation targets such as paths and patterns stay visible, including common collapsed shell file operations
- Click and `Ctrl+O` follow Pi's built-in expansion state while preview rows collapse back to their preview
- Edit results render as syntax-highlighted diffs with a line-number gutter, tinted change rows, and `⋮` context breaks
- `read` and `write` contents use the same numbered, syntax-highlighted layout, with `read` line numbers following `offset`
- Markdown files keep their exact source but style headings, lists, quotes, links, and inline code, and highlight fenced code blocks in their declared language
- Configurable `previewLines` prevents large diffs, HTML, and shell output from flooding the transcript
- Width-cached expanded results, edit-diff processing, and unchanged result reuse during status animation
- Dark `│` and `└─` visual grouping
- Distinct cool-blue thinking text
- Truecolor and 256-color terminal support, plus Windows, Unix, and classic Mac line endings
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

Every tool call title uses `⦁`. Pending calls use dark gray; active calls smoothly pulse through fourteen cosine-eased RGB frames at a 45 ms interval without disappearing. Animation starts while arguments stream, so `write` and `edit` remain visibly active before their filesystem operation begins. Successful titles use green, and failed titles use red. `Done`, `Failed`, elapsed time, and line counts use the same neutral control color without printing inline click or keyboard hints. A single Pi working label animates independently of token arrival and reports `Thinking…`, `Responding…`, semantic built-in states such as `Reading file…`, or cleaned custom states such as `Using jira search…`. Invocation arguments remain in the tool row instead of being duplicated above the prompt. No separate spinner glyph is shown above the prompt.

`auto_compact` controls each tool's initial result state:

- `true` starts with the result hidden.
- `false` starts with at most `previewLines` rendered rows visible.
- Clicking or pressing `Ctrl+O` expands the complete result through Pi's built-in expansion state.

`previewLines` accepts `1`–`100` and defaults to `10`. It limits the collapsed preview; the complete result remains available. Unspecified entries inherit the previous configuration layer. By default, `read`, `write`, and `bash` start hidden, while `edit` starts with a short diff preview centered on the changed lines.

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

Standalone bold lines and Markdown headings split one provider thinking run into logical sections. Each section gets its own summary and optional `│`-indented detail. Summary-only views stay uncluttered with no control hint; the control row appears only while provider-supplied detail is visible. When no thinking detail exists, `Ctrl+T` falls back to Pi's normal visible/hidden toggle instead of showing a duplicate detail phase. While thinking streams, a slightly faster highlight sweeps from the Thinking summary color to white across Pi's working label at a steady interval rather than depending on token updates. The transcript summary remains visually stable. The transformation is display-only; complete thinking remains unchanged in the session and model context.

Primary file and search targets stay visible. Collapsed `bash` and `powershell` rows describe intent—such as `Run tests` or `Check repository status`. Text searches retain their primary pattern (for example, `Search text "TODO|FIXME"`), and common file commands retain their operands (for example, `Run rm "build"` or `Find files "*.test.ts" in "src"`). Expanding the row reveals the exact command. After every supported tool completes, the status reports the expanded result size as `Done in …s (N lines)` instead of repeating options such as context and limit. Counts use the returned text for reads, searches, listings, and shell commands, written content for `write`, and only the changed `-`/`+` lines for `edit`. The count is computed once after completion and cached with the row, so streaming and repeated expansion do not add ongoing work. Large payloads represented as results follow the result toggle.

A mouse click toggles one row using Pi's native result state. `Ctrl+O` remains owned by Pi and expands or collapses all tool rows consistently, including tools not rendered by this extension. A row with `auto_compact: false` cycles predictably between its bounded preview and the complete result, so repeated clicks never remove the row and fall through to a neighboring Thinking block. The extension does not intercept the global keybinding.

## Notes

- Pi `0.85.1+` and Node.js `22.19.0+` are recommended.
- The working indicator and mouse interaction are provided by Pi's TUI; `Ctrl+O` also works in regular mode.
- Duration covers the full rendered tool-call lifecycle, including streamed `write` and `edit` arguments.
- Syntax highlighting is skipped, keeping line numbers, for content over 512 KB, 10,000 lines, or a single 4 KB line. Pi already truncates `read` output to 2,000 lines or 50 KB.
- Highlighting runs per diff hunk or `read` range, so a hunk or `offset` that starts inside a block comment or Markdown code fence may color its first lines as surrounding text.
- Selected tools override definitions with the same names so their compact renderers are restored reliably after `/reload`; other extensions overriding those tools may conflict by load order.

## Development

```bash
npm install
npm run check
pi -e .
```

Pi extensions execute with full system access. Review third-party extension source before installation.

## License

MIT
