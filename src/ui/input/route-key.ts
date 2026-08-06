import type { Command } from "../../core/rules/commands.js";
import type { HudAction, HudState } from "../hud-state.js";

/**
 * What one keypress means.
 *
 * Split out from the `useInput` hook and kept pure so the bindings can be
 * tested without a terminal, a React tree or a running game. The bindings are
 * the part most likely to go quietly wrong — a key that fires in two modes, or
 * in none — and they are exactly the part a rendering test cannot see.
 */
export type Routed =
	| { readonly t: "command"; readonly command: Command }
	| { readonly t: "hud"; readonly action: HudAction }
	/** Raise the confirmation for dropping whatever the cursor is on. */
	| { readonly t: "askDrop" }
	| { readonly t: "quit" }
	| undefined;

/** Just the parts of Ink's key object this cares about. */
export interface KeyFlags {
	readonly upArrow?: boolean;
	readonly downArrow?: boolean;
	readonly leftArrow?: boolean;
	readonly rightArrow?: boolean;
	readonly return?: boolean;
	readonly escape?: boolean;
	readonly tab?: boolean;
	readonly ctrl?: boolean;
	readonly meta?: boolean;
}

export interface RouteContext {
	readonly inDialogue: boolean;
	/** Whether a full screen of prose is waiting to be read. */
	readonly onCard: boolean;
	readonly hud: HudState;
	/** How long the focused pane's list is, so a cursor cannot run off it. */
	readonly listCount: number;
	/** Whether there is something selected that could be dropped. */
	readonly canDrop: boolean;
	/**
	 * Whether zooming means anything, which is to say whether the map is drawn in
	 * pixels. A glyph is whatever size the player's font is, so there `+` and `-`
	 * could only take world away and give nothing back — and a key that quietly
	 * does nothing is indistinguishable from a game that has stopped responding.
	 */
	readonly canZoom?: boolean;
}

/**
 * One key opens everything.
 *
 * Four letters for four tabs meant four bindings to know before any of them
 * could be found, and it does not scale: a fifth page would want a fifth letter
 * and the good ones are taken. `M` for menu, and Tab because it is what a player
 * tries first — the menu then says what is in it, so nothing has to be
 * remembered.
 */
function isMenuKey(letter: string, key: KeyFlags, plain: boolean): boolean {
	return (plain && letter === "m") || key.tab === true;
}

/**
 * The order below *is* the precedence: a pending confirmation swallows
 * everything, then a card, then the menu, then a conversation, then the key that
 * opens the menu, then the world.
 *
 * A card sits above the conversation because it can be raised *by* one — a story
 * beat opens as somebody speaks — and the card is what the player is looking at.
 * The menu sits above it for the same reason: a turn landing asynchronously must
 * not take the arrow keys off somebody who is reading their quest log.
 */
export function routeKey(input: string, key: KeyFlags, context: RouteContext): Routed {
	const letter = input.toLowerCase();
	const plain = !key.ctrl && !key.meta;
	const { hud } = context;

	// Irreversible things ask first, and while they are asking nothing else
	// listens — so a stray arrow key cannot answer the question by accident.
	if (hud.confirm) {
		if (letter === "y") {
			const { action } = hud.confirm;
			return action.t === "quit"
				? { t: "quit" }
				: {
						t: "command",
						command: { t: "DropItem", name: action.name, quantity: action.quantity },
					};
		}
		if (letter === "n" || key.escape) return { t: "hud", action: { t: "Dismiss" } };
		return undefined;
	}

	// Only the keys that mean "I have read this". Dismissing on any key at all
	// would let the arrow key already under the player's finger skip the framing
	// before it was seen — and the panel keys would silently do nothing, which
	// reads as the game having locked up.
	if (context.onCard) {
		if (input === " " || key.return || key.escape) {
			return { t: "command", command: { t: "DismissCard" } };
		}
		return undefined;
	}

	/*
	 * The menu takes the whole frame, so nothing behind it can be acted on.
	 *
	 * Left and right walk the tab strip and down steps into whatever is on the
	 * tab, which is why `inList` exists: without it, the first left press would
	 * move a cursor inside a list nobody had chosen yet, and the tab beside it
	 * would be unreachable. Escape leaves outright rather than retreating to the
	 * strip — one press out is what a player expects from a menu, and left or
	 * right is already the way back to the strip.
	 */
	if (hud.tab !== undefined) {
		if (key.escape) return { t: "hud", action: { t: "CloseMenu" } };
		if (isMenuKey(letter, key, plain)) return { t: "hud", action: { t: "CloseMenu" } };
		if (key.leftArrow) return { t: "hud", action: { t: "StepTab", delta: -1 } };
		if (key.rightArrow) return { t: "hud", action: { t: "StepTab", delta: 1 } };
		if (key.downArrow) {
			return hud.inList
				? { t: "hud", action: { t: "MoveCursor", delta: 1, count: context.listCount } }
				: { t: "hud", action: { t: "EnterList" } };
		}
		if (key.upArrow && hud.inList) {
			return { t: "hud", action: { t: "MoveCursor", delta: -1, count: context.listCount } };
		}
		if (letter === "d" && plain && context.canDrop) return { t: "askDrop" };
		// Everything else is swallowed. A stray keypress must not walk the player
		// somewhere they cannot see.
		return undefined;
	}

	if (context.inDialogue) {
		if (key.escape) return { t: "command", command: { t: "CloseDialogue" } };
		if (key.upArrow) return { t: "command", command: { t: "ChoiceUp" } };
		if (key.downArrow) return { t: "command", command: { t: "ChoiceDown" } };
		if (key.return || input === " ") return { t: "command", command: { t: "Advance" } };
		return undefined;
	}

	/*
	 * Zoom, on the keys every other program puts it on.
	 *
	 * `=` as well as `+` because they are the same physical key and only one of them
	 * needs shift; `_` alongside `-` for the same reason. Bound only out here on the
	 * map, and only where the map is drawn in pixels: inside a conversation or a
	 * list there is nothing being drawn in tiles at all, and in glyph mode a tile is
	 * always two columns and one row.
	 */
	if (context.canZoom !== false) {
		if (plain && (input === "+" || input === "=")) {
			return { t: "hud", action: { t: "StepZoom", delta: 1 } };
		}
		if (plain && (input === "-" || input === "_")) {
			return { t: "hud", action: { t: "StepZoom", delta: -1 } };
		}
	}

	if (isMenuKey(letter, key, plain)) return { t: "hud", action: { t: "OpenMenu" } };
	if (letter === "s" && plain) {
		return {
			t: "hud",
			action: { t: "Ask", confirm: { action: { t: "quit" }, prompt: "Save and quit?" } },
		};
	}

	if (key.upArrow) return { t: "command", command: { t: "Move", facing: "up" } };
	if (key.downArrow) return { t: "command", command: { t: "Move", facing: "down" } };
	if (key.leftArrow) return { t: "command", command: { t: "Move", facing: "left" } };
	if (key.rightArrow) return { t: "command", command: { t: "Move", facing: "right" } };
	if (input === " " || key.return) return { t: "command", command: { t: "Interact" } };
	return undefined;
}
