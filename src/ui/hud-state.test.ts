import { describe, expect, it } from "vitest";
import { clampCursor, type HudState, hudReducer, initialHud, listWindow } from "./hud-state.js";

describe("panel focus", () => {
	it("takes the arrow keys when a list is opened, and gives them back on a display", () => {
		// Pressing `i` to look at your bag and then having to press something else
		// before you can move the cursor would be a binding nobody would find.
		const inventory = hudReducer(initialHud(), { t: "SelectTab", tab: "inventory" });
		expect(inventory.focus).toBe(true);
		const map = hudReducer(inventory, { t: "SelectTab", tab: "map" });
		expect(map.focus).toBe(false);
	});

	it("refuses focus on a pane with nothing to select", () => {
		// Otherwise the arrow keys would be swallowed by the minimap and the player
		// would be unable to walk with no way to tell why.
		expect(hudReducer(initialHud("world"), { t: "Focus" }).focus).toBe(false);
		expect(hudReducer(initialHud("quests"), { t: "Focus" }).focus).toBe(true);
	});

	it("keeps the cursor when the same tab is reselected", () => {
		let state = hudReducer(initialHud("inventory"), { t: "MoveCursor", delta: 3, count: 8 });
		expect(state.cursor).toBe(3);
		state = hudReducer(state, { t: "SelectTab", tab: "inventory" });
		expect(state.cursor).toBe(3);
	});

	it("starts a different tab from the top", () => {
		// Row four of the inventory has nothing to do with row four of the journal.
		let state = hudReducer(initialHud("inventory"), { t: "MoveCursor", delta: 3, count: 8 });
		state = hudReducer(state, { t: "SelectTab", tab: "journal" });
		expect(state.cursor).toBe(0);
	});

	it("drops a pending question when the player looks somewhere else", () => {
		// A confirmation that survived a tab change would be answered by whatever
		// the player pressed next, about something they were no longer looking at.
		const asked = hudReducer(initialHud("inventory"), {
			t: "Ask",
			confirm: { action: { t: "drop", name: "Timber", quantity: 3 }, prompt: "Drop?" },
		});
		expect(asked.confirm).toBeDefined();
		expect(hudReducer(asked, { t: "SelectTab", tab: "map" }).confirm).toBeUndefined();
		expect(hudReducer(asked, { t: "Blur" }).confirm).toBeUndefined();
		expect(hudReducer(asked, { t: "Dismiss" }).confirm).toBeUndefined();
	});
});

describe("the cursor", () => {
	it("stops at both ends rather than wrapping", () => {
		// Wrapping a five-item list means one press past the bottom is the top,
		// which in a panel this short reads as the list having jumped.
		const at = (cursor: number, delta: number) =>
			hudReducer(
				{ tab: "inventory", focus: true, expanded: false, cursor },
				{ t: "MoveCursor", delta, count: 5 },
			).cursor;
		expect(at(0, -1)).toBe(0);
		expect(at(4, 1)).toBe(4);
		expect(at(2, 1)).toBe(3);
	});

	it("survives the list shrinking underneath it", () => {
		// Real: the last item is dropped while the cursor is on it, or a quest
		// closes. Clamping at the move is what stops the pane reading past the end.
		expect(clampCursor(7, 3)).toBe(2);
		expect(clampCursor(7, 0)).toBe(0);
		expect(clampCursor(-4, 3)).toBe(0);
	});
});

describe("the scroll window", () => {
	it("shows everything when everything fits", () => {
		expect(listWindow(4, 0, 10)).toEqual({ start: 0, end: 4, more: false });
	});

	it("keeps the selection on screen wherever it is", () => {
		for (let cursor = 0; cursor < 40; cursor++) {
			const view = listWindow(40, cursor, 6);
			expect(cursor, `cursor ${cursor} scrolled off the top`).toBeGreaterThanOrEqual(view.start);
			expect(cursor, `cursor ${cursor} scrolled off the bottom`).toBeLessThan(view.end);
			expect(view.end - view.start).toBe(6);
		}
	});

	it("never scrolls past either end", () => {
		expect(listWindow(40, 0, 6).start).toBe(0);
		expect(listWindow(40, 39, 6).end).toBe(40);
	});

	it("copes with an empty list and with no room", () => {
		expect(listWindow(0, 0, 5)).toEqual({ start: 0, end: 0, more: false });
		expect(listWindow(5, 0, 0)).toEqual({ start: 0, end: 0, more: true });
	});
});

describe("hud state", () => {
	it("is not something a save could ever contain", () => {
		// UI flags serialised into domain state are what made a save taken
		// mid-action load permanently locked in the previous design; this type
		// exists to keep that separation visible.
		const state: HudState = initialHud();
		expect(Object.keys(state).sort()).toEqual(["cursor", "expanded", "focus", "tab"]);
	});
});

describe("expanding a list to read it", () => {
	it("focuses as well, so the arrows cannot still be moving the player", () => {
		const state = hudReducer(initialHud("map"), { t: "SelectTab", tab: "quests" });
		const reading = hudReducer(state, { t: "Expand" });
		expect(reading.expanded).toBe(true);
		expect(reading.focus).toBe(true);
	});

	it("refuses on a tab with no list to read", () => {
		expect(hudReducer(initialHud("map"), { t: "Expand" }).expanded).toBe(false);
		expect(hudReducer(initialHud("world"), { t: "Expand" }).expanded).toBe(false);
	});

	it("keeps reading when the player switches to another list", () => {
		const reading = hudReducer(initialHud("quests"), { t: "Expand" });
		const moved = hudReducer(reading, { t: "SelectTab", tab: "journal" });
		expect(moved.expanded).toBe(true);
		expect(moved.tab).toBe("journal");
	});

	it("stops reading when the player asks for a tab that has no list", () => {
		// Asking for the map is how you leave, so it must not leave a reader up over it.
		const reading = hudReducer(initialHud("quests"), { t: "Expand" });
		expect(hudReducer(reading, { t: "SelectTab", tab: "map" }).expanded).toBe(false);
	});

	it("keeps the cursor across expanding and collapsing", () => {
		// The two views index the same list, which is the whole reason the reader is the
		// same tab rather than a screen of its own.
		const at = hudReducer(initialHud("quests"), { t: "MoveCursor", delta: 2, count: 5 });
		const reading = hudReducer(at, { t: "Expand" });
		expect(hudReducer(reading, { t: "Collapse" }).cursor).toBe(2);
	});

	it("is closed by blurring, not merely unfocused behind a reader", () => {
		const reading = hudReducer(initialHud("quests"), { t: "Expand" });
		const blurred = hudReducer(reading, { t: "Blur" });
		expect(blurred.expanded).toBe(false);
		expect(blurred.focus).toBe(false);
	});
});
