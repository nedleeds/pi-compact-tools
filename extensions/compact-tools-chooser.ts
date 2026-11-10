import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem, type SelectListTheme, type TuiMouseEvent } from "@earendil-works/pi-tui";

/** A visual gap, not a choice: keyboard selection stays entirely in SelectList. */
export class SectionedSelectList extends SelectList {
	constructor(items: SelectItem[], private readonly breakBefore: number, theme: SelectListTheme) {
		super(items, items.length, theme);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		lines.splice(this.breakBefore, 0, "");
		return lines;
	}

	override handleMouse(event: TuiMouseEvent) {
		if (event.type !== "wheel" && event.y === this.breakBefore) return { handled: true };
		return super.handleMouse({ ...event, y: event.y > this.breakBefore ? event.y - 1 : event.y });
	}
}

export async function chooseToolDisplay(ctx: ExtensionContext, title: string, styles: string[], displays: string[]): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 0, 0));
		const list = new SectionedSelectList([...styles, ...displays].map(value => ({ value, label: value })), styles.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(undefined);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 0, 0));
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		return {
			capturesViewportInput: list.capturesViewportInput,
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data) { list.handleInput(data); tui.requestRender(); },
			handleMouse: (event) => container.handleMouse(event),
		};
	});
}
