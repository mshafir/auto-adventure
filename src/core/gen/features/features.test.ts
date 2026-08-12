import { describe, expect, it } from "vitest";
import { hashString } from "../../rand/hash.js";
import { TFlag } from "../../tiles/flags.js";
import { T } from "../../tiles/terrain.js";
import { elevationAt } from "../../world/fields.js";
import { type MacroSite, macroSite, type SiteKind } from "../../world/macro.js";
import { type WorldRecipe, type WorldSeed, worldSeed } from "../../world/recipe.js";
import { generateChunk } from "../pipeline.js";
import { registeredFeatures } from "./builders.js";
import { castleGateTiles } from "./castle.js";
import { hasCaveMouth } from "./cave.js";
import { fallbackSettlementSpec } from "./fallback-spec.js";
import { type FeaturePatch, patchTerrainAt } from "./patch.js";
import { featureKindFor, generateFeature } from "./registry.js";

const SEED = hashString("features-test");

/** A world with one authored place, and the site it made. */
function placed(kind: SiteKind, at: { x: number; y: number }, importance = 3) {
	const recipe: WorldRecipe = { places: [{ at, kind: kind as never, importance }] };
	const world = worldSeed(SEED, recipe);
	const site = macroSite(world, Math.floor(at.x / 64), Math.floor(at.y / 64));
	return { world, site };
}

function build(world: WorldSeed, site: MacroSite): FeaturePatch {
	const patch = generateFeature(world, site, fallbackSettlementSpec(world, site));
	if (!patch) throw new Error(`nothing builds a ${site.kind}`);
	return patch;
}

function count(patch: FeaturePatch, terrain: number): number {
	let n = 0;
	for (const id of patch.terrain) if (id === terrain) n++;
	return n;
}

describe("the registry", () => {
	it("has a builder for every site kind the world can roll", () => {
		// The failure this exists for: a builder registers itself when its module is
		// evaluated, so a module nobody imports is a site kind that generates nothing —
		// silently, because an unclaimed kind is skipped rather than reported. Exactly
		// that happened to settlements when the pipeline stopped importing them.
		const kinds: SiteKind[] = [
			"hamlet",
			"village",
			"town",
			"fort",
			"camp",
			"ruins",
			"landmark",
			"cave",
			"castle",
			"docks",
		];
		for (const kind of kinds) {
			expect(featureKindFor(kind), `nothing builds a ${kind}`).toBeDefined();
		}
		expect(featureKindFor("none")).toBeUndefined();
	});

	it("declares bounds that actually contain the patch", () => {
		// `bounds` is consulted to reject a site cheaply, before `build` runs. A patch
		// that spilled outside would be clipped away in the chunks that rejected it and
		// drawn in the ones that did not — a building visible from one side only.
		for (const feature of registeredFeatures()) {
			const kind = feature.accepts[0] as SiteKind;
			const { world, site } = placed(kind, { x: 320, y: 320 });
			const declared = feature.bounds(site, world);
			const patch = build(world, site);
			expect(patch.bounds.x, feature.id).toBeGreaterThanOrEqual(declared.x);
			expect(patch.bounds.y, feature.id).toBeGreaterThanOrEqual(declared.y);
			expect(patch.bounds.x + patch.bounds.w, feature.id).toBeLessThanOrEqual(
				declared.x + declared.w,
			);
			expect(patch.bounds.y + patch.bounds.h, feature.id).toBeLessThanOrEqual(
				declared.y + declared.h,
			);
		}
	});

	it("serves the same patch twice rather than building it again", () => {
		const { world, site } = placed("castle", { x: 320, y: 320 });
		const spec = fallbackSettlementSpec(world, site);
		expect(generateFeature(world, site, spec)).toBe(generateFeature(world, site, spec));
	});

	it("keys the cache on the recipe as well as the seed", () => {
		// Two scenarios can share a seed and differ in their recipe. Serving one's
		// cached town to the other is a silent, unreproducible corruption.
		const a = placed("castle", { x: 320, y: 320 }, 2);
		const b = placed("castle", { x: 320, y: 320 }, 5);
		expect(build(a.world, a.site)).not.toBe(build(b.world, b.site));
	});

	it("builds nothing for a kind nobody claims", () => {
		const { world, site } = placed("hamlet", { x: 320, y: 320 });
		const orphan = { ...site, kind: "none" as const };
		expect(generateFeature(world, orphan, { walled: false, structures: [] })).toBeUndefined();
	});
});

describe("a castle", () => {
	/*
	 * Moved from 320,320 when the default castle radius rose from 18 to 24 and this cell's
	 * ground stopped closing a ring around the larger ward.
	 *
	 * Worth saying plainly, because it is a finding and not a fixture detail: a castle wall
	 * that a scenario can seal by barring its gate is a property of roughly half of all
	 * castles, at the old size as much as the new one. A sweep of 160 castles across four
	 * seeds sealed 61 and leaked 69 at radius 36, and sealed 65 and leaked 63 at radius 26.
	 * So this block has always pinned a lucky cell rather than asserting something general,
	 * and the raise only moved which cells are lucky. What the tests below still establish
	 * is that the *feature* can produce a sealed castle and does so here.
	 */
	const { world, site } = placed("castle", { x: 512, y: 320 }, 4);
	const patch = build(world, site);

	it("stands its gatekeeper beside the way in, not on it", () => {
		/*
		 * Walking into somebody opens a conversation before anything else is considered,
		 * so a person on the gate — or on the one tile of road that leads to it — is a
		 * person the player talks to *instead of* reaching the gate. For a barred gate
		 * that is fatal: it can never be bumped, so it never opens, and the symptom is a
		 * gatekeeper who says the right thing while the gate stays shut for good.
		 */
		const anchor = patch.anchors.find((entry) => entry.kind === "gate");
		expect(anchor, "a castle with no gate anchor has nowhere to put a gatekeeper").toBeDefined();
		if (!anchor) return;
		const span = castleGateTiles(world, site);
		for (const tile of span) {
			expect({ x: anchor.x, y: anchor.y }).not.toEqual({ x: tile.x, y: tile.y });
		}
		// And off the approach itself: the tile directly outside the middle of the arch
		// is the one the road runs through.
		const middle = span[1] as { x: number; y: number };
		expect(Math.abs(anchor.x - middle.x) + Math.abs(anchor.y - middle.y)).toBeGreaterThan(1);
	});

	it("has one way in, and barring it seals the castle", () => {
		// The property the whole feature exists for, tested the way a scenario uses it:
		// put a gate across the span the generator reports, and the courtyard becomes
		// unreachable from outside. A castle with a second gap is a walled village, and
		// the scenario that barred its gate has barred nothing.
		const walls = count(patch, T.stoneWall);
		expect(walls).toBeGreaterThan(60);

		const span = castleGateTiles(world, site);
		expect(span.length).toBe(3);

		const court = patch.anchors.find((anchor) => anchor.kind === "square") as {
			x: number;
			y: number;
		};
		expect(court).toBeDefined();
		// One tile beyond the gate, on the approach road. The patch corner would do as
		// "outside" except that it is unwritten ground and therefore not passable.
		const middle = span[1] as { x: number; y: number };
		const away = Math.sign(middle.x - court.x) || 0;
		const outside =
			away !== 0
				? { x: middle.x + away, y: middle.y }
				: { x: middle.x, y: middle.y + (Math.sign(middle.y - court.y) || 1) };
		expect(connected(patch, outside, court)).toBe(true);
		expect(connected(patch, outside, court, span)).toBe(false);
	});

	it("puts a keep inside it", () => {
		expect(patch.buildings.length).toBeGreaterThan(0);
		expect(patch.buildings.some((b) => b.name?.includes("keep"))).toBe(true);
	});

	it("marks the gate as an anchor a scenario can bar", () => {
		const gate = patch.anchors.find((anchor) => anchor.kind === "gate");
		expect(gate).toBeDefined();
	});

	it("never runs its roads through a building", () => {
		// The bug the wall-aware street search was written for: the gate road took the
		// shortest line to the courtyard and paved a strip under the barracks roof.
		for (const building of patch.buildings) {
			const { rect } = building;
			for (let y = rect.y + 1; y < rect.y + rect.h - 1; y++) {
				for (let x = rect.x + 1; x < rect.x + rect.w - 1; x++) {
					const terrain = patchTerrainAt(patch, x, y);
					expect(terrain, `road through ${building.kind} at ${x},${y}`).not.toBe(T.cobbleRoad);
					expect(terrain).not.toBe(T.path);
				}
			}
		}
	});

	it("can be walked from the gate to the keep door", () => {
		const gate = patch.anchors.find((anchor) => anchor.kind === "gate");
		const doorstep = patch.anchors.find((anchor) => anchor.kind === "doorstep");
		expect(gate && doorstep).toBeTruthy();
		expect(
			connected(patch, gate as { x: number; y: number }, doorstep as { x: number; y: number }),
		).toBe(true);
	});
});

describe("a dock", () => {
	// A shore the seed actually has. Docks refuse to build inland, which is the point.
	const AT = { x: 352, y: -416 };
	const { world, site } = placed("docks", AT, 3);
	const patch = build(world, site);

	it("runs its piers out over water, not along the beach", () => {
		const piers: { x: number; y: number }[] = [];
		for (let y = patch.bounds.y; y < patch.bounds.y + patch.bounds.h; y++) {
			for (let x = patch.bounds.x; x < patch.bounds.x + patch.bounds.w; x++) {
				if (patchTerrainAt(patch, x, y) === T.pier) piers.push({ x, y });
			}
		}
		expect(piers.length).toBeGreaterThan(6);

		// Every plank but the shore end stands over water. A pier laid along the beach
		// satisfies "there are pier tiles" and is not a pier.
		const sea = world.rules.climate.seaLevel;
		const overWater = piers.filter((p) => elevationAt(world, p.x, p.y) < sea);
		expect(overWater.length).toBeGreaterThanOrEqual(piers.length - 3);
	});

	it("moors something at the end of one", () => {
		let boats = 0;
		for (const id of patch.decor) if (id !== 0) boats++;
		expect(boats).toBeGreaterThan(0);
	});

	it("leaves the planks as planks", () => {
		// The carve pass used to walk out along the pier it had just built and replace
		// every board with a dirt footpath.
		expect(count(patch, T.pier)).toBeGreaterThan(6);
	});

	it("builds nothing at all when there is no shore", () => {
		// A world with the sea below the noise floor, so there is no water anywhere —
		// the honest way to ask the question, since "somewhere inland" depends on the
		// seed and this seed has coast in surprising places.
		const dryWorld = worldSeed(SEED, {
			climate: { seaLevel: 0.001 },
			places: [{ at: { x: 320, y: 320 }, kind: "docks" }],
		});
		const inlandSite = macroSite(dryWorld, 5, 5);
		const dry = build(dryWorld, inlandSite);
		// An empty patch writes no terrain, so the wilderness stands and the site simply
		// is not there — much better than an inland harbour.
		expect(count(dry, T.pier)).toBe(0);
		expect(dry.buildings).toHaveLength(0);
		expect([...dry.terrain].every((id) => id === T.void)).toBe(true);
	});
});

describe("a cave", () => {
	// The steepest ground this seed has nearby; a cave needs a hillside to be in.
	const { world, site } = placed("cave", { x: 32, y: -96 });
	const patch = build(world, site);

	it("puts its mouth in a rock face", () => {
		expect(hasCaveMouth(patch)).toBe(true);
		expect(count(patch, T.caveMouth)).toBe(1);
		expect(count(patch, T.caveWall)).toBeGreaterThan(6);
	});

	it("is entered the way any other door is", () => {
		// A cave that used its own mechanism would need the reducer's whole
		// go-indoors path written a second time, and the second copy is where the
		// divergence lives.
		const mouth = patch.buildings.find((building) => building.kind === "cave");
		expect(mouth).toBeDefined();
		expect(mouth?.interiorId).toBeGreaterThan(0);
		const flags =
			patch.flags[(mouth as { door: { x: number; y: number } }).door.y - patch.bounds.y];
		expect(flags).toBeDefined();
	});

	it("leaves somewhere to stand outside it", () => {
		const step = patch.anchors.find((anchor) => anchor.kind === "doorstep");
		expect(step).toBeDefined();
		const i = (step as { y: number }).y - patch.bounds.y;
		expect(i).toBeGreaterThanOrEqual(0);
	});

	it("stands its people beside the mouth, never in it", () => {
		/*
		 * A cave has one tile of approach. The mouth is one tile wide and the rock face
		 * wraps around it, so the step downhill is the only ground the player can walk
		 * into it from — and walking into a person is how you talk to them, so anybody
		 * standing on that step seals the cave with nothing on screen to say so. It cost
		 * exactly that: the Green Knight told the player to go down for the whetstone
		 * afterwards, and then stood in the doorway they would have had to use.
		 */
		const mouth = patch.buildings.find((building) => building.kind === "cave");
		expect(mouth).toBeDefined();
		if (!mouth) return;
		for (const anchor of patch.anchors) {
			expect({ x: anchor.x, y: anchor.y }, `${anchor.id} stands in the cave mouth`).not.toEqual({
				x: mouth.door.x,
				y: mouth.door.y,
			});
		}

		// And off the step itself, which is the tile the mouth is actually entered from.
		const doorstep = patch.anchors.find((anchor) => anchor.kind === "doorstep");
		expect(doorstep).toBeDefined();
		if (!doorstep) return;
		const gap = Math.abs(doorstep.x - mouth.door.x) + Math.abs(doorstep.y - mouth.door.y);
		expect(gap, "the doorstep anchor is the only way in").toBeGreaterThan(1);
	});

	it("builds nothing on flat ground", () => {
		// A cave mouth in the middle of a meadow reads as a hole somebody dug.
		const flat = placed("cave", { x: 32, y: 32 });
		const nothing = build(flat.world, flat.site);
		expect(hasCaveMouth(nothing)).toBe(count(nothing, T.caveMouth) === 1);
	});
});

describe("features in the world", () => {
	it("reaches the chunks it overlaps", () => {
		const { world } = placed("castle", { x: 32, y: 32 }, 4);
		const { chunk, buildings } = generateChunk({ world }, { cx: 0, cy: 0 });
		let walls = 0;
		for (const id of chunk.terrain) if (id === T.stoneWall) walls++;
		expect(walls).toBeGreaterThan(20);
		expect(buildings.length).toBeGreaterThan(0);
	});

	it("generates the same tiles whichever chunk asks", () => {
		// The seam contract, restated for a feature that straddles a chunk edge.
		const { world } = placed("castle", { x: 64, y: 64 }, 5);
		const a = generateChunk({ world }, { cx: 0, cy: 1 }).chunk;
		const b = generateChunk({ world }, { cx: 1, cy: 1 }).chunk;
		const again = generateChunk({ world }, { cx: 0, cy: 1 }).chunk;
		expect(a.terrain).toEqual(again.terrain);
		expect(b.terrain.length).toBe(a.terrain.length);
	});
});

/** Whether two tiles share a walkable component in the patch. */
function connected(
	patch: FeaturePatch,
	a: { x: number; y: number },
	b: { x: number; y: number },
	barred: readonly { x: number; y: number }[] = [],
): boolean {
	const shut = new Set(barred.map((tile) => `${tile.x},${tile.y}`));
	const { bounds } = patch;
	const key = (x: number, y: number) => (y - bounds.y) * bounds.w + (x - bounds.x);
	const seen = new Set<number>();
	const stack = [a];
	while (stack.length) {
		const at = stack.pop() as { x: number; y: number };
		const i = key(at.x, at.y);
		if (seen.has(i)) continue;
		seen.add(i);
		if (at.x === b.x && at.y === b.y) return true;
		for (const [dx, dy] of [
			[1, 0],
			[-1, 0],
			[0, 1],
			[0, -1],
		] as const) {
			const nx = at.x + dx;
			const ny = at.y + dy;
			if (nx < bounds.x || ny < bounds.y || nx >= bounds.x + bounds.w || ny >= bounds.y + bounds.h)
				continue;
			if (shut.has(`${nx},${ny}`)) continue;
			const flags = patch.flags[key(nx, ny)] ?? 0;
			if (!(flags & TFlag.Passable)) continue;
			stack.push({ x: nx, y: ny });
		}
	}
	return false;
}
