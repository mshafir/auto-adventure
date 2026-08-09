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
export type PanelTab = "inventory" | "quests" | "journal" | "key" | "debug";

/**
 * The tabs, in the order they are laid out and stepped through.
 *
 * An array rather than a set because left and right move along it, so the order
 * on screen and the order under the keys are the same thing by construction.
 * Carrying most often first: what you have, then what you owe, then what
 * happened, then what the map means.
 */
export const PANEL_TABS: readonly PanelTab[] = ["inventory", "quests", "journal", "key"];

/**
 * The tabs on offer, which is not always all of them.
 *
 * `debug` is the one that comes and goes. It holds the prompts and answers of every
 * model call, which is a page most players have no use for and which is empty unless
 * somebody asked for the recording — and a tab that is always there and always empty
 * is a tab everybody has to step past forever to reach the one they wanted.
 *
 * A function rather than a constant because the reducer has to agree with the strip:
 * stepping is modular arithmetic over this list, so a screen drawing four tabs while
 * the reducer cycles five would leave one that could be reached and not seen.
 */
export function panelTabs(debug: boolean): readonly PanelTab[] {
	return debug ? [...PANEL_TABS, "debug"] : PANEL_TABS;
}

/** Tabs holding a list the player can move a cursor through. */
export const LIST_TABS: ReadonlySet<PanelTab> = new Set<PanelTab>([
	"inventory",
	"quests",
	"journal",
	// The list of exchanges. It behaves exactly like the other three — a cursor down a
	// list, with the detail of the selected row underneath — so it gets the same keys.
	"debug",
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
	 * Which tab the menu is showing, or absent when the player is on the map.
	 *
	 * One field where there were three. A tab used to be a 32-column box beside
	 * the map that could be open, focused, and then separately expanded to full
	 * frame — three states to be in and two keys to get through them. With the
	 * side panel gone there is no small version to be in, so opening the menu *is*
	 * taking the frame.
	 *
	 * The side panel had to go regardless: Ink cuts a row of kitty placeholders
	 * in half the moment anything shares the screen line with it.
	 */
	readonly tab?: PanelTab;
	/**
	 * Whether the arrow keys are moving down a list or along the tab strip.
	 *
	 * The menu opens on the strip: left and right change tab, down steps into
	 * what is on it. Without this, opening the menu and pressing left would move
	 * the cursor inside a list the player has not chosen yet — and there would be
	 * no way to reach the tab beside it except by name.
	 */
	readonly inList: boolean;
	readonly cursor: number;
	readonly confirm?: PendingConfirm;
	/**
	 * How far into the selected row's detail the reader has scrolled, in lines.
	 *
	 * Only the debug page has anything long enough to need it: a quest description is
	 * three lines and a prompt is three hundred. Reset whenever the selection changes,
	 * because a position forty lines into the last exchange means nothing in this one.
	 */
	readonly detail: number;
	/**
	 * How big the map is drawn: above 1 for bigger tiles and less world.
	 *
	 * Interface state rather than world state, so it stays out of the save file —
	 * the size of somebody's terminal is not a fact about the world, and a save
	 * carried to another machine should not bring one window's zoom with it.
	 */
	readonly zoom: number;
}

/**
 * The steps zoom moves through, rather than a multiplier applied repeatedly.
 *
 * A factor compounds into unrepeatable values — three presses of 1.25 is 1.953 —
 * and every distinct value is a distinct tile size, which is a distinct set of
 * sprite bitmaps to draw and cache. A short list of round numbers keeps the cache
 * warm and makes zooming out land back exactly where zooming in started.
 */
export const ZOOM_STEPS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** The step at or below a starting value, so `ZOOM=1.4` begins somewhere real. */
export function nearestZoom(value: number): number {
	let best = ZOOM_STEPS[0] as number;
	for (const step of ZOOM_STEPS) {
		if (Math.abs(step - value) < Math.abs(best - value)) best = step;
	}
	return best;
}

export type HudAction =
	/** Open the menu, on a given tab or on the first. */
	| { readonly t: "OpenMenu"; readonly tab?: PanelTab }
	| { readonly t: "CloseMenu" }
	/** Step along the tab strip. Wraps, because four tabs is a short ring. */
	| { readonly t: "StepTab"; readonly delta: number }
	/** Hand the arrow keys to the list on the open tab. */
	| { readonly t: "EnterList" }
	/** `count` is the current list length, so a stale cursor cannot outlive it. */
	| { readonly t: "MoveCursor"; readonly delta: number; readonly count: number }
	| { readonly t: "Ask"; readonly confirm: PendingConfirm }
	| { readonly t: "Dismiss" }
	/** Step along {@link ZOOM_STEPS}. Clamps at both ends rather than wrapping. */
	| { readonly t: "StepZoom"; readonly delta: number }
	/** Scroll the selected row's detail, in pages. Clamped at the top only — the
	 *  bottom depends on how many lines the text wrapped to, which only the view knows. */
	| { readonly t: "ScrollDetail"; readonly delta: number };

/**
 * Opening on a tab puts the interface in the state opening the menu and stepping
 * there would. Only the screenshot tool and the tests start anywhere but the
 * map, and a shot of the inventory should show it as the player would meet it.
 */
export function initialHud(tab?: PanelTab, zoom = 1): HudState {
	return {
		...(tab ? { tab } : {}),
		inList: false,
		cursor: 0,
		detail: 0,
		zoom: nearestZoom(zoom),
	};
}

/**
 * `tabs` defaults to the always-present four, so every existing caller and test reads
 * exactly as it did. The one caller that passes something else is the app, which knows
 * whether the debug page is on offer this run.
 */
export function hudReducer(
	state: HudState,
	action: HudAction,
	tabs: readonly PanelTab[] = PANEL_TABS,
): HudState {
	switch (action.t) {
		case "OpenMenu":
			return { tab: action.tab ?? tabs[0], inList: false, cursor: 0, detail: 0, zoom: state.zoom };
		case "CloseMenu":
			if (state.tab === undefined && !state.confirm) return state;
			// The cursor goes with the menu. Keeping it would mean the next tab
			// opened — which may be a different list entirely — started somewhere in
			// the middle for no reason the player could see.
			//
			// Zoom does not: it is how the player has chosen to look at the map, and
			// opening the inventory is not a decision to stop looking at it that way.
			return { inList: false, cursor: 0, detail: 0, zoom: state.zoom };
		case "StepTab": {
			if (state.tab === undefined) return state;
			const at = tabs.indexOf(state.tab);
			const next = tabs[(at + action.delta + tabs.length) % tabs.length];
			// Row four of the inventory has nothing to do with row four of the
			// journal, so changing tab starts from the top.
			return { ...withoutConfirm(state), tab: next, inList: false, cursor: 0, detail: 0 };
		}
		case "EnterList":
			// The key tab has nothing to select, so stepping into it would take the
			// arrow keys and give nothing back for them.
			if (state.tab === undefined || !LIST_TABS.has(state.tab)) return state;
			return { ...withoutConfirm(state), inList: true };
		case "MoveCursor":
			// The scroll goes back to the top with the selection. Keeping it would open the
			// next exchange forty lines in, which reads as an empty pane.
			return {
				...state,
				cursor: clampCursor(state.cursor + action.delta, action.count),
				detail: 0,
			};
		case "ScrollDetail":
			return { ...state, detail: Math.max(0, state.detail + action.delta) };
		case "Ask":
			return { ...state, confirm: action.confirm };
		case "Dismiss":
			return withoutConfirm(state);
		case "StepZoom": {
			const at = ZOOM_STEPS.indexOf(state.zoom);
			// An unrecognised zoom — set by hand through the environment — steps from
			// the nearest rung rather than from nowhere.
			const from = at >= 0 ? at : ZOOM_STEPS.indexOf(nearestZoom(state.zoom));
			const next = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, from + action.delta))];
			// Identity when it did not move, so pressing `+` at full zoom does not
			// re-render the map to draw exactly what is already there.
			return next === undefined || next === state.zoom ? state : { ...state, zoom: next };
		}
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
