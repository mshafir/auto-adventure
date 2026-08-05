import { beforeEach, describe, expect, it } from "vitest";
import { worldSeed } from "../../../core/world/recipe.js";
import { labelComponents } from "../../geom/floodfill.js";
import type { Rect } from "../../geom/vec.js";
import { hashString } from "../../rand/hash.js";
import { makeRng } from "../../rand/rng.js";
import { TFlag } from "../../tiles/flags.js";
import { T } from "../../tiles/terrain.js";
import { CHUNK } from "../../world/coords.js";
import { isSettlement, type MacroSite, macroSite } from "../../world/macro.js";
import { clearRiverCache } from "../../world/rivers.js";
import { clearRoadCache } from "../../world/roads.js";
import { generateChunk } from "../pipeline.js";
import { fallbackSettlementSpec } from "./fallback-spec.js";
import { clearInteriorCache, getInterior } from "./interior.js";
import { type FeaturePatch, patchIndex } from "./patch.js";
import { clearFeatureCache } from "./registry.js";
import { generateSettlement } from "./settlement.js";

beforeEach(() => {
	clearFeatureCache();
	clearRoadCache();
	clearRiverCache();
	clearInteriorCache();
});

/** Every settlement site within a radius of macro cells, across a few seeds. */
function sampleSites(seedName: string, radius = 4): { seed: number; sites: MacroSite[] } {
	const seed = hashString(seedName);
	const sites: MacroSite[] = [];
	for (let my = -radius; my <= radius; my++) {
		for (let mx = -radius; mx <= radius; mx++) {
			const site = macroSite(worldSeed(seed), mx, my);
			if (isSettlement(site.kind)) sites.push(site);
		}
	}
	return { seed, sites };
}

function patchPassable(patch: FeaturePatch, x: number, y: number): boolean {
	const i = patchIndex(patch, x, y);
	if (i < 0) return false;
	return ((patch.flags[i] ?? 0) & TFlag.Passable) !== 0;
}

describe("settlement generation", () => {
	it("is a pure function of the site and spec", () => {
		const { seed, sites } = sampleSites("purity", 2);
		const site = sites[0];
		expect(site).toBeDefined();
		if (!site) return;

		const a = generateSettlement(worldSeed(seed), site, fallbackSettlementSpec(seed, site));
		clearFeatureCache();
		const b = generateSettlement(worldSeed(seed), site, fallbackSettlementSpec(seed, site));
		expect([...a.terrain]).toEqual([...b.terrain]);
		expect(a.buildings.length).toBe(b.buildings.length);
	});

	it("does not depend on which chunk asked for it first", () => {
		// A town straddling several chunks must be the same town whichever chunk
		// triggers its generation. This is the property that makes clipping safe.
		const { seed, sites } = sampleSites("order", 3);
		const site = sites.find((s) => s.kind === "town" || s.kind === "village") ?? sites[0];
		if (!site) return;

		const reference = [
			...generateSettlement(worldSeed(seed), site, fallbackSettlementSpec(seed, site)).terrain,
		];
		for (let attempt = 0; attempt < 6; attempt++) {
			clearFeatureCache();
			// Generate unrelated settlements first, in a shuffled order.
			for (const other of makeRng(attempt).shuffled(sites)) {
				generateSettlement(worldSeed(seed), other, fallbackSettlementSpec(seed, other));
			}
			const again = generateSettlement(worldSeed(seed), site, fallbackSettlementSpec(seed, site));
			expect([...again.terrain]).toEqual(reference);
		}
	});

	it("gives every building a door on its own wall", () => {
		for (const name of ["alpha", "harrow", "vale"]) {
			const { seed, sites } = sampleSites(name, 3);
			for (const site of sites.slice(0, 6)) {
				const patch = generateSettlement(worldSeed(seed), site, fallbackSettlementSpec(seed, site));
				for (const building of patch.buildings) {
					const { rect, door } = building;
					const onEdge =
						door.x === rect.x ||
						door.y === rect.y ||
						door.x === rect.x + rect.w - 1 ||
						door.y === rect.y + rect.h - 1;
					expect(onEdge, `door of ${building.kind} was not on its wall`).toBe(true);
					// And never in a corner, which would make the doorstep diagonal.
					const corner =
						(door.x === rect.x || door.x === rect.x + rect.w - 1) &&
						(door.y === rect.y || door.y === rect.y + rect.h - 1);
					expect(corner).toBe(false);
				}
			}
		}
	});

	it("never places a building on water", () => {
		for (const name of ["moss", "ember"]) {
			const { seed, sites } = sampleSites(name, 3);
			for (const site of sites.slice(0, 6)) {
				const patch = generateSettlement(worldSeed(seed), site, fallbackSettlementSpec(seed, site));
				for (const building of patch.buildings) {
					for (let y = building.rect.y; y < building.rect.y + building.rect.h; y++) {
						for (let x = building.rect.x; x < building.rect.x + building.rect.w; x++) {
							const i = patchIndex(patch, x, y);
							if (i < 0) continue;
							expect((patch.flags[i] ?? 0) & TFlag.Water).toBe(0);
						}
					}
				}
			}
		}
	});

	it("does not overlap buildings with one another", () => {
		const { seed, sites } = sampleSites("overlap", 4);
		for (const site of sites.slice(0, 8)) {
			const patch = generateSettlement(worldSeed(seed), site, fallbackSettlementSpec(seed, site));
			const claimed = new Set<string>();
			for (const building of patch.buildings) {
				for (let y = building.rect.y; y < building.rect.y + building.rect.h; y++) {
					for (let x = building.rect.x; x < building.rect.x + building.rect.w; x++) {
						const key = `${x},${y}`;
						expect(claimed.has(key), `buildings overlap at ${key}`).toBe(false);
						claimed.add(key);
					}
				}
			}
		}
	});
});

describe("carve containment", () => {
	it("never writes outside the patch bounds", () => {
		// The carve pass is the one order-dependent step in the whole generator.
		// It is safe only because it is confined to the feature's own frame; if
		// it could reach beyond the patch it would become chunk-order dependent.
		const { seed, sites } = sampleSites("carve", 3);
		for (const site of sites.slice(0, 8)) {
			const patch = generateSettlement(worldSeed(seed), site, fallbackSettlementSpec(seed, site));
			expect(patch.terrain).toHaveLength(patch.bounds.w * patch.bounds.h);
			// Anything the carve wrote is inside by construction of patchWrite;
			// assert the bounds actually contain the site's whole footprint.
			expect(patch.bounds.x).toBeLessThanOrEqual(site.site.x - site.radius);
			expect(patch.bounds.y).toBeLessThanOrEqual(site.site.y - site.radius);
			expect(patch.bounds.x + patch.bounds.w).toBeGreaterThanOrEqual(site.site.x + site.radius);
			expect(patch.bounds.y + patch.bounds.h).toBeGreaterThanOrEqual(site.site.y + site.radius);
		}
	});

	it("never breaks a wall to reach an anchor", () => {
		// The old design let the player punch through stone when an objective was
		// unreachable. Here walls are infinite cost to the carve, so a wall that
		// exists stays a wall and the only way in is the door.
		const { seed, sites } = sampleSites("walls", 3);
		for (const site of sites.slice(0, 8)) {
			const patch = generateSettlement(worldSeed(seed), site, fallbackSettlementSpec(seed, site));
			for (const building of patch.buildings) {
				const { rect, door } = building;
				let openings = 0;
				for (let y = rect.y; y < rect.y + rect.h; y++) {
					for (let x = rect.x; x < rect.x + rect.w; x++) {
						const onEdge =
							x === rect.x ||
							y === rect.y ||
							x === rect.x + rect.w - 1 ||
							y === rect.y + rect.h - 1;
						if (!onEdge) continue;
						const i = patchIndex(patch, x, y);
						if (i < 0) continue;
						const flags = patch.flags[i] ?? 0;
						// A wall tile that became passable would be a punched hole.
						if (flags & TFlag.Passable && !(x === door.x && y === door.y)) openings++;
					}
				}
				expect(openings, `${building.kind} wall was breached`).toBe(0);
			}
		}
	});
});

describe("settlement connectivity", () => {
	it("connects the square to every doorstep", () => {
		let checked = 0;
		for (const name of ["alpha", "harrow", "vale", "moss"]) {
			const { seed, sites } = sampleSites(name, 3);
			for (const site of sites.slice(0, 5)) {
				const patch = generateSettlement(worldSeed(seed), site, fallbackSettlementSpec(seed, site));
				if (patch.buildings.length === 0) continue;

				const square = patch.anchors.find((a) => a.kind === "square");
				expect(square).toBeDefined();
				if (!square) continue;

				const bounds: Rect = patch.bounds;
				const result = labelComponents(bounds, (x, y) => patchPassable(patch, x, y), true);
				const squareLabel =
					result.labels[(square.y - bounds.y) * bounds.w + (square.x - bounds.x)] ?? 0;
				expect(squareLabel).toBeGreaterThan(0);

				for (const anchor of patch.anchors) {
					if (anchor.kind !== "doorstep") continue;
					const label =
						result.labels[(anchor.y - bounds.y) * bounds.w + (anchor.x - bounds.x)] ?? 0;
					expect(label, `doorstep ${anchor.id} in ${name} is cut off from the square`).toBe(
						squareLabel,
					);
					checked++;
				}
			}
		}
		// Guard against the assertions silently never running.
		expect(checked).toBeGreaterThan(20);
	});

	it("leaves settlement chunks walkable overall", () => {
		const { seed, sites } = sampleSites("walkable", 3);
		let checked = 0;
		for (const site of sites.slice(0, 6)) {
			const cc = { cx: site.mx, cy: site.my };
			const { chunk, summary } = generateChunk({ world: worldSeed(seed) }, cc);
			if (summary.buildingCount === 0) continue;
			let passable = 0;
			for (const flags of chunk.flags) if (flags & TFlag.Passable) passable++;
			// A town that filled its chunk with walls would be a generation bug.
			expect(passable / (CHUNK * CHUNK)).toBeGreaterThan(0.3);
			checked++;
		}
		expect(checked).toBeGreaterThan(0);
	});

	it("puts a door and a walkable doorstep into the chunk that owns it", () => {
		const { seed, sites } = sampleSites("doors", 3);
		let found = 0;
		for (const site of sites.slice(0, 8)) {
			const { chunk, buildings } = generateChunk(
				{ world: worldSeed(seed) },
				{ cx: site.mx, cy: site.my },
			);
			for (const building of buildings) {
				const lx = building.door.x - site.mx * CHUNK;
				const ly = building.door.y - site.my * CHUNK;
				if (lx < 0 || ly < 0 || lx >= CHUNK || ly >= CHUNK) continue;
				expect(chunk.terrain[ly * CHUNK + lx]).toBe(T.doorClosed);
				found++;
			}
		}
		expect(found).toBeGreaterThan(0);
	});
});

describe("interiors", () => {
	it("is enclosed, reachable, and has exactly one way out", () => {
		for (const kind of ["house", "inn", "shop", "smithy", "temple", "barracks", "ruin"] as const) {
			const interior = getInterior(1234, 42 + kind.length, kind);
			const bounds = { x: 0, y: 0, w: interior.width, h: interior.height };
			const passable = (x: number, y: number) => {
				const i = y * interior.width + x;
				return ((interior.flags[i] ?? 0) & TFlag.Passable) !== 0;
			};

			// The exit is the single open door.
			let openDoors = 0;
			for (const terrain of interior.terrain) if (terrain === T.doorOpen) openDoors++;
			expect(openDoors, `${kind} should have one exit`).toBe(1);

			// The entrance tile must be standable and connected to the exit.
			expect(passable(interior.entrance.x, interior.entrance.y)).toBe(true);
			const result = labelComponents(bounds, passable, true);
			const entranceLabel =
				result.labels[interior.entrance.y * interior.width + interior.entrance.x] ?? 0;
			const exitLabel =
				result.labels[(interior.entrance.y + 1) * interior.width + interior.entrance.x] ?? 0;
			expect(entranceLabel).toBeGreaterThan(0);
			expect(exitLabel).toBe(entranceLabel);
		}
	});

	it("is deterministic per interior id", () => {
		const a = getInterior(99, 7, "inn");
		clearInteriorCache();
		const b = getInterior(99, 7, "inn");
		expect([...a.terrain]).toEqual([...b.terrain]);
		expect([...a.decor]).toEqual([...b.decor]);
	});

	it("never furnishes the tile the player arrives on", () => {
		for (const kind of ["house", "inn", "shop"] as const) {
			const interior = getInterior(5, 11, kind);
			const i = interior.entrance.y * interior.width + interior.entrance.x;
			expect(interior.decor[i]).toBe(0);
		}
	});
});

describe("fallback spec", () => {
	it("is deterministic", () => {
		const { seed, sites } = sampleSites("fallback", 2);
		for (const site of sites) {
			expect(fallbackSettlementSpec(seed, site)).toEqual(fallbackSettlementSpec(seed, site));
		}
	});

	it("scales roster size with the kind of place", () => {
		const seed = hashString("roster");
		const sizes = new Map<string, number>();
		for (let my = -6; my <= 6; my++) {
			for (let mx = -6; mx <= 6; mx++) {
				const site = macroSite(worldSeed(seed), mx, my);
				if (!isSettlement(site.kind)) continue;
				const spec = fallbackSettlementSpec(seed, site);
				sizes.set(site.kind, Math.max(sizes.get(site.kind) ?? 0, spec.structures.length));
			}
		}
		const town = sizes.get("town") ?? 0;
		const hamlet = sizes.get("hamlet") ?? 0;
		if (town > 0 && hamlet > 0) expect(town).toBeGreaterThan(hamlet);
	});
});

describe("perimeter wall continuity", () => {
	/**
	 * The wall ring must be 4-connected, not merely 8-connected.
	 *
	 * The ring is sampled by angle and rounded to tiles, so on its 45-degree arcs
	 * consecutive samples used to land diagonally. Two tiles touching only at a
	 * corner have no orthogonal neighbour, and the renderer's autotiler looks only
	 * N/E/S/W, so each run came out as a stub capped at both ends: the wall drew as
	 * `╺━━╸ ╺╸ ┏╸ ╺┛ ■`, a dotted diagonal that reads as a gap exactly where there
	 * should be a corner.
	 *
	 * Asserted on the terrain rather than on the glyphs, so this stays a property of
	 * the generated world and does not depend on the render layer.
	 */
	const WALL_PLANE = new Set([T.stoneWall, T.woodWall, T.window, T.doorClosed, T.doorOpen]);

	it("leaves no wall tile without an orthogonal neighbour", () => {
		let checkedTowns = 0;
		let walls = 0;
		let isolated = 0;
		let ends = 0;

		for (const name of ["vale", "harrow", "moss", "ember"]) {
			const { seed, sites } = sampleSites(name, 4);
			for (const site of sites) {
				const spec = fallbackSettlementSpec(seed, site);
				if (!spec.walled) continue;
				checkedTowns++;

				const patch = generateSettlement(worldSeed(seed), site, spec);
				const terrainAt = (x: number, y: number) => {
					const i = patchIndex(patch, x, y);
					return i < 0 ? T.void : (patch.terrain[i] ?? T.void);
				};

				for (let y = patch.bounds.y; y < patch.bounds.y + patch.bounds.h; y++) {
					for (let x = patch.bounds.x; x < patch.bounds.x + patch.bounds.w; x++) {
						if (!WALL_PLANE.has(terrainAt(x, y))) continue;
						walls++;
						let neighbours = 0;
						if (WALL_PLANE.has(terrainAt(x, y - 1))) neighbours++;
						if (WALL_PLANE.has(terrainAt(x + 1, y))) neighbours++;
						if (WALL_PLANE.has(terrainAt(x, y + 1))) neighbours++;
						if (WALL_PLANE.has(terrainAt(x - 1, y))) neighbours++;
						if (neighbours === 0) isolated++;
						else if (neighbours === 1) ends++;
					}
				}
			}
		}

		expect(checkedTowns, "no walled settlement in the sample").toBeGreaterThan(0);
		expect(walls).toBeGreaterThan(200);
		// A lone pillar is never right: it is a wall tile with nothing to join.
		expect(isolated, `${isolated} isolated wall tiles`).toBe(0);
		// A dangling end is right only where the wall stops at a gate, so a handful
		// per town is expected and a tenth of every wall tile is not.
		expect(ends / walls, `${ends} of ${walls} wall tiles dangle`).toBeLessThan(0.04);
	});
});

describe("walled settlements", () => {
	/**
	 * The square must be reachable from open country.
	 *
	 * The perimeter wall is drawn *after* the streets and deliberately skips road
	 * tiles, which is the only thing that leaves a gate. If that ordering were
	 * ever reversed, every walled town in the world would become a sealed box the
	 * player can see and never enter — and nothing else in the suite would notice,
	 * because the inside stays perfectly connected to itself.
	 */
	it("can be entered from outside the wall", () => {
		let checked = 0;
		for (const name of ["vale", "harrow", "moss", "ember"]) {
			const { seed, sites } = sampleSites(name, 4);
			for (const site of sites) {
				const spec = fallbackSettlementSpec(seed, site);
				if (!spec.walled) continue;

				const patch = generateSettlement(worldSeed(seed), site, spec);
				const square = patch.anchors.find((a) => a.kind === "square");
				expect(square, `${site.kind} at ${site.mx},${site.my} has no square`).toBeDefined();
				if (!square) continue;

				// Flood fill the patch plus a margin of open ground around it. Tiles the
				// patch does not write are wilderness, and walkable.
				const margin = 3;
				const bounds: Rect = {
					x: patch.bounds.x - margin,
					y: patch.bounds.y - margin,
					w: patch.bounds.w + margin * 2,
					h: patch.bounds.h + margin * 2,
				};
				const walkable = (x: number, y: number) => {
					const i = patchIndex(patch, x, y);
					if (i < 0) return true;
					if ((patch.terrain[i] ?? T.void) === T.void) return true;
					return ((patch.flags[i] ?? 0) & TFlag.Passable) !== 0;
				};

				const labels = labelComponents(bounds, walkable, true);
				const labelAt = (x: number, y: number) =>
					labels.labels[(y - bounds.y) * bounds.w + (x - bounds.x)] ?? 0;

				const outside = labelAt(bounds.x, bounds.y);
				expect(outside, `${name} ${site.kind}: no open ground outside the wall`).toBeGreaterThan(0);
				expect(
					labelAt(square.x, square.y),
					`${name} ${site.kind} at ${site.mx},${site.my} is sealed off from the countryside`,
				).toBe(outside);
				checked++;
			}
		}
		expect(checked, "no walled settlements were sampled").toBeGreaterThan(0);
	});
});

describe("the town square", () => {
	/**
	 * Found while giving buildings roofs. The BSP that produces plots is laid over
	 * the town centre and the square sits at the town centre, so a plot could land
	 * on top of it — burying the well and leaving the `square` anchor inside
	 * somebody's house. Everyone gathers there in the evening and every carve path
	 * starts there, so the whole settlement was routed from a tile behind a door.
	 *
	 * It survived because a building used to be floored rather than roofed: the
	 * stolen square stayed passable, so the connectivity check saw nothing wrong.
	 */
	it("is never built on", () => {
		for (const name of ["alpha", "harrow", "vale", "moss", "hollowmoor"]) {
			const { seed, sites } = sampleSites(name, 3);
			for (const site of sites.slice(0, 8)) {
				const patch = generateSettlement(worldSeed(seed), site, fallbackSettlementSpec(seed, site));
				const square = patch.anchors.find((a) => a.kind === "square");
				if (!square) continue;

				for (const building of patch.buildings) {
					const { rect } = building;
					const inside =
						square.x >= rect.x &&
						square.x < rect.x + rect.w &&
						square.y >= rect.y &&
						square.y < rect.y + rect.h;
					expect(inside, `${name}: a ${building.kind} was built on the square`).toBe(false);
				}
			}
		}
	}, 30_000);

	it("is somewhere the player can stand", () => {
		// The weaker version of the above, and the one that actually bit: whatever
		// covers the square, it has to be walkable.
		for (const name of ["alpha", "harrow", "vale", "moss"]) {
			const { seed, sites } = sampleSites(name, 3);
			for (const site of sites.slice(0, 8)) {
				const patch = generateSettlement(worldSeed(seed), site, fallbackSettlementSpec(seed, site));
				const square = patch.anchors.find((a) => a.kind === "square");
				if (!square) continue;
				expect(
					patchPassable(patch, square.x, square.y),
					`${name}: the square of a ${site.kind} cannot be stood on`,
				).toBe(true);
			}
		}
	}, 30_000);
});

describe("buildings seen from outside", () => {
	it("are roofed, not floored", () => {
		// Interiors are separate grids, so the tiles inside the wall ring are only
		// ever seen from above. Writing the floor there drew the floorboards of a
		// closed building through its own roof and made a town read as a plan.
		const { seed, sites } = sampleSites("roofs", 3);
		let checked = 0;
		for (const site of sites.slice(0, 8)) {
			const patch = generateSettlement(worldSeed(seed), site, fallbackSettlementSpec(seed, site));
			for (const building of patch.buildings) {
				if (building.kind === "ruin") continue;
				const { rect } = building;
				for (let y = rect.y + 1; y < rect.y + rect.h - 1; y++) {
					for (let x = rect.x + 1; x < rect.x + rect.w - 1; x++) {
						const i = patchIndex(patch, x, y);
						if (i < 0) continue;
						expect(patch.terrain[i], `${building.kind} shows its floor at ${x},${y}`).toBe(T.roof);
						checked++;
					}
				}
			}
		}
		expect(checked).toBeGreaterThan(100);
	}, 30_000);

	it("cannot be walked into except through the door", () => {
		// A roof is impassable where a floor was not, so this is now true of the
		// footprint as well as the wall ring.
		const { seed, sites } = sampleSites("roofs", 3);
		for (const site of sites.slice(0, 8)) {
			const patch = generateSettlement(worldSeed(seed), site, fallbackSettlementSpec(seed, site));
			for (const building of patch.buildings) {
				if (building.kind === "ruin") continue;
				const { rect } = building;
				for (let y = rect.y + 1; y < rect.y + rect.h - 1; y++) {
					for (let x = rect.x + 1; x < rect.x + rect.w - 1; x++) {
						expect(patchPassable(patch, x, y), `${building.kind} is open at ${x},${y}`).toBe(false);
					}
				}
			}
		}
	}, 30_000);
});
