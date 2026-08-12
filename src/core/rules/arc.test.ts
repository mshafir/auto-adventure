import { describe, expect, it } from "vitest";
import { hashString } from "../rand/hash.js";
import { npcId } from "../world/spec.js";
import {
	ARC_DONE_FLAG,
	arcEndEffects,
	arcOutline,
	arcProgress,
	beatCardId,
	beatEffects,
	beatIsOpen,
	beatLabel,
	beatNpcId,
	beatOpenedBy,
	beatsOpenedByState,
	branchKey,
	branchTaken,
	mainLineBeats,
	orderedBeats,
	type ScenarioArc,
	type ScenarioBeat,
} from "./arc.js";
import { ENDING_CARD_ID, forkedEndingCardId, pickEnding } from "./ending.js";
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

/** A branch flag holds the id of the arm taken, so this is not boolean-only. */
function stateWith(flags: Record<string, string | number | boolean> = {}): GameState {
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

describe("mainLineBeats", () => {
	it("leaves out the side errands", () => {
		const story = arc([
			beat({ id: "a", order: 1 }),
			beat({ id: "side", order: 2, optional: true }),
			beat({ id: "b", order: 3 }),
		]);
		expect(mainLineBeats(story).map((entry) => entry.id)).toEqual(["a", "b"]);
	});

	it("keeps both arms of a fork until the story says which was taken", () => {
		// Without state there is no answer to "which arm" — and guessing would make the
		// repair pass treat one arm of every fork as deletable side content.
		const story = arc([
			beat({ id: "left", order: 1, branch: "which" }),
			beat({ id: "right", order: 2, branch: "which" }),
		]);
		expect(mainLineBeats(story).map((entry) => entry.id)).toEqual(["left", "right"]);
	});

	it("drops the arm the player did not take, once it knows", () => {
		const story = arc([
			beat({ id: "left", order: 1, branch: "which" }),
			beat({ id: "right", order: 2, branch: "which" }),
		]);
		expect(
			mainLineBeats(story, stateWith({ [branchKey("which")]: "left" })).map((entry) => entry.id),
		).toEqual(["left"]);
	});

	it("is what the outline counts, rather than a second opinion about it", () => {
		// The whole reason this is exported: `arcOutline` computed the set inline, and a repair
		// pass with its own idea of which beats are sacred would disagree with the pane the
		// player is reading.
		//
		// Asserted against a number worked out by hand rather than against `mainLineBeats`
		// itself, because `remaining` is now derived from this function — comparing the two
		// would be a tautology that passed however wrong both were.
		//
		// The side errand is deliberately *unopened*, which took two attempts to get right. An
		// open one subtracts from both halves of `mainLine.length - mainOpened.length`, so the
		// answer comes out the same whether or not the outline excludes it, and the test could
		// not fail. Unopened, it only inflates the first half: two main beats and nothing done
		// is 2, and an outline that counted the errand would say 3.
		const story = arc([
			beat({ id: "a", order: 1, setsFlag: "arc:a" }),
			beat({ id: "b", order: 2, setsFlag: "arc:b" }),
			beat({ id: "side", order: 3, optional: true, setsFlag: "arc:side" }),
		]);
		expect(arcOutline(story, stateWith({}))?.remaining).toBe(2);
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

	it("carries the quest through, tagged with where it was given", () => {
		// The site is added rather than carried: a beat knows which settlement it happens
		// at and `Quest.siteId` is what puts a bearing on the map, so leaving it off made
		// every errand a story handed out the one kind the player could not navigate back
		// to. Nothing else about the quest is touched.
		const quest = {
			id: "q1",
			name: "Find the rope",
			description: "It sank with the barge.",
			objectives: [{ kind: "have" as const, target: "Coil of rope", done: false }],
		};
		const created = beatEffects(beat({ quest })).find((e) => e.t === "CreateQuest");
		expect(created).toEqual({ t: "CreateQuest", ...quest, siteId: SITE });
	});

	it("records which arm of a fork was taken, before the beat's own flag", () => {
		// Before, so a fork half-applied after a partial save is already closed to its
		// siblings when the retry comes round.
		const effects = beatEffects(beat({ id: "burn-it", branch: "the-mill", setsFlag: "arc:burnt" }));
		expect(effects).toEqual([
			{ t: "SetFlag", key: branchKey("the-mill"), value: "burn-it" },
			{ t: "SetFlag", key: "arc:burnt", value: true },
		]);
	});

	it("carries a sub-errand's parent through", () => {
		const created = beatEffects(
			beat({
				quest: {
					id: "q-child",
					name: "The first tally",
					description: "",
					objectives: [],
					parentId: "q-parent",
				},
			}),
		).find((e) => e.t === "CreateQuest");
		expect(created).toMatchObject({ parentId: "q-parent" });
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

describe("the story so far", () => {
	function arcOf(): ScenarioArc {
		return {
			title: "The Hollow Tithe",
			premise: "Your sister took the badge and stopped writing.",
			beats: [
				{
					id: "the-short-tally",
					order: 0,
					siteId: 1,
					npcSlot: 0,
					requires: [],
					setsFlag: "arc:the-short-tally",
					journal: "Ilse says the tally has been short since the levy doubled.",
					quest: {
						id: "the-short-tally",
						name: "Take the tally to Stonewait",
						description: "…",
						objectives: [{ kind: "reach", target: "Stonewait", done: false }],
					},
				},
				{
					id: "the-second-weight",
					order: 1,
					siteId: 2,
					npcSlot: 0,
					requires: ["arc:the-short-tally"],
					setsFlag: "arc:the-second-weight",
					journal: "Cull signs two tallies and only one is true.",
				},
				{
					id: "the-crown-yard",
					order: 2,
					siteId: 3,
					npcSlot: 0,
					requires: ["arc:the-second-weight"],
					setsFlag: "arc:the-crown-yard",
				},
			],
		};
	}

	function stateWith(overrides: Partial<GameState> = {}): GameState {
		const base = createInitialState(
			{ id: "t", name: "t", seed: 1, createdAt: "2026-01-01T00:00:00.000Z" },
			{ x: 0, y: 0 },
		);
		return { ...base, arc: arcOf(), ...overrides };
	}

	it("says nothing at all for a world with no story", () => {
		expect(arcOutline(undefined, stateWith())).toBeUndefined();
	});

	it("shows the title and premise before anything has happened", () => {
		const outline = arcOutline(arcOf(), stateWith());
		expect(outline?.title).toBe("The Hollow Tithe");
		expect(outline?.premise).toContain("stopped writing");
		expect(outline?.steps).toEqual([]);
		expect(outline?.remaining).toBe(3);
	});

	it("lists a beat once it has been reached, and counts the rest without naming them", () => {
		// Naming the beats ahead would hand the player the plot in the first minute; the
		// next step is already an open errand with a bearing on the map.
		const outline = arcOutline(arcOf(), stateWith({ flags: { "arc:the-short-tally": true } }));
		expect(outline?.steps.map((step) => step.label)).toEqual(["Take the tally to Stonewait"]);
		expect(outline?.remaining).toBe(2);
	});

	it("does not tick a step whose errand is still open", () => {
		// The bug this pins was visible on screen: the outline showed a step complete
		// while that very errand sat open in the list underneath it.
		const outline = arcOutline(arcOf(), stateWith({ flags: { "arc:the-short-tally": true } }));
		expect(outline?.steps[0]?.complete).toBe(false);
	});

	it("ticks it once the errand is finished", () => {
		const outline = arcOutline(
			arcOf(),
			stateWith({
				flags: { "arc:the-short-tally": true },
				quests: [
					{
						id: "the-short-tally",
						name: "Take the tally to Stonewait",
						description: "…",
						objectives: [{ kind: "reach", target: "Stonewait", done: true }],
						progress: [],
						completed: true,
					},
				],
			}),
		);
		expect(outline?.steps[0]?.complete).toBe(true);
	});

	it("ticks a beat that never carried an errand, since nothing is outstanding", () => {
		const outline = arcOutline(
			arcOf(),
			stateWith({ flags: { "arc:the-short-tally": true, "arc:the-second-weight": true } }),
		);
		expect(outline?.steps[1]).toEqual({ label: "The second weight", complete: true });
	});

	it("labels a beat with no quest from its own id", () => {
		expect(beatLabel(arcOf().beats[1] as ScenarioBeat)).toBe("The second weight");
	});

	it("reads its clues out of the journal, by beat, rather than storing them twice", () => {
		// Matching on source and not on prose: an author editing a line must not orphan
		// the clue an existing save already recorded.
		const outline = arcOutline(
			arcOf(),
			stateWith({
				flags: { "arc:the-short-tally": true },
				journal: [
					{ tick: 1, kind: "place", text: "Arrived in Bracken Cross." },
					{
						tick: 2,
						kind: "event",
						text: "Ilse says the tally has been short since the levy doubled.",
						source: "arc:the-short-tally",
					},
					{ tick: 3, kind: "event", text: "New errand: something else.", source: "other" },
				],
			}),
		);
		expect(outline?.clues).toEqual(["Ilse says the tally has been short since the levy doubled."]);
	});

	it("does not show a clue for a beat that has not happened", () => {
		const outline = arcOutline(
			arcOf(),
			stateWith({
				journal: [{ tick: 2, kind: "event", text: "A thing.", source: "arc:the-second-weight" }],
			}),
		);
		expect(outline?.clues).toEqual([]);
	});
});

describe("running out of story", () => {
	const arc: ScenarioArc = {
		title: "The Tithe",
		premise: "Somebody has to pay for the rope.",
		beats: [
			{
				id: "a",
				order: 0,
				siteId: 1,
				npcSlot: 0,
				requires: [],
				setsFlag: "arc:a",
				quest: {
					id: "rope",
					name: "Rope",
					description: "d",
					objectives: [{ kind: "have", target: "Rope", done: false }],
				},
			},
			{ id: "b", order: 1, siteId: 1, npcSlot: 0, requires: ["arc:a"], setsFlag: "arc:b" },
		],
	};

	function state(overrides: Partial<GameState> = {}): GameState {
		const base = createInitialState(
			{ id: "t", name: "t", seed: 1, createdAt: "2026-01-01T00:00:00.000Z" },
			{ x: 0, y: 0 },
		);
		return { ...base, arc, ...overrides };
	}

	const outline = (s: GameState) => arcOutline(arc, s);

	it("is not finished while a beat is unreached", () => {
		const s = state({ flags: { "arc:a": true } });
		expect(outline(s)?.finished).toBe(false);
		expect(arcEndEffects(arc, s, outline(s))).toEqual([]);
	});

	it("is not finished while an errand it handed out is open", () => {
		// The distinction the pane already draws with [~]: reaching the last beat is not
		// the same as having nothing left to do.
		const s = state({ flags: { "arc:a": true, "arc:b": true } });
		expect(outline(s)?.finished).toBe(false);
		expect(arcEndEffects(arc, s, outline(s))).toEqual([]);
	});

	function done(): GameState {
		return state({
			flags: { "arc:a": true, "arc:b": true },
			quests: [
				{
					id: "rope",
					name: "Rope",
					description: "d",
					objectives: [{ kind: "have", target: "Rope", done: true }],
					progress: [],
					completed: true,
				},
			],
		});
	}

	it("is finished once every beat is reached and every errand closed", () => {
		expect(outline(done())?.finished).toBe(true);
	});

	it("journals it, raises the ending, and marks itself done — in that order", () => {
		// The flag last, so a partially applied set is retried rather than skipped, the
		// same rule `beatEffects` follows.
		const effects = arcEndEffects(arc, done(), outline(done()));
		expect(effects.map((effect) => effect.t)).toEqual(["RecordJournal", "ShowCard", "SetFlag"]);
	});

	it("says nothing a second time", () => {
		const already = { ...done(), flags: { ...done().flags, [ARC_DONE_FLAG]: true } };
		expect(arcEndEffects(arc, already, outline(already))).toEqual([]);
	});

	it("says nothing for a world with no story, or a story with no beats", () => {
		expect(arcEndEffects(undefined, done(), undefined)).toEqual([]);
		const empty: ScenarioArc = { title: "t", premise: "p", beats: [] };
		const s = state({ arc: empty });
		expect(arcEndEffects(empty, s, arcOutline(empty, s))).toEqual([]);
	});
});

describe("forks", () => {
	/** Two arms of one decision, both openable by the same person from the start. */
	function forked(): ScenarioBeat[] {
		return [
			beat({ id: "burn-it", order: 1, branch: "the-mill", setsFlag: "arc:burnt" }),
			beat({ id: "spare-it", order: 1, branch: "the-mill", setsFlag: "arc:spared" }),
		];
	}

	it("offers either arm before the choice is made", () => {
		const beats = forked();
		// The earliest eligible wins a single conversation, which is `beatOpenedBy`'s
		// existing rule; what matters here is that both are *eligible*.
		const opened = beatOpenedBy(arc(beats), stateWith(), beatNpcId(beats[0] as ScenarioBeat));
		expect(opened?.id).toBe("burn-it");
	});

	it("bars the sibling for good once one arm is taken", () => {
		const beats = forked();
		const decided = stateWith({ "arc:burnt": true, [branchKey("the-mill")]: "burn-it" });
		// The taken arm is already open, so nothing more opens; the sibling is refused
		// even though its own requirement — nothing — is still satisfied.
		expect(beatOpenedBy(arc(beats), decided, beatNpcId(beats[0] as ScenarioBeat))).toBeUndefined();
	});

	it("does not count the arm not taken as story still to come", () => {
		// The failure this prevents: `remaining` stuck at 1 forever, because the barred
		// arm can never open, so the story reads as unfinished after it has finished.
		const beats = forked();
		const decided = stateWith({ "arc:burnt": true, [branchKey("the-mill")]: "burn-it" });
		const outline = arcOutline(arc(beats), decided);
		expect(outline?.remaining).toBe(0);
		expect(outline?.finished).toBe(true);
	});

	it("reads back which way it went", () => {
		const decided = stateWith({ [branchKey("the-mill")]: "burn-it" });
		expect(branchTaken(decided, "the-mill")).toBe("burn-it");
		expect(branchTaken(stateWith(), "the-mill")).toBeUndefined();
	});
});

describe("side errands", () => {
	it("do not hold the main story open", () => {
		const beats = [
			beat({ id: "main", order: 0, setsFlag: "arc:main" }),
			beat({ id: "aside", order: 1, optional: true, setsFlag: "arc:aside" }),
		];
		const outline = arcOutline(arc(beats), stateWith({ "arc:main": true }));
		// One of two beats opened, and the story is nevertheless told.
		expect(outline?.remaining).toBe(0);
		expect(outline?.finished).toBe(true);
	});

	it("are still listed, and marked as optional", () => {
		const beats = [
			beat({ id: "main", order: 0, setsFlag: "arc:main" }),
			beat({ id: "aside", order: 1, optional: true, setsFlag: "arc:aside" }),
		];
		const outline = arcOutline(arc(beats), stateWith({ "arc:main": true, "arc:aside": true }));
		expect(outline?.steps).toHaveLength(2);
		expect(outline?.steps[1]?.optional).toBe(true);
		expect(outline?.steps[0]?.optional).toBeUndefined();
	});

	it("do not hold the story open through an unfinished errand either", () => {
		// The subtler half: an optional beat's *quest* must not count toward `finished`,
		// or a side errand nobody wanted would suppress the ending indefinitely.
		const beats = [
			beat({ id: "main", order: 0, setsFlag: "arc:main" }),
			beat({
				id: "aside",
				order: 1,
				optional: true,
				setsFlag: "arc:aside",
				quest: { id: "q-aside", name: "A favour", description: "", objectives: [] },
			}),
		];
		const state = stateWith({ "arc:main": true, "arc:aside": true });
		expect(arcOutline(arc(beats), state)?.finished).toBe(true);
	});
});

describe("beats that open on their own", () => {
	it("open when their condition becomes true", () => {
		const beats = [beat({ id: "the-flood", opensOn: { flag: "mill:flooded" } })];
		expect(beatsOpenedByState(arc(beats), stateWith())).toEqual([]);
		expect(
			beatsOpenedByState(arc(beats), stateWith({ "mill:flooded": true })).map((b) => b.id),
		).toEqual(["the-flood"]);
	});

	it("do not reopen once open", () => {
		const beats = [
			beat({ id: "the-flood", setsFlag: "arc:flood", opensOn: { flag: "mill:flooded" } }),
		];
		const after = stateWith({ "mill:flooded": true, "arc:flood": true });
		expect(beatsOpenedByState(arc(beats), after)).toEqual([]);
	});

	it("still respect their own requirement", () => {
		const beats = [
			beat({ id: "the-flood", requires: ["arc:warned"], opensOn: { flag: "mill:flooded" } }),
		];
		expect(beatsOpenedByState(arc(beats), stateWith({ "mill:flooded": true }))).toEqual([]);
	});

	it("leave beats with no condition to a conversation", () => {
		// A beat with no `opensOn` is opened by talking to somebody, and must not start
		// firing on its own the moment its requirement is met.
		const beats = [beat({ id: "meet-the-clerk" })];
		expect(beatsOpenedByState(arc(beats), stateWith())).toEqual([]);
	});
});

describe("forked endings", () => {
	function endings(): ScenarioArc {
		return {
			...arc([beat({ id: "only", setsFlag: "arc:only" })]),
			endings: [
				{
					id: "grim",
					when: { flag: branchKey("the-mill"), equals: "burn-it" },
					title: "Ash and a bill",
					sections: [{ heading: "After", body: "Nobody rebuilt it." }],
				},
				{
					id: "quiet",
					title: "The wheel turns",
					sections: [{ heading: "After", body: "It went on grinding." }],
				},
			],
		};
	}

	it("picks the outcome the player earned", () => {
		const state = stateWith({ "arc:only": true, [branchKey("the-mill")]: "burn-it" });
		expect(pickEnding(endings(), state)?.id).toBe("grim");
	});

	it("falls through to the entry with no condition", () => {
		// Which is how an author writes a catch-all: last in the list, unconditional.
		const state = stateWith({ "arc:only": true, [branchKey("the-mill")]: "spare-it" });
		expect(pickEnding(endings(), state)?.id).toBe("quiet");
	});

	it("shows the chosen outcome as the ending card", () => {
		const state = stateWith({ "arc:only": true, [branchKey("the-mill")]: "burn-it" });
		const outline = arcOutline(endings(), state);
		const effects = arcEndEffects(endings(), state, outline);
		const card = effects.find((e) => e.t === "ShowCard");
		expect(card?.t === "ShowCard" && card.card.title).toBe("Ash and a bill");
		// Its own id, so the read-once flag is per outcome rather than shared.
		expect(card?.t === "ShowCard" && card.card.id).toBe(forkedEndingCardId("grim"));
	});

	it("leaves an arc with no endings list exactly as it was", () => {
		const plain = arc([beat({ id: "only", setsFlag: "arc:only" })]);
		const state = stateWith({ "arc:only": true });
		expect(pickEnding(plain, state)).toBeUndefined();
		const card = arcEndEffects(plain, state, arcOutline(plain, state)).find(
			(e) => e.t === "ShowCard",
		);
		expect(card?.t === "ShowCard" && card.card.id).toBe(ENDING_CARD_ID);
	});
});
