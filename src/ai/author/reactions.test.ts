import { describe, expect, it } from "vitest";
import type { ScenarioBeat } from "../../core/rules/arc.js";
import { type CastleOnStage, lowerReactions } from "./reactions.js";
import type { ReactionsResponse } from "./schemas.js";

/**
 * Turning a model's indices into flags and gates.
 *
 * The lowering is where the safety is. A trigger conditioned on a flag nothing sets, or a
 * gate standing at a site that is not there, are both invisible at runtime — the world
 * simply never reacts and the door simply never shuts — so the guarantee has to be that
 * they cannot be *expressed*, not that they get caught later.
 */

function beat(id: string, order: number, siteId = 1): ScenarioBeat {
	return { id, order, siteId, npcSlot: 0, requires: [], setsFlag: `arc:${id}` };
}

const BEATS = [beat("one", 0), beat("two", 1), beat("three", 2, 7)];
const CASTLES: CastleOnStage[] = [
	{ siteId: 7, name: "Kestrel Keep", description: "A keep on a spur of rock." },
];

function response(overrides: Partial<ReactionsResponse> = {}): ReactionsResponse {
	return { triggers: [], barriers: [], ...overrides };
}

const TRIGGER = {
	id: "the-news-travels",
	afterBeat: 1,
	journal: "Word of it reached the coast before I did.",
	cardTitle: null,
	cardBody: null,
};

describe("lowerReactions", () => {
	it("hangs a trigger off the flag the beat it names actually sets", () => {
		const { triggers } = lowerReactions(response({ triggers: [TRIGGER] }), BEATS, CASTLES);
		expect(triggers).toHaveLength(1);
		expect(triggers[0]?.when).toEqual({ flag: "arc:two" });
		expect(triggers[0]?.effects[0]).toMatchObject({ t: "RecordJournal" });
	});

	it("drops a trigger pointing past the end of the story", () => {
		const { triggers } = lowerReactions(
			response({ triggers: [{ ...TRIGGER, afterBeat: 9 }] }),
			BEATS,
			CASTLES,
		);
		expect(triggers).toEqual([]);
	});

	it("drops a trigger that does nothing", () => {
		// It would still register as a flag writer, so a condition on it would look
		// satisfiable while nothing the player could notice ever happened.
		const { triggers } = lowerReactions(
			response({ triggers: [{ ...TRIGGER, journal: null }] }),
			BEATS,
			CASTLES,
		);
		expect(triggers).toEqual([]);
	});

	it("gives a card its own section when one is written", () => {
		const { triggers } = lowerReactions(
			response({
				triggers: [{ ...TRIGGER, cardTitle: "The mill burns", cardBody: "Smoke to the north." }],
			}),
			BEATS,
			CASTLES,
		);
		expect(triggers[0]?.effects).toHaveLength(2);
		expect(triggers[0]?.effects[1]).toMatchObject({ t: "ShowCard" });
	});

	it("refuses two things sharing an id", () => {
		const { triggers } = lowerReactions(
			response({ triggers: [TRIGGER, { ...TRIGGER, journal: "Again." }] }),
			BEATS,
			CASTLES,
		);
		expect(triggers).toHaveLength(1);
	});

	it("bars a castle gate by naming the site, never a coordinate", () => {
		const { barriers } = lowerReactions(
			response({
				barriers: [
					{
						id: "the-keep-gate",
						castle: 0,
						opensAfterBeat: 0,
						lockedText: "The gate is shut and the wicket is barred.",
						opensText: null,
					},
				],
			}),
			BEATS,
			CASTLES,
		);
		expect(barriers).toHaveLength(1);
		expect(barriers[0]?.tiles).toEqual({ siteId: 7, at: "gate" });
		expect(barriers[0]?.opensWhen).toEqual({ flag: "arc:one" });
	});

	it("refuses a gate whose key is behind it", () => {
		// Beat three happens at site 7, which is the castle being barred: the player would
		// have to get in to be allowed in.
		const { barriers } = lowerReactions(
			response({
				barriers: [
					{
						id: "the-keep-gate",
						castle: 0,
						opensAfterBeat: 2,
						lockedText: "Shut.",
						opensText: null,
					},
				],
			}),
			BEATS,
			CASTLES,
		);
		expect(barriers).toEqual([]);
	});

	it("writes no gates in a world that has none", () => {
		const { barriers } = lowerReactions(
			response({
				barriers: [
					{ id: "nowhere", castle: 0, opensAfterBeat: 0, lockedText: "Shut.", opensText: null },
				],
			}),
			BEATS,
			[],
		);
		expect(barriers).toEqual([]);
	});
});
