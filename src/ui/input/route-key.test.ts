import { describe, expect, it } from "vitest";
import { type HudState, initialHud, type PanelTab } from "../hud-state.js";
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

describe("zooming the map", () => {
	const zoomable = () => context({ canZoom: true });

	it("takes both halves of the key, so shift does not have to be held", () => {
		// `+` and `=` are the same physical key and only one of them needs shift.
		for (const input of ["+", "="]) {
			expect(routeKey(input, NONE, zoomable()), input).toEqual({
				t: "hud",
				action: { t: "StepZoom", delta: 1 },
			});
		}
		for (const input of ["-", "_"]) {
			expect(routeKey(input, NONE, zoomable()), input).toEqual({
				t: "hud",
				action: { t: "StepZoom", delta: -1 },
			});
		}
	});

	it("is not a modified key", () => {
		expect(routeKey("+", { ctrl: true }, zoomable())).toBeUndefined();
	});

	it("is not bound at all where the map is drawn in glyphs", () => {
		// A glyph is whatever size the player's font is, so zooming could only take
		// world away and give nothing back. Leaving the key live would spend a render
		// on a frame identical to the one already on screen.
		for (const input of ["+", "=", "-", "_"]) {
			expect(routeKey(input, NONE, context({ canZoom: false })), input).toBeUndefined();
		}
	});
});

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

	/*
	 * One key rather than four. Four letters for four tabs meant four bindings to
	 * know before any of them could be found, and it does not scale — a fifth page
	 * would want a fifth letter and the good ones are taken.
	 */
	it("opens the menu on M, and on Tab because that is what gets tried", () => {
		expect(routeKey("m", NONE, context())).toEqual({ t: "hud", action: { t: "OpenMenu" } });
		expect(routeKey("", { tab: true }, context())).toEqual({
			t: "hud",
			action: { t: "OpenMenu" },
		});
	});

	it("no longer answers to the old per-tab letters", () => {
		for (const letter of ["i", "q", "j", "k", "w"]) {
			expect(routeKey(letter, NONE, context()), letter).toBeUndefined();
		}
	});

	it("ignores the menu letter when a modifier is held", () => {
		// Ctrl-M is carriage return on a terminal and Ctrl-C already quits; neither
		// should quietly put a menu over the map.
		expect(routeKey("m", { ctrl: true }, context())).toBeUndefined();
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

	it("swallows the menu key, so a reply beginning with M does not open it", () => {
		// The bug this replaced: the side panel registered its own `useInput`, so
		// panel letters fired mid-sentence with no modal guard at all.
		for (const letter of ["m", "s"]) {
			expect(routeKey(letter, NONE, talking), letter).toBeUndefined();
		}
	});
});

describe("a question that cannot be undone", () => {
	const asking = (confirm: NonNullable<HudState["confirm"]>): RouteContext =>
		context({ hud: { tab: "inventory", inList: true, cursor: 0, detail: 0, zoom: 1, confirm } });

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

	it("swallows the menu and quit keys too", () => {
		// These would otherwise fire behind the card and look like the game had hung.
		expect(routeKey("m", NONE, context({ onCard: true }))).toBeUndefined();
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

describe("the menu over the map", () => {
	const onStrip = (tab: PanelTab = "quests"): HudState => initialHud(tab);
	const inList = (tab: PanelTab = "quests"): HudState => ({ ...initialHud(tab), inList: true });

	it("walks the tab strip on left and right", () => {
		expect(routeKey("", { rightArrow: true }, context({ hud: onStrip() }))).toEqual({
			t: "hud",
			action: { t: "StepTab", delta: 1 },
		});
		expect(routeKey("", { leftArrow: true }, context({ hud: onStrip() }))).toEqual({
			t: "hud",
			action: { t: "StepTab", delta: -1 },
		});
	});

	/*
	 * Down means two different things depending on where you are, and that is the
	 * point: on the strip it steps into the list, and once there it moves the
	 * cursor. Without the two states the first left press would move a cursor
	 * inside a list nobody had chosen yet, and the tab beside it would be
	 * unreachable.
	 */
	it("goes into the list on the first down, and moves the cursor after", () => {
		expect(routeKey("", { downArrow: true }, context({ hud: onStrip(), listCount: 4 }))).toEqual({
			t: "hud",
			action: { t: "EnterList" },
		});
		expect(routeKey("", { downArrow: true }, context({ hud: inList(), listCount: 4 }))).toEqual({
			t: "hud",
			action: { t: "MoveCursor", delta: 1, count: 4 },
		});
		expect(routeKey("", { upArrow: true }, context({ hud: inList(), listCount: 4 }))).toEqual({
			t: "hud",
			action: { t: "MoveCursor", delta: -1, count: 4 },
		});
	});

	// Nothing to move through yet, so up is not a cursor key on the strip.
	it("leaves up alone until the list has the arrow keys", () => {
		expect(routeKey("", { upArrow: true }, context({ hud: onStrip() }))).toBeUndefined();
	});

	// One press out, from wherever you are. Left and right are already the way
	// back to the strip, so a two-stage Esc would only cost a press.
	it("gives the map back on Esc, from the strip or from a list", () => {
		for (const hud of [onStrip(), inList()]) {
			expect(routeKey("", { escape: true }, context({ hud }))).toEqual({
				t: "hud",
				action: { t: "CloseMenu" },
			});
		}
	});

	it("closes on the same key that opened it", () => {
		expect(routeKey("m", NONE, context({ hud: onStrip() }))).toEqual({
			t: "hud",
			action: { t: "CloseMenu" },
		});
		expect(routeKey("", { tab: true }, context({ hud: inList() }))).toEqual({
			t: "hud",
			action: { t: "CloseMenu" },
		});
	});

	it("swallows space rather than acting on the world behind it", () => {
		// Pressing space while reading the inventory would otherwise search the
		// crate the player happens to be facing, off screen.
		expect(routeKey(" ", NONE, context({ hud: inList() }))).toBeUndefined();
	});

	it("offers a drop only when there is something to drop", () => {
		expect(routeKey("d", NONE, context({ hud: inList("inventory"), canDrop: true }))).toEqual({
			t: "askDrop",
		});
		expect(
			routeKey("d", NONE, context({ hud: inList("inventory"), canDrop: false })),
		).toBeUndefined();
	});

	it("swallows everything else, including the key that saves and quits", () => {
		expect(routeKey("s", NONE, context({ hud: inList() }))).toBeUndefined();
		expect(routeKey("j", NONE, context({ hud: inList() }))).toBeUndefined();
		expect(routeKey("", { return: true }, context({ hud: inList() }))).toBeUndefined();
	});

	it("comes second to a pending confirmation", () => {
		const asking: HudState = {
			...inList("inventory"),
			confirm: { action: { t: "drop", name: "Timber", quantity: 1 }, prompt: "Drop it?" },
		};
		expect(routeKey("y", NONE, context({ hud: asking }))).toEqual({
			t: "command",
			command: { t: "DropItem", name: "Timber", quantity: 1 },
		});
	});

	it("leaves zoom to the map, where there is something drawn in tiles", () => {
		// A key that silently does nothing is worse than one that is not bound: the
		// player cannot tell it apart from the game having stopped responding.
		expect(routeKey("+", NONE, context({ inDialogue: true }))).toBeUndefined();
		expect(routeKey("-", NONE, context({ hud: inList() }))).toBeUndefined();
		expect(routeKey("+", NONE, context({ onCard: true }))).toBeUndefined();
	});

	it("outranks a conversation, so a turn landing cannot steal the arrows", () => {
		// A dialogue turn resolves asynchronously and can arrive at any moment; taking
		// the arrow keys off somebody mid-read would be indistinguishable from a bug.
		expect(
			routeKey("", { downArrow: true }, context({ hud: inList(), inDialogue: true, listCount: 3 })),
		).toEqual({ t: "hud", action: { t: "MoveCursor", delta: 1, count: 3 } });
	});
});
