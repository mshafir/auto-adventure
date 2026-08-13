import { describe, expect, it } from "vitest";
import { arcOutline, orderedBeats, type ScenarioArc } from "../../core/rules/arc.js";
import type { GameState } from "../../core/rules/state.js";
import type { SiteSpec } from "../../core/world/spec.js";
import type { ScenarioArtifact } from "../../scenario/artifact.js";
import { lowerArc, whatStopsIt } from "./author.js";
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

	it("does not let one arm be a step of the other", () => {
		// Shipped in a generated world and it stopped the story dead at the choice: the
		// model made both arms of a fork `partOf` each other's sibling, so whichever the
		// player picked waited on a flag only the arm they did *not* pick would set.
		// Both arms then reported "can never open", which is a fork with no way through.
		const { arc } = lower([
			beat({ id: "before" }),
			beat({ id: "tell", branch: "who" }),
			beat({ id: "hide", branch: "who", partOf: "tell" }),
		]);
		const byId = new Map(arc.beats.map((b) => [b.id, b]));
		expect(byId.get("hide")?.requires).toEqual(["arc:before"]);
		expect(byId.get("hide")?.quest?.parentId).toBeUndefined();
	});

	it("still lets a step of an arm be a step of that arm", () => {
		// The rule is about *siblings*, not about arms generally. Something that genuinely
		// follows on from one arm is a legitimate shape and must survive.
		const { arc } = lower([
			beat({ id: "tell", branch: "who" }),
			beat({ id: "after-telling", partOf: "tell" }),
		]);
		const byId = new Map(arc.beats.map((b) => [b.id, b]));
		expect(byId.get("after-telling")?.requires).toEqual(["arc:tell"]);
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

/*
 * A plotted story with no title on it.
 *
 * The most expensive thing in the pipeline is the beats, and until this the whole answer was
 * thrown away when the two prose fields beside them were missing. Both Anthropic rows in the
 * catalogue do exactly that — beats, no title, no premise, no endings, three arcs out of three
 * — which cost two live runs their entire story and reported it as one line saying no story
 * could be plotted.
 */
describe("a story the model did not name", () => {
	it("takes the world's name and premise rather than throwing the beats away", () => {
		const result = lowerArc(
			{ title: null, premise: null, beats: [beat({ id: "one" })], endings: null },
			SITES,
			{ title: "The Reed Tithe", premise: "The marsh owes more than it can cut." },
		);
		expect(result?.arc.beats).toHaveLength(1);
		expect(result?.arc.title).toBe("The Reed Tithe");
		expect(result?.arc.premise).toBe("The marsh owes more than it can cut.");
	});

	it("still has a title when there is no world to borrow one from", () => {
		const result = lowerArc(
			{ title: null, premise: null, beats: [beat({ id: "one" })], endings: null },
			SITES,
		);
		expect(result?.arc.title).toBeTruthy();
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

/**
 * The three ways a world is not worth keeping.
 *
 * Each of the last two was found by a live run whose own output said the world was fine, which
 * is the argument for this being a function with tests rather than four lines at the end of a
 * pass nothing can call without a key.
 */
describe("what stops a world being played", () => {
	const arc: ScenarioArc = {
		title: "t",
		premise: "p",
		beats: [{ id: "one", order: 0, siteId: 1, npcSlot: 0, requires: [], setsFlag: "arc:one" }],
	};
	const world = (over: Partial<ScenarioArtifact> = {}) =>
		({ id: "w", seed: 1, sites: {}, arc, ...over }) as ScenarioArtifact;

	it("says nothing about a world that plays", () => {
		expect(whatStopsIt({ artifact: world(), refusals: [] })).toBeUndefined();
	});

	it("names the beat that would not open, before anything else", () => {
		const stuck = { beat: "two", why: "nobody there", tried: ["moved them"] };
		const result = whatStopsIt({
			artifact: world(),
			stuck,
			refusals: [{ beat: "one", message: "an errand nothing can close" }],
		});
		// The walk's own answer wins: it is the most specific thing anybody knows, and it carries
		// what was tried.
		expect(result).toBe(stuck);
	});

	it("refuses a world with no story in it", () => {
		// Settling calls this settled, correctly — there is nothing to walk. What the player would
		// get is a map with people on it who have nothing to say about anything.
		const { arc: _none, ...storyless } = world();
		expect(whatStopsIt({ artifact: storyless as ScenarioArtifact, refusals: [] })?.why).toContain(
			"no story",
		);
		expect(
			whatStopsIt({ artifact: world({ arc: { ...arc, beats: [] } }), refusals: [] }),
		).toBeDefined();
	});

	it("refuses a story whose main line hands out an errand nothing can close", () => {
		// Every beat opens, so the walk reports it settled — and `arcOutline.finished` needs every
		// opened main-line beat's quest *completed*, so the player reaches the last scene and waits
		// for an ending that cannot come.
		const result = whatStopsIt({
			artifact: world(),
			refusals: [{ beat: "one", message: '"A Debt in Salt" asks for "silver from Sable"' }],
		});
		expect(result?.beat).toBe("one");
		expect(result?.why).toContain("silver from Sable");
	});
});
