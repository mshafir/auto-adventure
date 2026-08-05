import { describe, expect, it } from "vitest";
import {
	clampCursor,
	type HudState,
	hudReducer,
	initialHud,
	listWindow,
	PANEL_TABS,
} from "./hud-state.js";

describe("the menu", () => {
	it("starts on the map, with nothing open", () => {
		expect(initialHud().tab).toBeUndefined();
	});

	it("takes the frame, and gives it back", () => {
		const open = hudReducer(initialHud(), { t: "OpenMenu" });
		expect(open.tab).toBe(PANEL_TABS[0]);
		expect(hudReducer(open, { t: "CloseMenu" }).tab).toBeUndefined();
	});

	// Left and right walk the strip; without this the arrow keys would be moving
	// a cursor in a list the player has not chosen yet.
	it("opens on the tab strip rather than inside a list", () => {
		expect(hudReducer(initialHud(), { t: "OpenMenu" }).inList).toBe(false);
	});

	it("steps along the tabs and wraps at both ends", () => {
		const open = hudReducer(initialHud(), { t: "OpenMenu" });
		expect(hudReducer(open, { t: "StepTab", delta: 1 }).tab).toBe(PANEL_TABS[1]);
		expect(hudReducer(open, { t: "StepTab", delta: -1 }).tab).toBe(PANEL_TABS.at(-1));
	});

	it("goes into the list on the tab, and hands the arrow keys over", () => {
		const open = hudReducer(initialHud("inventory"), { t: "EnterList" });
		expect(open.inList).toBe(true);
	});

	// The key tab has nothing to select, so stepping in would take the arrow keys
	// and give nothing back for them.
	it("refuses to step into a tab with no list", () => {
		expect(hudReducer(initialHud("key"), { t: "EnterList" }).inList).toBe(false);
	});

	it("comes back out to the strip when the tab changes", () => {
		const inList = hudReducer(initialHud("inventory"), { t: "EnterList" });
		expect(hudReducer(inList, { t: "StepTab", delta: 1 }).inList).toBe(false);
	});

	it("starts a different tab from the top", () => {
		// Row four of the inventory has nothing to do with row four of the journal.
		let state = hudReducer(initialHud("inventory"), { t: "MoveCursor", delta: 3, count: 8 });
		state = hudReducer(state, { t: "StepTab", delta: 1 });
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
		expect(hudReducer(asked, { t: "StepTab", delta: 1 }).confirm).toBeUndefined();
		expect(hudReducer(asked, { t: "CloseMenu" }).confirm).toBeUndefined();
		expect(hudReducer(asked, { t: "Dismiss" }).confirm).toBeUndefined();
	});
});

describe("the cursor", () => {
	it("stops at both ends rather than wrapping", () => {
		// Wrapping a five-item list means one press past the bottom is the top,
		// which reads as the list having jumped.
		const at = (cursor: number, delta: number) =>
			hudReducer({ tab: "inventory", inList: true, cursor }, { t: "MoveCursor", delta, count: 5 })
				.cursor;
		expect(at(0, -1)).toBe(0);
		expect(at(4, 1)).toBe(4);
		expect(at(2, 1)).toBe(3);
	});

	it("survives the list shrinking underneath it", () => {
		// Real: the last item is dropped while the cursor is on it, or a quest
		// closes. Clamping at the move is what stops the page reading past the end.
		expect(clampCursor(7, 3)).toBe(2);
		expect(clampCursor(7, 0)).toBe(0);
		expect(clampCursor(-4, 3)).toBe(0);
	});

	// Keeping it would mean the next page opened — which may be a different list
	// entirely — started somewhere in the middle for no reason the player could see.
	it("goes back to the top when the menu is closed", () => {
		const at = hudReducer(initialHud("quests"), { t: "MoveCursor", delta: 2, count: 5 });
		expect(at.cursor).toBe(2);
		expect(hudReducer(at, { t: "CloseMenu" }).cursor).toBe(0);
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
		expect(Object.keys(state).sort()).toEqual(["cursor", "inList"]);
	});

	/*
	 * One field where there were three. A page used to be a box beside the map that
	 * could be open, focused, and then separately expanded — three states and two
	 * keys to get through them. With no small version to be in, opening a page is
	 * taking the frame, and this is what says so.
	 */
	it("says what has the keys in two fields, where there were four", () => {
		expect(initialHud("quests")).toEqual({ tab: "quests", inList: false, cursor: 0 });
	});
});
