import { describe, expect, it } from "vitest";
import { hashString } from "../rand/hash.js";
import { npcId } from "../world/spec.js";
import {
	arcProgress,
	beatCardId,
	beatEffects,
	beatIsOpen,
	beatNpcId,
	beatOpenedBy,
	orderedBeats,
	type ScenarioArc,
	type ScenarioBeat,
} from "./arc.js";
import { createInitialState, type GameState } from "./state.js";

const SITE = 1234;

function beat(overrides: Partial<ScenarioBeat> = {}): ScenarioBeat {
	return {
		id: "meet-the-clerk",
		order: 0,
		siteId: SITE,
		npcSlot: 0,
		requires: [],
		setsFlag: "arc:met-clerk",
		...overrides,
	};
}

function arc(beats: ScenarioBeat[]): ScenarioArc {
	return { title: "The Tithe", premise: "Somebody has to pay for the rope.", beats };
}

function stateWith(flags: Record<string, boolean> = {}): GameState {
	const base = createInitialState(
		{ id: "t", name: "t", seed: hashString("arc-test"), createdAt: "2026-01-01T00:00:00.000Z" },
		{ x: 0, y: 0 },
	);
	return { ...base, flags };
}

describe("beatNpcId", () => {
	it("matches the id the engine gives that person", () => {
		// The whole arc hangs off this agreeing with `npcId(siteId, slot)`; if it
		// drifted, every beat would be anchored to nobody.
		expect(beatNpcId(beat())).toBe(npcId(SITE, 0));
		expect(beatNpcId(beat({ npcSlot: 3 }))).toBe(npcId(SITE, 3));
	});
});

describe("orderedBeats", () => {
	it("sorts by order", () => {
		const sorted = orderedBeats(
			arc([beat({ id: "c", order: 2 }), beat({ id: "a", order: 0 }), beat({ id: "b", order: 1 })]),
		);
		expect(sorted.map((b) => b.id)).toEqual(["a", "b", "c"]);
	});

	it("breaks ties by id rather than by file order", () => {
		// An artifact is data from outside the program. Two beats sharing an order
		// would otherwise open in whatever sequence the JSON happened to list.
		const written = arc([beat({ id: "zeta", order: 1 }), beat({ id: "alpha", order: 1 })]);
		expect(orderedBeats(written).map((b) => b.id)).toEqual(["alpha", "zeta"]);
	});

	it("does not mutate the arc", () => {
		const original = arc([beat({ id: "b", order: 1 }), beat({ id: "a", order: 0 })]);
		orderedBeats(original);
		expect(original.beats.map((b) => b.id)).toEqual(["b", "a"]);
	});
});

describe("beatOpenedBy", () => {
	it("opens the first beat when its anchor is spoken to", () => {
		const found = beatOpenedBy(arc([beat()]), stateWith(), npcId(SITE, 0));
		expect(found?.id).toBe("meet-the-clerk");
	});

	it("ignores everyone else", () => {
		expect(beatOpenedBy(arc([beat()]), stateWith(), npcId(SITE, 1))).toBeUndefined();
		expect(beatOpenedBy(arc([beat()]), stateWith(), npcId(9999, 0))).toBeUndefined();
	});

	it("does not reopen a beat that has already happened", () => {
		const state = stateWith({ "arc:met-clerk": true });
		expect(beatOpenedBy(arc([beat()]), state, npcId(SITE, 0))).toBeUndefined();
	});

	it("holds a beat back until its requirement is met", () => {
		const gated = beat({
			id: "second",
			order: 1,
			requires: ["arc:met-clerk"],
			setsFlag: "arc:two",
		});
		expect(beatOpenedBy(arc([gated]), stateWith(), npcId(SITE, 0))).toBeUndefined();
		expect(
			beatOpenedBy(arc([gated]), stateWith({ "arc:met-clerk": true }), npcId(SITE, 0))?.id,
		).toBe("second");
	});

	it("requires every listed flag, not just one", () => {
		const gated = beat({ requires: ["a", "b"], setsFlag: "c" });
		expect(beatOpenedBy(arc([gated]), stateWith({ a: true }), npcId(SITE, 0))).toBeUndefined();
		expect(
			beatOpenedBy(arc([gated]), stateWith({ a: true, b: true }), npcId(SITE, 0)),
		).toBeDefined();
	});

	it("opens only the earliest eligible beat", () => {
		// One "hello" that dumps three quests into the journal reads as a bug and the
		// story loses its shape, so a conversation advances it by one step at most.
		const first = beat({ id: "first", order: 0, setsFlag: "f1" });
		const second = beat({ id: "second", order: 1, setsFlag: "f2" });
		expect(beatOpenedBy(arc([second, first]), stateWith(), npcId(SITE, 0))?.id).toBe("first");
	});

	it("is undefined when the world has no arc", () => {
		expect(beatOpenedBy(undefined, stateWith(), npcId(SITE, 0))).toBeUndefined();
	});
});

describe("beatEffects", () => {
	it("sets the flag last, so a half-applied beat is retried", () => {
		// Everything before the flag is idempotent; the flag is what marks the beat
		// done. Setting it first would skip a beat whose quest never landed.
		const effects = beatEffects(
			beat({
				quest: { id: "q1", name: "Find the rope", description: "It sank.", objectives: [] },
				journal: "The clerk mentioned a barge.",
			}),
		);
		expect(effects.map((e) => e.t)).toEqual(["CreateQuest", "RecordJournal", "SetFlag"]);
	});

	it("still sets the flag for a beat that is only a flag", () => {
		expect(beatEffects(beat()).map((e) => e.t)).toEqual(["SetFlag"]);
	});

	it("carries the quest through unchanged", () => {
		const quest = {
			id: "q1",
			name: "Find the rope",
			description: "It sank with the barge.",
			objectives: [{ kind: "have" as const, target: "Coil of rope", done: false }],
		};
		const created = beatEffects(beat({ quest })).find((e) => e.t === "CreateQuest");
		expect(created).toEqual({ t: "CreateQuest", ...quest });
	});
});

describe("beatIsOpen and arcProgress", () => {
	it("counts what has happened so far", () => {
		const beats = [
			beat({ id: "a", order: 0, setsFlag: "f1" }),
			beat({ id: "b", order: 1, setsFlag: "f2" }),
			beat({ id: "c", order: 2, setsFlag: "f3" }),
		];
		expect(arcProgress(arc(beats), stateWith())).toEqual({ opened: 0, total: 3 });
		expect(arcProgress(arc(beats), stateWith({ f1: true, f2: true }))).toEqual({
			opened: 2,
			total: 3,
		});
	});

	it("is zero of zero with no arc", () => {
		expect(arcProgress(undefined, stateWith())).toEqual({ opened: 0, total: 0 });
	});

	it("reads a beat as open once its flag is set", () => {
		expect(beatIsOpen(stateWith(), beat())).toBe(false);
		expect(beatIsOpen(stateWith({ "arc:met-clerk": true }), beat())).toBe(true);
	});
});

describe("a beat that raises a card", () => {
	const withCard = {
		id: "the-reveal",
		order: 0,
		siteId: 1,
		npcSlot: 0,
		requires: [],
		setsFlag: "arc:the-reveal",
		journal: "The ledger was in her hand.",
		card: {
			title: "The hand you know",
			sections: [{ heading: "The ledger", body: "Every figure is in your sister's hand." }],
		},
	} as const;

	it("names the card after the beat, so it cannot be shown twice", () => {
		expect(beatCardId(withCard)).toBe("beat:the-reveal");
		const card = beatEffects(withCard).find((effect) => effect.t === "ShowCard");
		expect(card?.t === "ShowCard" && card.card.id).toBe("beat:the-reveal");
	});

	it("raises it after the quest and the journal, so the world behind it is already true", () => {
		// The player reads the card and then looks at their log; the entry has to be
		// there already, or the card describes something that has not happened yet.
		const kinds = beatEffects(withCard).map((effect) => effect.t);
		expect(kinds.indexOf("RecordJournal")).toBeLessThan(kinds.indexOf("ShowCard"));
		expect(kinds.indexOf("ShowCard")).toBeLessThan(kinds.indexOf("SetFlag"));
	});

	it("raises nothing for a beat that did not ask for one", () => {
		const { card: _card, ...plain } = withCard;
		expect(beatEffects(plain).some((effect) => effect.t === "ShowCard")).toBe(false);
	});
});
