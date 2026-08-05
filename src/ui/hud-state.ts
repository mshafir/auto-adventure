/**
 * Everything about the interface that is not part of the game.
 *
 * Kept out of `GameState` deliberately: which page is open and where a cursor
 * sits are not facts about the world, they do not belong in a save file, and
 * the old design's habit of serialising UI flags into domain state is what made
 * a save taken mid-action load permanently locked. Kept *pure* so the awkward
 * parts — clamping a cursor against a list that shrank, keeping a selection
 * visible inside a short window — are testable without rendering anything.
 */

/**
 * The pages that can take the frame.
 *
 * There used to be five, two of which — the map summary and the minimap — were
 * views of the standing state of the world rather than pages to open. Those are
 * on screen always now: the first along the top, the second composited into the
 * map. What is left is the three lists and the key, all of them things you go
 * and look at and then come back from.
 */
export type PanelTab = "inventory" | "quests" | "journal" | "key";

/** Pages holding a list the player can move a cursor through. */
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
	/**
	 * Which page has the frame, or absent when the player is on the map.
	 *
	 * One field where there were three. A page used to be a 32-column box beside
	 * the map that could be open, focused, and then separately expanded to full
	 * frame — three states to be in and two keys to get through them. With the
	 * side panel gone there is no small version to be in, so opening a page *is*
	 * taking the frame, and the arrow keys belong to whatever is on it.
	 *
	 * The side panel had to go regardless: Ink cuts a row of kitty placeholders
	 * in half the moment anything shares the screen line with it.
	 */
	readonly tab?: PanelTab;
	readonly cursor: number;
	readonly confirm?: PendingConfirm;
}

export type HudAction =
	/** Open a page, or switch to another without going back to the map first. */
	| { readonly t: "OpenTab"; readonly tab: PanelTab }
	| { readonly t: "Close" }
	/** `count` is the current list length, so a stale cursor cannot outlive it. */
	| { readonly t: "MoveCursor"; readonly delta: number; readonly count: number }
	| { readonly t: "Ask"; readonly confirm: PendingConfirm }
	| { readonly t: "Dismiss" };

/**
 * Opening on a page puts the interface in the same state pressing its key would.
 * Only the screenshot tool and the tests start anywhere but the map, and a shot
 * of the inventory should show the inventory as the player would meet it.
 */
export function initialHud(tab?: PanelTab): HudState {
	return { ...(tab ? { tab } : {}), cursor: 0 };
}

export function hudReducer(state: HudState, action: HudAction): HudState {
	switch (action.t) {
		case "OpenTab":
			return {
				tab: action.tab,
				// Row four of the inventory has nothing to do with row four of the
				// journal, so only reopening the same page keeps its place.
				cursor: action.tab === state.tab ? state.cursor : 0,
			};
		case "Close":
			if (state.tab === undefined && !state.confirm) return state;
			// The cursor goes with the page. Keeping it would mean the next page
			// opened — which may be a different list entirely — started somewhere in
			// the middle for no reason the player could see.
			return { cursor: 0 };
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
 * A page cannot grow to fit its contents — Ink stops updating incrementally
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
