import type { PanelTab } from "./panels/side-panel.js";

/**
 * Everything about the interface that is not part of the game.
 *
 * Kept out of `GameState` deliberately: which tab is open and where a cursor
 * sits are not facts about the world, they do not belong in a save file, and
 * the old design's habit of serialising UI flags into domain state is what made
 * a save taken mid-action load permanently locked. Kept *pure* so the awkward
 * parts — clamping a cursor against a list that shrank, keeping a selection
 * visible inside a short window — are testable without rendering anything.
 */

/** Tabs holding a list the player can move a cursor through. */
export const LIST_TABS: ReadonlySet<PanelTab> = new Set<PanelTab>([
	"inventory",
	"quests",
	"journal",
]);

/**
 * Something irreversible, waiting on a yes.
 *
 * Both of the actions that need this destroy something the player cannot get
 * back — the item, or the session — so they share one mechanism rather than
 * each inventing a prompt.
 */
export interface PendingConfirm {
	readonly action:
		| { readonly t: "drop"; readonly name: string; readonly quantity: number }
		| {
				readonly t: "quit";
		  };
	readonly prompt: string;
	/** Shown alongside in warning colour: why this might be a mistake. */
	readonly warning?: string;
}

export interface HudState {
	readonly tab: PanelTab;
	/**
	 * Whether the arrow keys drive the panel instead of the player.
	 *
	 * A modeful binding rather than a second set of keys: the panel needs up and
	 * down, and every unshifted alternative is either taken or unguessable.
	 * Which mode you are in is shown by the panel border and spelled out in the
	 * key bar, so the mode is never invisible.
	 */
	readonly focus: boolean;
	readonly cursor: number;
	readonly confirm?: PendingConfirm;
}

export type HudAction =
	| { readonly t: "SelectTab"; readonly tab: PanelTab }
	| { readonly t: "Focus" }
	| { readonly t: "Blur" }
	/** `count` is the current list length, so a stale cursor cannot outlive it. */
	| { readonly t: "MoveCursor"; readonly delta: number; readonly count: number }
	| { readonly t: "Ask"; readonly confirm: PendingConfirm }
	| { readonly t: "Dismiss" };

/**
 * Opening on a tab puts the interface in the same state pressing its key would.
 * Only the screenshot tool and the tests start anywhere but the map, and a shot
 * of the inventory should show the inventory as the player would meet it.
 */
export function initialHud(tab: PanelTab = "map"): HudState {
	return { tab, focus: LIST_TABS.has(tab), cursor: 0 };
}

export function hudReducer(state: HudState, action: HudAction): HudState {
	switch (action.t) {
		case "SelectTab":
			// Opening a list is the whole reason for pressing its key, so it arrives
			// focused; the two read-only panes release the keys again.
			return {
				tab: action.tab,
				focus: LIST_TABS.has(action.tab),
				cursor: action.tab === state.tab ? state.cursor : 0,
			};
		case "Focus":
			if (!LIST_TABS.has(state.tab) || state.focus) return withoutConfirm(state);
			return { ...withoutConfirm(state), focus: true };
		case "Blur":
			if (!state.focus && !state.confirm) return state;
			return { ...withoutConfirm(state), focus: false };
		case "MoveCursor":
			return { ...state, cursor: clampCursor(state.cursor + action.delta, action.count) };
		case "Ask":
			return { ...state, confirm: action.confirm };
		case "Dismiss":
			return withoutConfirm(state);
	}
}

function withoutConfirm(state: HudState): HudState {
	if (!state.confirm) return state;
	const { confirm: _confirm, ...rest } = state;
	return rest;
}

/** Never off the end, never negative, and always zero for an empty list. */
export function clampCursor(cursor: number, count: number): number {
	if (count <= 0) return 0;
	if (cursor < 0) return 0;
	return cursor > count - 1 ? count - 1 : cursor;
}

export interface ListWindow {
	readonly start: number;
	/** Exclusive. */
	readonly end: number;
	readonly more: boolean;
}

/**
 * The slice of a list to draw so the cursor is on screen.
 *
 * A panel cannot grow to fit its contents — Ink stops updating incrementally
 * once the frame is as tall as the terminal and clears the screen on every
 * keypress instead — so a list longer than its box has to be windowed rather
 * than simply rendered and clipped.
 */
export function listWindow(count: number, cursor: number, rows: number): ListWindow {
	if (rows <= 0 || count <= 0) return { start: 0, end: 0, more: count > 0 };
	if (count <= rows) return { start: 0, end: count, more: false };

	const at = clampCursor(cursor, count);
	// Keep the selection roughly centred, then pin the window inside the list so
	// the last page is full rather than trailing off into blank rows.
	const start = Math.max(0, Math.min(at - Math.floor(rows / 2), count - rows));
	return { start, end: start + rows, more: true };
}
