import { describe, expect, it } from "vitest";
import { ASH_HOLLOW_ID, npcIdFor, twoPhaseArtifact } from "../../test/fixtures/two-phase.js";
import { hashString } from "../core/rand/hash.js";
import type { Scene, StagedAction } from "../core/rules/scene.js";
import { sitesInside } from "../core/world/macro.js";
import { worldSeed } from "../core/world/recipe.js";
import { artifactWorld } from "../scenario/artifact.js";
import { ChunkManager } from "./chunk-manager.js";
import { NpcDirectory } from "./npc-directory.js";
import { type StageOptions, stageScene } from "./scene-staging.js";
import { createWorldView } from "./world-view.js";

/**
 * A ten-by-ten room with a wall down x=5 and one gap at y=9.
 *
 * Small and hand-made rather than generated, so a route around an obstacle is something the
 * test can state rather than something it has to hope the world contains.
 */
const options: StageOptions = {
	world: worldSeed(hashString("staging-test")),
	bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10, style: "cliffs", thickness: 1 },
	siteSpec: () => undefined,
	isPassable: (x, y) => {
		if (x < 0 || y < 0 || x > 9 || y > 9) return false;
		return x !== 5 || y === 9;
	},
	player: { x: 0, y: 0 },
};

function sceneOf(steps: Scene["steps"], rest: Partial<Scene> = {}): Scene {
	return { id: "s", steps, ...rest };
}

/** The one action of a one-action step, for a test that only cares about that. */
function only(scene: Scene, step = 0, opts: StageOptions = options): StagedAction | undefined {
	return stageScene(scene, opts).staged?.steps[step]?.do[0];
}

const at = (x: number, y: number) => ({ kind: "world", x, y }) as const;

describe("stageScene", () => {
	it("turns a world point into a plain coordinate", () => {
		const staged = only(sceneOf([{ do: [{ t: "Spawn", actor: "rider", at: at(3, 4) }] }]));
		expect(staged).toEqual({ t: "Spawn", actor: "rider", at: { x: 3, y: 4 } });
	});

	it("precomputes a walk as the tiles it will step onto", () => {
		const staged = only(
			sceneOf([
				{ do: [{ t: "Spawn", actor: "rider", at: at(0, 0) }] },
				{ do: [{ t: "WalkTo", actor: "rider", to: at(3, 0) }] },
			]),
			1,
		);
		expect(staged).toMatchObject({ t: "WalkTo", actor: "rider", speed: "normal" });
		// The tile it starts on is not in the path — an actor already standing there does not
		// step onto it, and a path that included it would waste the first frame.
		expect((staged as { path: readonly { x: number }[] }).path.map((p) => p.x)).toEqual([1, 2, 3]);
	});

	it("routes a walk around a wall rather than through it", () => {
		const staged = only(
			sceneOf([
				{ do: [{ t: "Spawn", actor: "rider", at: at(4, 0) }] },
				{ do: [{ t: "WalkTo", actor: "rider", to: at(6, 0) }] },
			]),
			1,
		);
		const path = (staged as { path: readonly { x: number; y: number }[] }).path;
		// The only gap in the wall is at y=9, so the route has to go down and back up. A scene
		// that teleported through would look like a rendering fault.
		expect(path.some((point) => point.y === 9)).toBe(true);
		expect(path.at(-1)).toEqual({ x: 6, y: 0 });
	});

	it("keeps a walk to passable ground the whole way", () => {
		const staged = only(
			sceneOf([
				{ do: [{ t: "Spawn", actor: "rider", at: at(4, 0) }] },
				{ do: [{ t: "WalkTo", actor: "rider", to: at(6, 0) }] },
			]),
			1,
		);
		for (const step of (staged as { path: readonly { x: number; y: number }[] }).path) {
			expect(options.isPassable(step.x, step.y), `${step.x},${step.y}`).toBe(true);
		}
	});

	it("walks from where the actor was left by the step before", () => {
		const { staged } = stageScene(
			sceneOf([
				{ do: [{ t: "Spawn", actor: "rider", at: at(0, 0) }] },
				{ do: [{ t: "WalkTo", actor: "rider", to: at(2, 0) }] },
				{ do: [{ t: "WalkTo", actor: "rider", to: at(4, 0) }] },
			]),
			options,
		);
		const second = staged?.steps[2]?.do[0] as { path: readonly { x: number }[] };
		// Three, four — not one, two, three, four. The second walk starts where the first ended.
		expect(second.path.map((p) => p.x)).toEqual([3, 4]);
	});

	it("starts the player where the player actually is", () => {
		const staged = only(sceneOf([{ do: [{ t: "WalkTo", actor: "player", to: at(2, 0) }] }]), 0, {
			...options,
			player: { x: 0, y: 0 },
		});
		expect((staged as { path: readonly { x: number }[] }).path.map((p) => p.x)).toEqual([1, 2]);
	});

	it("gives a walk with nowhere to go a sentence rather than dropping it", () => {
		const { staged, problems } = stageScene(
			sceneOf([
				{ do: [{ t: "Spawn", actor: "rider", at: at(0, 0) }] },
				{ do: [{ t: "WalkTo", actor: "rider", to: at(50, 50) }] },
			]),
			options,
		);
		expect(staged).toBeUndefined();
		expect(problems[0]).toContain("rider");
		expect(problems[0]).toContain("nothing passable connects them");
	});

	/*
	 * Whole rather than in part. A scene that plays with one action quietly missing is worse
	 * than one that does not play: the story loses a beat and nothing says so.
	 */
	it("fails the whole scene when one action cannot be staged", () => {
		const { staged } = stageScene(
			sceneOf([
				{ do: [{ t: "Say", actor: "player", text: "Fine so far." }] },
				{ do: [{ t: "WalkTo", actor: "nobody", to: at(1, 1) }] },
			]),
			options,
		);
		expect(staged).toBeUndefined();
	});

	it("names an actor who walks without having been put on stage", () => {
		const { problems } = stageScene(
			sceneOf([{ do: [{ t: "WalkTo", actor: "rdier", to: at(1, 0) }] }]),
			options,
		);
		// The likeliest cause is a typo in an alias, and without this the scene would play with
		// the character simply absent.
		expect(problems[0]).toContain("rdier");
		expect(problems[0]).toContain("not on stage");
	});

	it("says nothing about a site that is not in this world, twice over", () => {
		const { staged, problems } = stageScene(
			sceneOf([{ do: [{ t: "Camera", to: { kind: "anchor", siteId: 12345, anchor: "well" } }] }]),
			options,
		);
		expect(staged).toBeUndefined();
		expect(problems[0]).toContain("12345");
	});

	it("defaults a scene to skippable and a camera to a cut", () => {
		const { staged } = stageScene(sceneOf([{ do: [{ t: "Camera", to: at(1, 1) }] }]), options);
		expect(staged?.skippable).toBe(true);
		expect(staged?.steps[0]?.do[0]).toEqual({ t: "Camera", to: { x: 1, y: 1 }, pan: "cut" });
	});

	it("takes a scene at its word when it says it may not be skipped", () => {
		const { staged } = stageScene(
			sceneOf([{ do: [{ t: "Wait", ticks: 1 }] }], { skippable: false }),
			options,
		);
		expect(staged?.skippable).toBe(false);
	});

	it("passes a facing through without looking anything up", () => {
		const staged = only(sceneOf([{ do: [{ t: "Face", actor: "player", at: "up" }] }]));
		expect(staged).toEqual({ t: "Face", actor: "player", at: "up" });
	});

	it("keeps a step's hold", () => {
		const { staged } = stageScene(sceneOf([{ do: [{ t: "Wait", ticks: 2 }], hold: 5 }]), options);
		expect(staged?.steps[0]?.hold).toBe(5);
	});

	it("gives an actor already standing at its destination an empty walk", () => {
		const staged = only(
			sceneOf([
				{ do: [{ t: "Spawn", actor: "rider", at: at(2, 2) }] },
				{ do: [{ t: "WalkTo", actor: "rider", to: at(2, 2) }] },
			]),
			1,
		);
		// Empty rather than refused: "walk to where you already are" is a reasonable thing for a
		// scene to say when the destination is computed, and it finishes immediately.
		expect((staged as { path: readonly unknown[] }).path).toEqual([]);
	});

	it("lets a walk end on an occupied tile, since an anchor usually has somebody at it", () => {
		const blocked: StageOptions = {
			...options,
			isPassable: (x, y) => options.isPassable(x, y) && !(x === 3 && y === 0),
		};
		const staged = only(
			sceneOf([
				{ do: [{ t: "Spawn", actor: "rider", at: at(0, 0) }] },
				{ do: [{ t: "WalkTo", actor: "rider", to: at(3, 0) }] },
			]),
			1,
			blocked,
		);
		expect((staged as { path: readonly { x: number }[] }).path.at(-1)).toEqual({ x: 3, y: 0 });
	});
});

/*
 * The unit tests above use a hand-made room, because a route around an obstacle is something a
 * test should be able to state rather than hope the world contains. This one is the other half:
 * a scene written against a real surveyed world, staged against the ground the generator
 * actually produces. It is what catches an anchor that turns out to be indoors, a gate on the
 * wrong side of a town, and a walk with a building in the way.
 */
describe("staging against a real world", () => {
	function realWorld() {
		const artifact = twoPhaseArtifact();
		const world = artifactWorld(artifact);
		const chunks = new ChunkManager({
			world,
			capacity: 400,
			bounds: artifact.bounds,
			specFor: (site) => artifact.sites[String(site.id)]?.settlement,
			...(artifact.terraform ? { terraform: artifact.terraform } : {}),
		});
		for (let cy = -3; cy <= 1; cy++) for (let cx = 0; cx <= 2; cx++) chunks.ensure(cx, cy);
		const view = createWorldView({ seed: artifact.seed, chunkAt: (cx, cy) => chunks.get(cx, cy) });
		const people = new NpcDirectory(chunks, (id) => artifact.sites[String(id)]);
		people.populate([...sitesInside(world, artifact.bounds).values()]);

		const options: StageOptions = {
			world,
			bounds: artifact.bounds,
			siteSpec: (id) => artifact.sites[String(id)],
			isPassable: (x, y) => view.isPassable(x, y),
			player: artifact.spawn,
			npcAt: (id) => {
				const found = people.byNpcId(id);
				return found ? { x: found.x, y: found.y } : undefined;
			},
		};
		return { artifact, options, people };
	}

	it("stages the fixture's cutscene", () => {
		const { artifact, options } = realWorld();
		const scene = artifact.scenes?.["the-messenger-arrives"];
		if (!scene) throw new Error("the fixture has no scene, so this test proves nothing");
		const { staged, problems } = stageScene(scene, options);
		expect(problems).toEqual([]);
		expect(staged?.steps).toHaveLength(5);
	});

	it("gives the rider real ground to cross, not a teleport", () => {
		// A walk of zero tiles is what this looked like when the rider was cast as somebody
		// already standing at the well: the scene staged clean and nothing moved.
		const { artifact, options } = realWorld();
		const scene = artifact.scenes?.["the-messenger-arrives"];
		if (!scene) throw new Error("the fixture has no scene, so this test proves nothing");
		const walk = stageScene(scene, options).staged?.steps[1]?.do[0] as {
			readonly path: readonly { x: number; y: number }[];
		};
		expect(walk.path.length).toBeGreaterThan(10);
	});

	it("routes that walk over ground the player could walk too", () => {
		const { artifact, options } = realWorld();
		const scene = artifact.scenes?.["the-messenger-arrives"];
		if (!scene) throw new Error("the fixture has no scene, so this test proves nothing");
		const walk = stageScene(scene, options).staged?.steps[1]?.do[0] as {
			readonly path: readonly { x: number; y: number }[];
		};
		for (const step of walk.path.slice(0, -1)) {
			expect(options.isPassable(step.x, step.y), `${step.x},${step.y}`).toBe(true);
		}
	});

	it("starts a cast member who lives here where they are standing", () => {
		const { options, people } = realWorld();
		const keeper = people.byNpcId(npcIdFor(ASH_HOLLOW_ID, 0));
		if (!keeper) throw new Error("the fixture's shrine-keeper is not in the world");

		const { staged, problems } = stageScene(
			{
				id: "no-spawn",
				cast: { keeper: npcIdFor(ASH_HOLLOW_ID, 0) },
				steps: [
					{
						do: [
							{ t: "WalkTo", actor: "keeper", to: { kind: "world", x: keeper.x + 2, y: keeper.y } },
						],
					},
				],
			},
			options,
		);
		expect(problems).toEqual([]);
		expect((staged?.steps[0]?.do[0] as { path: readonly unknown[] }).path).toHaveLength(2);
	});

	it("refuses an anchor that only exists indoors", () => {
		// `hearth` is real, and every one of them is inside somebody's house. A cutscene played
		// in a front room is not what a scene means by naming a place.
		const { options } = realWorld();
		const { staged, problems } = stageScene(
			{
				id: "indoors",
				steps: [
					{
						do: [{ t: "Camera", to: { kind: "anchor", siteId: ASH_HOLLOW_ID, anchor: "hearth" } }],
					},
				],
			},
			options,
		);
		expect(staged).toBeUndefined();
		expect(problems[0]).toContain("no outdoor hearth");
	});

	it("finds a building's door by its proper name", () => {
		const { options } = realWorld();
		const { staged, problems } = stageScene(
			{
				id: "doorstep",
				steps: [
					{
						do: [
							{
								t: "Camera",
								to: { kind: "door", siteId: ASH_HOLLOW_ID, structure: "The Ash Shrine" },
							},
						],
					},
				],
			},
			options,
		);
		expect(problems).toEqual([]);
		expect(staged?.steps[0]?.do[0]).toMatchObject({ t: "Camera" });
	});

	it("says so when a building of that name is nowhere in the town", () => {
		const { options } = realWorld();
		const { problems } = stageScene(
			{
				id: "missing",
				steps: [
					{
						do: [
							{
								t: "Camera",
								to: { kind: "door", siteId: ASH_HOLLOW_ID, structure: "The Custom House" },
							},
						],
					},
				],
			},
			options,
		);
		expect(problems[0]).toContain("The Custom House");
	});
});
