import { describe, expect, it } from "vitest";
import { type HudState, initialHud } from "../hud-state.js";
import { type KeyFlags, type RouteContext, routeKey } from "./route-key.js";

function context(overrides: Partial<RouteContext> = {}): RouteContext {
	return {
		inDialogue: false,
		hud: initialHud(),
		listCount: 0,
		canDrop: false,
		...overrides,
	};
}

const NONE: KeyFlags = {};

describe("walking about", () => {
	it("moves on the arrow keys and acts on space", () => {
		expect(routeKey("", { upArrow: true }, context())).toEqual({
			t: "command",
			command: { t: "Move", facing: "up" },
		});
		expect(routeKey(" ", NONE, context())).toEqual({
			t: "command",
			command: { t: "Interact" },
		});
	});

	it("opens each pane on its own letter", () => {
		for (const [letter, tab] of [
			["m", "map"],
			["w", "world"],
			["i", "inventory"],
			["q", "quests"],
			["j", "journal"],
		] as const) {
			expect(routeKey(letter, NONE, context())).toEqual({
				t: "hud",
				action: { t: "SelectTab", tab },
			});
		}
	});

	it("ignores those letters when a modifier is held", () => {
		// Ctrl-W is a word-erase in most terminals and Ctrl-C already quits; neither
		// should quietly change what is on the right of the screen.
		expect(routeKey("w", { ctrl: true }, context())).toBeUndefined();
		expect(routeKey("s", { ctrl: true }, context())).toBeUndefined();
	});
});

describe("a conversation", () => {
	const talking = context({ inDialogue: true });

	it("takes the arrow keys for the replies", () => {
		expect(routeKey("", { upArrow: true }, talking)).toEqual({
			t: "command",
			command: { t: "ChoiceUp" },
		});
	});

	it("swallows the panel keys, so a reply beginning with q does not open the log", () => {
		// The bug this replaced: the side panel registered its own `useInput`, so
		// tab letters fired mid-sentence with no modal guard at all.
		for (const letter of ["m", "w", "i", "q", "j", "s"]) {
			expect(routeKey(letter, NONE, talking), letter).toBeUndefined();
		}
	});
});

describe("a focused panel", () => {
	const browsing: HudState = { tab: "inventory", focus: true, cursor: 1 };

	it("moves the cursor instead of the player", () => {
		const ctx = context({ hud: browsing, listCount: 4 });
		expect(routeKey("", { downArrow: true }, ctx)).toEqual({
			t: "hud",
			action: { t: "MoveCursor", delta: 1, count: 4 },
		});
	});

	it("gives the arrow keys back on escape", () => {
		expect(routeKey("", { escape: true }, context({ hud: browsing }))).toEqual({
			t: "hud",
			action: { t: "Blur" },
		});
	});

	it("swallows space rather than acting on the world behind it", () => {
		// Pressing space while reading the inventory would otherwise search the
		// crate the player happens to be facing, off screen.
		expect(routeKey(" ", NONE, context({ hud: browsing }))).toBeUndefined();
	});

	it("still switches panes and still quits", () => {
		const ctx = context({ hud: browsing });
		expect(routeKey("q", NONE, ctx)).toEqual({
			t: "hud",
			action: { t: "SelectTab", tab: "quests" },
		});
		expect(routeKey("s", NONE, ctx)?.t).toBe("hud");
	});

	it("offers a drop only when there is something to drop", () => {
		expect(routeKey("d", NONE, context({ hud: browsing, canDrop: true }))).toEqual({
			t: "askDrop",
		});
		expect(routeKey("d", NONE, context({ hud: browsing, canDrop: false }))).toBeUndefined();
	});

	it("does nothing on a pane that is only a display", () => {
		// `focus` should never be true here, but if it ever were, the arrow keys
		// must not vanish into a minimap.
		const ctx = context({ hud: { tab: "world", focus: true, cursor: 0 } });
		expect(routeKey("", { upArrow: true }, ctx)).toEqual({
			t: "command",
			command: { t: "Move", facing: "up" },
		});
	});
});

describe("a question that cannot be undone", () => {
	const asking = (confirm: NonNullable<HudState["confirm"]>): RouteContext =>
		context({ hud: { tab: "inventory", focus: true, cursor: 0, confirm } });

	const dropTimber = asking({
		action: { t: "drop", name: "Timber", quantity: 3 },
		prompt: "Drop 3 Timber?",
	});

	it("drops only on yes", () => {
		expect(routeKey("y", NONE, dropTimber)).toEqual({
			t: "command",
			command: { t: "DropItem", name: "Timber", quantity: 3 },
		});
	});

	it("takes back the question on no or escape", () => {
		expect(routeKey("n", NONE, dropTimber)).toEqual({ t: "hud", action: { t: "Dismiss" } });
		expect(routeKey("", { escape: true }, dropTimber)).toEqual({
			t: "hud",
			action: { t: "Dismiss" },
		});
	});

	it("ignores everything else, so nothing answers it by accident", () => {
		// Notably the keys that would otherwise be live: an arrow, a pane letter,
		// space, and `s` — which without this guard would raise a second question
		// on top of the first.
		for (const [input, key] of [
			["", { upArrow: true }],
			["", { downArrow: true }],
			[" ", NONE],
			["m", NONE],
			["s", NONE],
			["d", NONE],
		] as const) {
			expect(routeKey(input, key, dropTimber), input).toBeUndefined();
		}
	});

	it("quits only on yes, and only after being asked", () => {
		expect(routeKey("s", NONE, context())).toEqual({
			t: "hud",
			action: { t: "Ask", confirm: { action: { t: "quit" }, prompt: "Save and quit?" } },
		});
		expect(
			routeKey("y", NONE, asking({ action: { t: "quit" }, prompt: "Save and quit?" })),
		).toEqual({ t: "quit" });
	});
});
