import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { SectionedSelectList } from "../extensions/compact-tools-chooser.ts";

const labels = ["Compact", "Claude", "Codex", "Off", "Thinking display", "Working indicator"];
const plain = (text: string) => text;
function chooser() {
	return new SectionedSelectList(labels.map(value => ({ value, label: value })), 4, {
		selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain,
	});
}

test("the chooser draws a blank line between styles and display controls at every width", () => {
	const list = chooser();
	for (const width of [12, 40, 80, 120]) {
		const lines = list.render(width);
		assert.equal(lines.length, 7);
		assert.equal(lines[4], "");
		assert.ok(lines.every(line => visibleWidth(line) <= width));
	}
	assert.match(list.render(80)[3]!, /Off/);
	assert.match(list.render(80)[5]!, /Thinking display/);
});

test("keyboard navigation skips the visual gap, wraps, selects, and cancels", () => {
	const list = chooser();
	let selected: string | undefined;
	let cancelled = false;
	list.onSelect = item => { selected = item.value; };
	list.onCancel = () => { cancelled = true; };
	list.setSelectedIndex(3);
	list.handleInput("\x1b[B");
	assert.equal(list.getSelectedItem()?.value, "Thinking display");
	list.handleInput("\r");
	assert.equal(selected, "Thinking display");
	list.handleInput("\x1b[A");
	assert.equal(list.getSelectedItem()?.value, "Off");
	list.setSelectedIndex(5);
	list.handleInput("\x1b[B");
	assert.equal(list.getSelectedItem()?.value, "Compact");
	list.handleInput("\x1b[A");
	assert.equal(list.getSelectedItem()?.value, "Working indicator");
	list.handleInput("\x1b");
	assert.equal(cancelled, true);
});

test("mouse clicks ignore the gap and map display controls to the correct items", () => {
	const list = chooser();
	let selected: string | undefined;
	list.onSelect = item => { selected = item.value; };
	const click = (y: number) => list.handleMouse({ type: "click", button: "left", x: 2, y } as TuiMouseEvent);
	click(4);
	assert.equal(selected, undefined);
	assert.equal(list.getSelectedItem()?.value, "Compact");
	click(5);
	assert.equal(selected, "Thinking display");
	click(6);
	assert.equal(selected, "Working indicator");
	click(3);
	assert.equal(selected, "Off");
});
