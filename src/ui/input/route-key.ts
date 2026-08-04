import type { Command } from "../../core/rules/commands.js";
import type { HudAction, HudState } from "../hud-state.js";
import { LIST_TABS } from "../hud-state.js";
import type { PanelTab } from "../panels/side-panel.js";

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
}

const TAB_KEYS: Readonly<Record<string, PanelTab>> = {
	m: "map",
	w: "world",
	i: "inventory",
	q: "quests",
	j: "journal",
};

/**
 * The order below *is* the precedence: a pending confirmation swallows
 * everything, then a card, then a conversation, then the panel-switching keys,
 * then a focused panel, then the world.
 *
 * A card sits above the conversation because it can be raised *by* one — a story
 * beat opens as somebody speaks — and the card is what the player is looking at.
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

	if (context.inDialogue) {
		if (key.escape) return { t: "command", command: { t: "CloseDialogue" } };
		if (key.upArrow) return { t: "command", command: { t: "ChoiceUp" } };
		if (key.downArrow) return { t: "command", command: { t: "ChoiceDown" } };
		if (key.return || input === " ") return { t: "command", command: { t: "Advance" } };
		return undefined;
	}

	// Switching panes works from anywhere outside a conversation, so the player
	// never has to leave one list to reach another.
	const tab = plain ? TAB_KEYS[letter] : undefined;
	if (tab) return { t: "hud", action: { t: "SelectTab", tab } };
	if (letter === "s" && plain) {
		return {
			t: "hud",
			action: { t: "Ask", confirm: { action: { t: "quit" }, prompt: "Save and quit?" } },
		};
	}

	if (hud.focus && LIST_TABS.has(hud.tab)) {
		if (key.escape) return { t: "hud", action: { t: "Blur" } };
		if (key.upArrow) {
			return { t: "hud", action: { t: "MoveCursor", delta: -1, count: context.listCount } };
		}
		if (key.downArrow) {
			return { t: "hud", action: { t: "MoveCursor", delta: 1, count: context.listCount } };
		}
		if (letter === "d" && context.canDrop) return { t: "askDrop" };
		// Deliberately swallowed: while the panel has the arrow keys, a stray
		// keypress must not walk the player somewhere they cannot see.
		return undefined;
	}

	if (key.tab) return { t: "hud", action: { t: "Focus" } };
	if (key.upArrow) return { t: "command", command: { t: "Move", facing: "up" } };
	if (key.downArrow) return { t: "command", command: { t: "Move", facing: "down" } };
	if (key.leftArrow) return { t: "command", command: { t: "Move", facing: "left" } };
	if (key.rightArrow) return { t: "command", command: { t: "Move", facing: "right" } };
	if (input === " " || key.return) return { t: "command", command: { t: "Interact" } };
	return undefined;
}
