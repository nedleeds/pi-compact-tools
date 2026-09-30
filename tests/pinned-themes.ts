/**
 * The dark and light themes the golden renders are recorded in, pinned to the
 * files Pi 0.85 to 0.87 shipped. Pi revises its built-in themes (0.99 did), and
 * the suite runs against every Pi the extension supports, so the colors a test
 * draws with have to come from here rather than from whichever Pi is installed.
 * Registered themes take precedence over built-ins of the same name, so every
 * `initTheme("dark")` in the suite gets the pinned file. Import this first.
 */
import "./pinned-themes.ts";
import { join } from "node:path";
import { loadThemeFromPath, setRegisteredThemes } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

setRegisteredThemes(["dark", "light"].map((name) =>
	loadThemeFromPath(join(import.meta.dirname, "fixtures", `theme-${name}.json`), "truecolor")));
