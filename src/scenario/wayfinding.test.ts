import { describe, expect, it } from "vitest";
import { demoJourneyArtifact } from "../../test/fixtures/scenario.js";
import type { ScenarioArtifact } from "./artifact.js";
import { repairArtifact } from "./repair.js";
import { signpostsFor } from "./signposts.js";
import { buildPassability, siteIndex, validateArtifact } from "./validate.js";

/**
 * Whether the story says where to go, and what happens when it does not.
 *
 * The fault a playthrough found and no check could see. Every beat opened, every errand
 * landed in the log, every flag was written and read — and the player finished a scene, read
 * "the clerk who countersigned it has not been seen since", and had six towns to choose
 * between. Nothing was broken. It was simply unfollowable.
 *
 * So there are three tests' worth of claim here and they are all one claim: the check fires
 * when nothing names the next place, it goes quiet the moment *anything* does, and the free
 * repair makes it go quiet without a model being asked.
 */
const SLOW = { timeout: 120_000 };

const BASE = demoJourneyArtifact();
const GRID = buildPassability(BASE);
const SITES = siteIndex(BASE);

/** The wayfinding complaints only, since these worlds have other rough edges. */
function lost(artifact: ScenarioArtifact): string[] {
	return validateArtifact(artifact)
		.filter((finding) => finding.message.includes("is expected at"))
		.map((finding) => finding.message);
}

describe("a story that does not say where to go", SLOW, () => {
	it("is reported, naming the place the player was supposed to reach", () => {
		const complaints = lost(BASE);
		expect(complaints.length).toBe(1);
		expect(complaints[0]).toContain("Aldermoor");
		expect(complaints[0]).toContain("the-tally");
	});

	/*
	 * The finding carries the conversation it is about, which is what lets the polish pass
	 * hand it back to a rewrite of that scene without reading the sentence. Every repair in
	 * this codebase re-derives its own condition for that reason; this keeps the rule while
	 * making the findings addressable.
	 */
	it("says whose scene it is, so a rewrite can be aimed at it", () => {
		const finding = validateArtifact(BASE).find((each) => each.message.includes("is expected at"));
		const beat = BASE.arc?.beats[0];
		expect(finding?.tree).toBe(`npc:${beat?.siteId}:${beat?.npcSlot}`);
	});

	it("goes quiet when the journal names the place", () => {
		const named = withJournal("Ilse says to ask for the clerk at Aldermoor.");
		expect(lost(named)).toEqual([]);
	});

	it("goes quiet when a character says it out loud instead", () => {
		const beat = BASE.arc?.beats[0];
		const spoken: ScenarioArtifact = {
			...BASE,
			trees: {
				[`npc:${beat?.siteId}:${beat?.npcSlot}`]: {
					npcId: `npc:${beat?.siteId}:${beat?.npcSlot}`,
					entry: ["hello"],
					nodes: {
						hello: {
							id: "hello",
							speech: "Go up to Aldermoor and ask for Lune Harrowgate. She countersigned it.",
							choices: [],
						},
					},
				},
			},
		};
		expect(lost(spoken)).toEqual([]);
	});

	/*
	 * The third honest answer, and the one that needs no prose at all: a board on the road out
	 * pointing at the place. The check accepts it because the player standing at the board is
	 * as well informed as the player who was told a name.
	 */
	it("goes quiet when a signpost points there", () => {
		const posted = signpostsFor(BASE, GRID, SITES);
		expect(posted.signs.length).toBeGreaterThan(0);
		expect(lost({ ...BASE, signs: posted.signs })).toEqual([]);
	});

	/*
	 * The bug the shipped Gawain scenario found. Asked only about the beat in hand, this fired
	 * at the moment Gawain keeps the girdle: nothing in that scene names the Green Chapel, and
	 * he was told to come to it in a year and a day at the very start — which is exactly how
	 * that story works. A player is not told twice, and a check that demands it be said again
	 * is a check that rewards padding.
	 */
	it("goes quiet when an earlier scene named it, since the player was already told", () => {
		const arc = BASE.arc as NonNullable<ScenarioArtifact["arc"]>;
		const withEarly: ScenarioArtifact = {
			...BASE,
			arc: {
				...arc,
				beats: [
					{
						...(arc.beats[0] as NonNullable<(typeof arc.beats)[number]>),
						journal: "Ilse says the clerk went up to Aldermoor and never came back.",
					},
					...arc.beats.slice(1),
				],
			},
		};
		expect(lost(withEarly)).toEqual([]);
	});

	it("goes quiet when the premise on the opening card names it", () => {
		const arc = BASE.arc as NonNullable<ScenarioArtifact["arc"]>;
		const premised: ScenarioArtifact = {
			...BASE,
			arc: { ...arc, premise: "A barge sank, and the answer is somewhere in Aldermoor." },
		};
		expect(lost(premised)).toEqual([]);
	});

	/*
	 * And never on the strength of prose the player has not reached. The scene *after* the one
	 * they are standing in naming the place is no help at all — that is the whole fault.
	 */
	it("still fires when only the scene they have not reached yet names it", () => {
		const arc = BASE.arc as NonNullable<ScenarioArtifact["arc"]>;
		const late: ScenarioArtifact = {
			...BASE,
			arc: {
				...arc,
				beats: [
					arc.beats[0] as NonNullable<(typeof arc.beats)[number]>,
					{
						...(arc.beats[1] as NonNullable<(typeof arc.beats)[number]>),
						journal: "Aldermoor keeps its own books, and they do not agree with Thornwick's.",
					},
				],
			},
		};
		expect(lost(late).length).toBe(1);
	});

	it("says nothing about a side errand, which the player goes looking for by choice", () => {
		const arc = BASE.arc;
		const beats = (arc?.beats ?? []).map((beat, index) =>
			index === 1 ? { ...beat, optional: true } : beat,
		);
		expect(lost({ ...BASE, arc: { ...(arc as NonNullable<typeof arc>), beats } })).toEqual([]);
	});

	it("says nothing when the next scene is in the same town", () => {
		const arc = BASE.arc;
		const first = arc?.beats[0]?.siteId as number;
		const beats = (arc?.beats ?? []).map((beat) => ({ ...beat, siteId: first }));
		expect(lost({ ...BASE, arc: { ...(arc as NonNullable<typeof arc>), beats } })).toEqual([]);
	});
});

describe("the repair that says it", SLOW, () => {
	it("appends a plain direction to the journal and to the errand", () => {
		const { artifact, repairs } = repairArtifact(BASE);
		expect(repairs.some((repair) => repair.includes("did not say where to go next"))).toBe(true);
		const journal = artifact.arc?.beats[0]?.journal ?? "";
		expect(journal).toContain("Go to Aldermoor and ask for Lune Harrowgate.");
		// The story it was already telling is still there. This is the direction, not a
		// replacement for the scene.
		expect(journal).toContain("signed for rope that never came ashore");
	});

	it("removes the finding it was written for, and adds none", () => {
		const before = validateArtifact(BASE).map((finding) => finding.message);
		const { artifact } = repairArtifact(BASE);
		const after = validateArtifact(artifact).map((finding) => finding.message);
		expect(lost(artifact)).toEqual([]);
		expect(after.filter((message) => !before.includes(message))).toEqual([]);
	});

	/*
	 * Signposts are ignored when deciding whether to *say* it, deliberately. A board on the
	 * road out answers "which way" and answers nothing at all to somebody reading their errand
	 * log two towns later, so a world with both is better than a world with one — and since
	 * the check accepts either, saying it where a board exists costs a sentence and removes no
	 * finding, which is the right way round for a repair that is free.
	 */
	it("says it even where a board already points there, since the two are read elsewhere", () => {
		const posted = signpostsFor(BASE, GRID, SITES);
		const { artifact } = repairArtifact({ ...BASE, signs: posted.signs });
		expect(artifact.arc?.beats[0]?.journal).toContain("Go to Aldermoor");
	});

	it("leaves a beat that already says it exactly as it was", () => {
		const named = withJournal("Ilse says to ask for the clerk at Aldermoor.");
		const { artifact, repairs } = repairArtifact(named);
		expect(repairs.some((repair) => repair.includes("where to go next"))).toBe(false);
		expect(artifact.arc?.beats[0]?.journal).toBe("Ilse says to ask for the clerk at Aldermoor.");
	});

	/*
	 * Two runs of the repair must not stack two directions on one journal line. It is run
	 * twice in practice — `repairUntilClean` goes round up to twice — and the second round
	 * re-derives its own condition, which the first round has already satisfied.
	 */
	it("does not say it twice when run again", () => {
		const once = repairArtifact(BASE).artifact;
		const twice = repairArtifact(once).artifact;
		const journal = twice.arc?.beats[0]?.journal ?? "";
		expect(journal.match(/Go to Aldermoor/g)?.length).toBe(1);
	});
});

function withJournal(journal: string): ScenarioArtifact {
	const arc = BASE.arc as NonNullable<ScenarioArtifact["arc"]>;
	const beats = arc.beats.map((beat, index) => (index === 0 ? { ...beat, journal } : beat));
	return { ...BASE, arc: { ...arc, beats } };
}
