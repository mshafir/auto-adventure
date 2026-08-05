import { describe, expect, it } from "vitest";
import { type HudState, initialHud } from "../hud-state.js";
import { type KeyFlags, type RouteContext, routeKey } from "./route-key.js";

function context(overrides: Partial<RouteContext> = {}): RouteContext {
	return {
		inDialogue: false,
		onCard: false,
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

	it("opens each page on its own letter", () => {
		for (const [letter, tab] of [
			["i", "inventory"],
			["q", "quests"],
			["j", "journal"],
			["k", "key"],
		] as const) {
			expect(routeKey(letter, NONE, context())).toEqual({
				t: "hud",
				action: { t: "OpenTab", tab },
			});
		}
	});

	it("ignores those letters when a modifier is held", () => {
		// Ctrl-Q closes a window in some terminals and Ctrl-C already quits; neither
		// should quietly put a page over the map.
		expect(routeKey("q", { ctrl: true }, context())).toBeUndefined();
		expect(routeKey("s", { ctrl: true }, context())).toBeUndefined();
	});

	// The map is the whole frame now, so there is no panel beside it to hand the
	// arrow keys to and nothing for Tab to mean.
	it("has nothing bound to Tab", () => {
		expect(routeKey("", { tab: true }, context())).toBeUndefined();
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

	it("swallows the page keys, so a reply beginning with q does not open the log", () => {
		// The bug this replaced: the side panel registered its own `useInput`, so
		// page letters fired mid-sentence with no modal guard at all.
		for (const letter of ["i", "q", "j", "k", "s"]) {
			expect(routeKey(letter, NONE, talking), letter).toBeUndefined();
		}
	});
});

describe("a question that cannot be undone", () => {
	const asking = (confirm: NonNullable<HudState["confirm"]>): RouteContext =>
		context({ hud: { tab: "inventory", cursor: 0, confirm } });

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
		// Notably the keys that would otherwise be live: an arrow, a page letter,
		// space, and `s` — which without this guard would raise a second question
		// on top of the first.
		for (const [input, key] of [
			["", { upArrow: true }],
			["", { downArrow: true }],
			[" ", NONE],
			["j", NONE],
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

describe("a card in front of everything", () => {
	it("goes away on the keys that mean 'read'", () => {
		for (const [input, key] of [
			[" ", NONE],
			["", { return: true }],
			["", { escape: true }],
		] as const) {
			expect(routeKey(input, key, context({ onCard: true }))).toEqual({
				t: "command",
				command: { t: "DismissCard" },
			});
		}
	});

	it("swallows the arrow keys, so framing cannot be walked out of unread", () => {
		expect(routeKey("", { upArrow: true }, context({ onCard: true }))).toBeUndefined();
		expect(routeKey("", { rightArrow: true }, context({ onCard: true }))).toBeUndefined();
	});

	it("swallows the page and quit keys too", () => {
		// These would otherwise fire behind the card and look like the game had hung.
		expect(routeKey("j", NONE, context({ onCard: true }))).toBeUndefined();
		expect(routeKey("s", NONE, context({ onCard: true }))).toBeUndefined();
	});

	it("comes second to a pending confirmation, which is irreversible", () => {
		const asking: HudState = {
			...initialHud(),
			confirm: { action: { t: "quit" }, prompt: "Save and quit?" },
		};
		expect(routeKey("y", NONE, context({ onCard: true, hud: asking }))).toEqual({ t: "quit" });
	});

	it("outranks a conversation, because a beat can raise one mid-sentence", () => {
		expect(
			routeKey("", { upArrow: true }, context({ onCard: true, inDialogue: true })),
		).toBeUndefined();
		expect(routeKey(" ", NONE, context({ onCard: true, inDialogue: true }))).toEqual({
			t: "command",
			command: { t: "DismissCard" },
		});
	});
});

describe("a page over the map", () => {
	const open = (tab: "quests" | "journal" | "inventory" | "key" = "quests"): HudState =>
		initialHud(tab);

	it("moves the cursor instead of the player", () => {
		expect(routeKey("", { downArrow: true }, context({ hud: open(), listCount: 4 }))).toEqual({
			t: "hud",
			action: { t: "MoveCursor", delta: 1, count: 4 },
		});
		expect(routeKey("", { upArrow: true }, context({ hud: open(), listCount: 4 }))).toEqual({
			t: "hud",
			action: { t: "MoveCursor", delta: -1, count: 4 },
		});
	});

	it("gives the map back on Esc", () => {
		expect(routeKey("", { escape: true }, context({ hud: open() }))).toEqual({
			t: "hud",
			action: { t: "Close" },
		});
	});

	// The same press that opened it, which is what every other toggle on a
	// keyboard does — and it means Esc is not the only way out.
	it("closes on the key of the page already open", () => {
		expect(routeKey("q", NONE, context({ hud: open("quests") }))).toEqual({
			t: "hud",
			action: { t: "Close" },
		});
	});

	it("switches to another page without going back to the map", () => {
		expect(routeKey("j", NONE, context({ hud: open("quests") }))).toEqual({
			t: "hud",
			action: { t: "OpenTab", tab: "journal" },
		});
	});

	it("swallows space rather than acting on the world behind it", () => {
		// Pressing space while reading the inventory would otherwise search the
		// crate the player happens to be facing, off screen.
		expect(routeKey(" ", NONE, context({ hud: open() }))).toBeUndefined();
	});

	it("offers a drop only when there is something to drop", () => {
		expect(routeKey("d", NONE, context({ hud: open("inventory"), canDrop: true }))).toEqual({
			t: "askDrop",
		});
		expect(
			routeKey("d", NONE, context({ hud: open("inventory"), canDrop: false })),
		).toBeUndefined();
	});

	it("swallows everything else, including the keys that would walk away", () => {
		expect(routeKey("", { leftArrow: true }, context({ hud: open() }))).toBeUndefined();
		expect(routeKey("s", NONE, context({ hud: open() }))).toBeUndefined();
		expect(routeKey("", { tab: true }, context({ hud: open() }))).toBeUndefined();
	});

	it("comes second to a pending confirmation", () => {
		const asking: HudState = {
			...open("inventory"),
			confirm: { action: { t: "drop", name: "Timber", quantity: 1 }, prompt: "Drop it?" },
		};
		expect(routeKey("y", NONE, context({ hud: asking }))).toEqual({
			t: "command",
			command: { t: "DropItem", name: "Timber", quantity: 1 },
		});
	});

	it("outranks a conversation, so a turn landing cannot steal the arrows", () => {
		// A dialogue turn resolves asynchronously and can arrive at any moment; taking
		// the arrow keys off somebody mid-read would be indistinguishable from a bug.
		expect(
			routeKey("", { downArrow: true }, context({ hud: open(), inDialogue: true, listCount: 3 })),
		).toEqual({ t: "hud", action: { t: "MoveCursor", delta: 1, count: 3 } });
	});
});
