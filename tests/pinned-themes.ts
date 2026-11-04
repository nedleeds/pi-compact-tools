/**
 * The dark and light themes the golden renders are recorded in, pinned to the
 * files Pi 0.85 to 0.87 shipped. Pi revises its built-in themes (0.99 did), and
 * the suite runs against every Pi the extension supports, so the colors a test
 * draws with have to come from here rather than from whichever Pi is installed.
 * Registered themes take precedence over built-ins of the same name, so every
 * `initTheme("dark")` in the suite gets the pinned file. Import this first.
 */
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";

// Real tool rows inject keyText in Pi 1.5+. Initialize the app's defaults like
// InteractiveMode does; the TUI-only singleton knows no app.tools.expand key.
setKeybindings(new KeybindingsManager());

// Codex spells its keys by platform; the suite records the spelling every other platform shares.
process.env.PI_COMPACT_TOOLS_PLATFORM = "win32";
import { loadThemeFromPath, setRegisteredThemes } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

setRegisteredThemes(["dark", "light"].map((name) =>
	loadThemeFromPath(join(import.meta.dirname, "fixtures", `theme-${name}.json`), "truecolor")));
