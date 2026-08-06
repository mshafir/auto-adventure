import { describe, expect, it } from "vitest";
import { arcOutline, orderedBeats } from "../../core/rules/arc.js";
import type { GameState } from "../../core/rules/state.js";
import type { SiteSpec } from "../../core/world/spec.js";
import { lowerArc } from "./author.js";
import type { ArcResponse, WorldShapeResponse } from "./schemas.js";
import { recipeFor } from "./shape.js";

/**
 * Turning what a model said into a story the engine will run.
 *
 * This is where a plausible answer becomes a playable one, and every failure here is
 * silent at runtime: a side errand that becomes a prerequisite stops the story dead, a
 * hidden item with no objective is an item nobody knows about, and a fork whose arms
 * gate each other is not a fork.
 */

const SITES = [0, 1, 2].map((i) => ({
	entry: { site: { id: 100 + i } },
	spec: {
		siteId: 100 + i,
		name: `Place ${i}`,
		npcs: [
			{ slot: 0, name: `A${i}` },
			{ slot: 1, name: `B${i}` },
		],
		// A roster, because where a hidden thing can go depends on what was actually asked
		// for here. The mill is the prominent one, so it is where anything unhousable lands.
		settlement: {
			name: `Place ${i}`,
			walled: false,
			structures: [
				{ kind: "mill", size: "large", importance: 5 },
				{ kind: "temple", size: "medium", importance: 3 },
			],
		},
	} as unknown as SiteSpec,
}));

function beat(over: Partial<ArcResponse["beats"][number]>): ArcResponse["beats"][number] {
	return {
		id: "b",
		siteIndex: 0,
		npcIndex: 0,
		summary: "",
		journal: null,
		quest: null,
		optional: false,
		partOf: null,
		branch: null,
		find: null,
		...over,
	};
}

function lower(beats: ArcResponse["beats"], endings: ArcResponse["endings"] = []) {
	const result = lowerArc({ title: "T", premise: "P", beats, endings }, SITES);
	if (!result) throw new Error("nothing lowered");
	return result;
}

describe("sequencing", () => {
	it("chains the main line so the story is a sequence", () => {
		const { arc } = lower([beat({ id: "one" }), beat({ id: "two" }), beat({ id: "three" })]);
		expect(orderedBeats(arc).map((b) => b.requires)).toEqual([[], ["arc:one"], ["arc:two"]]);
	});

	it("never lets a side errand become a prerequisite", () => {
		// The failure this exists for: if the beat after an optional one waits on it, the
		// story stops until the player finds something they were told was optional.
		//
		// The side errand still waits on the line *so far*, which is deliberate — it
		// opens when the player is in the neighbourhood rather than flooding the log
		// from the first turn. What matters is that nothing waits on *it*.
		const { arc } = lower([
			beat({ id: "one" }),
			beat({ id: "aside", optional: true }),
			beat({ id: "two" }),
		]);
		const byId = new Map(arc.beats.map((b) => [b.id, b]));
		expect(byId.get("aside")?.requires).toEqual(["arc:one"]);
		expect(byId.get("two")?.requires).toEqual(["arc:one"]);
	});

	it("leaves the story finishable with a side errand still open", () => {
		const { arc } = lower([beat({ id: "one" }), beat({ id: "aside", optional: true })]);
		const outline = arcOutline(arc, {
			flags: { "arc:one": true },
			quests: [],
			journal: [],
		} as unknown as GameState);
		expect(outline?.finished).toBe(true);
	});

	it("hangs a step off its parent rather than off the line", () => {
		const { arc } = lower([
			beat({ id: "job", quest: { name: "The job", description: "d", objective: null } }),
			beat({
				id: "step-a",
				partOf: "job",
				quest: { name: "A", description: "d", objective: null },
			}),
			beat({
				id: "step-b",
				partOf: "job",
				quest: { name: "B", description: "d", objective: null },
			}),
			beat({ id: "after" }),
		]);
		const byId = new Map(arc.beats.map((b) => [b.id, b]));
		expect(byId.get("step-a")?.requires).toEqual(["arc:job"]);
		expect(byId.get("step-b")?.requires).toEqual(["arc:job"]);
		// The line carries on from the parent, not from its last step.
		expect(byId.get("after")?.requires).toEqual(["arc:job"]);
	});

	it("makes the parent wait on every step it has", () => {
		// The mechanism, not the display: a `quest` objective is real state the engine
		// re-checks, so the parent closes the moment its last step does.
		const { arc } = lower([
			beat({ id: "job", quest: { name: "The job", description: "d", objective: null } }),
			beat({
				id: "step-a",
				partOf: "job",
				quest: { name: "A", description: "d", objective: null },
			}),
			beat({
				id: "step-b",
				partOf: "job",
				quest: { name: "B", description: "d", objective: null },
			}),
		]);
		const job = arc.beats.find((b) => b.id === "job");
		expect(job?.quest?.objectives).toEqual([
			{ kind: "quest", target: "step-a", done: false },
			{ kind: "quest", target: "step-b", done: false },
		]);
		expect(arc.beats.find((b) => b.id === "step-a")?.quest?.parentId).toBe("job");
	});

	it("ignores a step that names a parent it cannot have", () => {
		const { arc } = lower([
			beat({ id: "only", partOf: "nobody" }),
			beat({ id: "self", partOf: "self" }),
		]);
		expect(arc.beats.every((b) => b.quest?.parentId === undefined)).toBe(true);
	});
});

describe("forks", () => {
	it("keeps the arms out of each other's way", () => {
		// Two arms of a fork must not gate one another, or the "choice" is an order.
		const { arc } = lower([
			beat({ id: "before" }),
			beat({ id: "tell", branch: "who" }),
			beat({ id: "hide", branch: "who" }),
		]);
		const byId = new Map(arc.beats.map((b) => [b.id, b]));
		expect(byId.get("tell")?.requires).toEqual(["arc:before"]);
		expect(byId.get("hide")?.requires).toEqual(["arc:before"]);
		expect(byId.get("tell")?.branch).toBe("who");
	});

	it("keeps only the endings that name an arm it actually wrote", () => {
		const { arc } = lower(
			[beat({ id: "tell", branch: "who" }), beat({ id: "hide", branch: "who" })],
			[
				{ branch: "who", beat: "tell", title: "Told", heading: "After", body: "b" },
				{ branch: "who", beat: "invented", title: "?", heading: "After", body: "b" },
			],
		);
		expect(arc.endings).toHaveLength(1);
		expect(arc.endings?.[0]?.when).toEqual({ flag: "arc:tell" });
	});
});

describe("things hidden", () => {
	it("places the item and asks for it in the same breath", () => {
		// Both halves or neither. A placement with no objective is an item nobody was
		// told about; an objective with no placement is an item that is nowhere.
		const { arc, placements } = lower([
			beat({
				id: "the-seal",
				siteIndex: 1,
				find: { item: "Wax Seal", description: "Cracked across.", where: "temple" },
			}),
		]);
		expect(placements).toEqual([
			{
				id: "find:the-seal",
				at: { kind: "site", siteId: 101, structure: "temple" },
				item: { name: "Wax Seal", description: "Cracked across." },
				showDecor: true,
			},
		]);
		expect(arc.beats[0]?.quest?.objectives).toContainEqual({
			kind: "have",
			target: "Wax Seal",
			done: false,
		});
	});

	it("hides it somewhere the settlement actually has", () => {
		// The model picks `where` from a closed list of building kinds, which stops it
		// inventing a vault and does not stop it naming a barracks at a village that has
		// none. The placement then fails to resolve, the item is nowhere, and the beat
		// still asks the player to be carrying it — a step nobody can finish.
		const { placements } = lower([
			beat({
				id: "the-ledger",
				siteIndex: 2,
				find: { item: "Ledger", description: "Water-stained.", where: "barracks" },
			}),
		]);
		expect(placements[0]?.at).toMatchObject({ structure: "mill" });
	});

	it("leaves a hiding place the settlement does have alone", () => {
		const { placements } = lower([
			beat({
				id: "the-ledger",
				siteIndex: 2,
				find: { item: "Ledger", description: "Water-stained.", where: "temple" },
			}),
		]);
		expect(placements[0]?.at).toMatchObject({ structure: "temple" });
	});

	it("gives a beat with only a hidden thing an errand of its own", () => {
		const { arc } = lower([
			beat({ id: "x", find: { item: "Lead Weight", description: "d", where: "mill" } }),
		]);
		expect(arc.beats[0]?.quest?.name).toContain("Lead Weight");
	});
});

describe("what it refuses to build", () => {
	it("drops a beat pointing at a site or a person that is not there", () => {
		const { arc } = lower([
			beat({ id: "ok" }),
			beat({ id: "nowhere", siteIndex: 99 }),
			beat({ id: "nobody", npcIndex: 99 }),
		]);
		expect(arc.beats.map((b) => b.id)).toEqual(["ok"]);
	});

	it("drops a repeated id rather than letting two beats share a flag", () => {
		const { arc } = lower([beat({ id: "same" }), beat({ id: "same", siteIndex: 1 })]);
		expect(arc.beats).toHaveLength(1);
	});
});

describe("the shape of the world", () => {
	/** An unremarkable world, which every test here varies one setting of. */
	const shape = (overrides: Partial<WorldShapeResponse> = {}): WorldShapeResponse => ({
		sea: "ordinary",
		climate: "temperate",
		wet: "ordinary",
		settled: "ordinary",
		woods: "ordinary",
		strongholds: "none",
		caves: "none",
		harbours: "none",
		why: "",
		...overrides,
	});

	it("leaves an ordinary world exactly as it was", () => {
		expect(recipeFor(shape())).toBeUndefined();
	});

	it("raises the shore with the sea, so a coast still has a beach", () => {
		const recipe = recipeFor(shape({ sea: "drowned" }));
		expect(recipe?.climate?.seaLevel).toBeDefined();
		expect(recipe?.climate?.shoreLevel).toBeGreaterThan(recipe?.climate?.seaLevel as number);
	});

	it("scales the whole settlement mix rather than one kind of it", () => {
		const recipe = recipeFor(shape({ settled: "sparse" }));
		const weights = recipe?.sites?.weights ?? {};
		expect(weights.town).toBeCloseTo(0.9, 5);
		expect(weights.hamlet).toBeCloseTo(2.7, 5);
	});

	it("keeps every scatter density a probability", () => {
		const recipe = recipeFor(shape({ woods: "overgrown" }));
		for (const biome of Object.values(recipe?.biomes ?? {})) {
			expect(biome.scatterDensity).toBeLessThanOrEqual(1);
			expect(biome.scatterDensity).toBeGreaterThan(0);
		}
	});

	// The three kinds the default world has none of. Asking for them is the whole
	// difference between a generated map of farmland and one with somewhere to go.
	it("puts castles, caves and harbours on the map when they are asked for", () => {
		const weights =
			recipeFor(shape({ strongholds: "some", caves: "few", harbours: "few" }))?.sites?.weights ??
			{};
		expect(weights.castle).toBeGreaterThan(0);
		expect(weights.cave).toBeGreaterThan(0);
		expect(weights.docks).toBeGreaterThan(0);
		// "some" is more than "few", or the two words mean the same thing.
		expect(weights.castle).toBeGreaterThan(weights.cave as number);
	});

	it("leaves them off the map when they are not", () => {
		const weights = recipeFor(shape({ settled: "sparse" }))?.sites?.weights ?? {};
		expect(weights.castle).toBeUndefined();
		expect(weights.cave).toBeUndefined();
		expect(weights.docks).toBeUndefined();
	});

	// A cave mouth on a hillside nobody lives near is the normal case, so caves have to
	// reach the wild ladder too — the settled one only covers habitable ground.
	it("lets caves appear on ground too wild to live on", () => {
		const sites = recipeFor(shape({ caves: "some" }))?.sites;
		expect(sites?.wildWeights?.cave).toBeGreaterThan(0);
		expect(sites?.wildWeights?.castle).toBeUndefined();
	});

	// The settlement knob scales places people live. A crowded world means more hamlets,
	// not more castles, and conflating the two made "crowded" quietly mean "fortified".
	it("does not let the settlement density drag the landmarks with it", () => {
		const crowded = recipeFor(shape({ settled: "crowded", strongholds: "few" }));
		const sparse = recipeFor(shape({ settled: "sparse", strongholds: "few" }));
		expect(crowded?.sites?.weights?.castle).toBe(sparse?.sites?.weights?.castle);
	});
});
