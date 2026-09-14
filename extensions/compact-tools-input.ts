import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";

export type ToggleInput = "toggle" | "release";

export function classifyToggleInput(data: string): ToggleInput | undefined {
	if (!matchesKey(data, Key.ctrl("o"))) return undefined;
	return isKeyRelease(data) ? "release" : "toggle";
}
