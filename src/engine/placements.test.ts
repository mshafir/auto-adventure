import { describe, expect, it } from "vitest";
import { fallbackSite } from "../ai/director/fallback.js";
import { getInterior } from "../core/gen/features/interior.js";
import { generateSettlement } from "../core/gen/features/settlement.js";
import { hashString } from "../core/rand/hash.js";
import { isContainer } from "../core/rules/loot.js";
import type { Placement } from "../core/rules/placement.js";
import { placementIndex, placementSlot, takenKey } from "../core/rules/placement.js";
import { createInitialState, type GameState } from "../core/rules/state.js";
import type { WorldBounds } from "../core/world/bounds.js";
import { siteContext } from "../core/world/context.js";
import { isSettlement, type MacroSite, macroSite } from "../core/world/macro.js";
import { worldSeed } from "../core/world/recipe.js";
import type { SiteSpec } from "../core/world/spec.js";
import { GameEngine } from "./engine.js";
import { resolvePlacements } from "./placements.js";

const SEED = hashString("placement-test");

/** A generous boundary around the origin, so the site sweep has something to sweep. */
const BOUNDS: WorldBounds = {
	minX: -512,
	minY: -512,
	maxX: 512,
	maxY: 512,
	style: "ocean",
	thickness: 8,
};

/**
 * A settlement inside the boundary that actually built something.
 *
 * "Is a settlement" is not enough: the roster is advisory and a hamlet on awkward
 * ground can fit no plots at all, so a test picking the first settlement it saw was
 * asserting against a town with no buildings in it.
 */
function findBuiltTown(): { site: MacroSite; spec: SiteSpec } {
	for (let my = -8; my <= 8; my++) {
		for (let mx = -8; mx <= 8; mx++) {
			const site = macroSite(worldSeed(SEED), mx, my);
			if (!isSettlement(site.kind)) continue;
			if (site.site.x < BOUNDS.minX || site.site.x > BOUNDS.maxX) continue;
			if (site.site.y < BOUNDS.minY || site.site.y > BOUNDS.maxY) continue;
			const spec: SiteSpec = fallbackSite(
				worldSeed(SEED),
				site,
				siteContext(worldSeed(SEED), site),
			);
			if (generateSettlement(worldSeed(SEED), site, spec.settlement).buildings.length > 0) {
				return { site, spec };
			}
		}
	}
	throw new Error("no built settlement inside the test boundary");
}

const LEDGER: Placement["item"] = {
	name: "Tally Ledger",
	description: "A year of levies, in a cramped hand.",
};

function placement(at: Placement["at"], extra: Partial<Placement> = {}): Placement {
	return { id: "ledger", at, item: LEDGER, ...extra };
}

describe("resolvePlacements", () => {
	it("passes a world tile straight through", () => {
		const { resolved, unresolved } = resolvePlacements(
			[placement({ kind: "world", x: 12, y: -7 })],
			{ world: worldSeed(SEED), siteSpec: () => undefined },
		);
		expect(unresolved).toEqual([]);
		expect(resolved[0]).toMatchObject({ id: "ledger", x: 12, y: -7 });
		expect(resolved[0]?.interiorId).toBeUndefined();
	});

	it("passes an interior position straight through", () => {
		const { resolved } = resolvePlacements(
			[placement({ kind: "interior", interiorId: 99, x: 3, y: 4 })],
			{ world: worldSeed(SEED), siteSpec: () => undefined },
		);
		expect(resolved[0]).toMatchObject({ interiorId: 99, x: 3, y: 4 });
	});

	it("puts a site placement in a container in the named building", () => {
		const { site, spec } = findBuiltTown();
		const built = generateSettlement(worldSeed(SEED), site, spec.settlement);
		const kind = built.buildings[0]?.kind as string;

		const { resolved, unresolved } = resolvePlacements(
			[placement({ kind: "site", siteId: site.id, structure: kind })],
			{
				world: worldSeed(SEED),
				siteSpec: (id) => (id === site.id ? spec : undefined),
				bounds: BOUNDS,
			},
		);
		expect(unresolved).toEqual([]);

		const entry = resolved[0];
		expect(entry?.interiorId).toBe(built.buildings[0]?.interiorId);
		// It lands on something the player would open, which is what makes it findable
		// without the map having to be marked.
		const interior = getInterior(SEED, entry?.interiorId as number, kind as never);
		const decor = interior.decor[(entry?.y as number) * interior.width + (entry?.x as number)] ?? 0;
		expect(isContainer(decor)).toBe(true);
	});

	it("resolves to the same tile every time, so an item does not move between sessions", () => {
		const { site, spec } = findBuiltTown();
		const options = {
			world: worldSeed(SEED),
			siteSpec: (id: number) => (id === site.id ? spec : undefined),
			bounds: BOUNDS,
		};
		const at = placement({ kind: "site", siteId: site.id });
		const first = resolvePlacements([at], options).resolved[0];
		const second = resolvePlacements([at], options).resolved[0];
		expect(first).toBeDefined();
		expect({ ...second }).toEqual({ ...first });
	});

	it("reports rather than drops a site that is not in this world", () => {
		const { resolved, unresolved } = resolvePlacements(
			[placement({ kind: "site", siteId: 123456789 })],
			{ world: worldSeed(SEED), siteSpec: () => undefined, bounds: BOUNDS },
		);
		expect(resolved).toEqual([]);
		expect(unresolved[0]?.id).toBe("ledger");
		expect(unresolved[0]?.reason).toContain("not in this world");
	});

	it("reports a site placement in an unbounded world rather than guessing", () => {
		// A site's position comes from its macro cell and nothing carries the cell, so
		// finding one by id means sweeping — which an infinite world cannot be.
		const { unresolved } = resolvePlacements([placement({ kind: "site", siteId: 1 })], {
			world: worldSeed(SEED),
			siteSpec: () => undefined,
		});
		expect(unresolved[0]?.reason).toContain("bounded world");
	});

	it("reports a building the town does not have", () => {
		const { site, spec } = findBuiltTown();
		const { unresolved } = resolvePlacements(
			[placement({ kind: "site", siteId: site.id, structure: "lighthouse" })],
			{
				world: worldSeed(SEED),
				siteSpec: (id) => (id === site.id ? spec : undefined),
				bounds: BOUNDS,
			},
		);
		expect(unresolved[0]?.reason).toContain("no lighthouse");
	});

	it("copes with nothing to resolve", () => {
		expect(
			resolvePlacements(undefined, { world: worldSeed(SEED), siteSpec: () => undefined }),
		).toEqual({
			resolved: [],
			unresolved: [],
		});
	});
});

describe("placementIndex", () => {
	it("keys world and interior positions apart", () => {
		// (3, 4) in a room and (3, 4) in the world are different tiles, and an index
		// that conflated them would hand out an indoor item to somebody in a field.
		const index = placementIndex([
			{ id: "a", placement: placement({ kind: "world", x: 3, y: 4 }), x: 3, y: 4 },
			{
				id: "b",
				placement: placement({ kind: "interior", interiorId: 1, x: 3, y: 4 }),
				interiorId: 1,
				x: 3,
				y: 4,
			},
		]);
		expect(index.get(placementSlot(undefined, 3, 4))?.id).toBe("a");
		expect(index.get(placementSlot(1, 3, 4))?.id).toBe("b");
	});

	it("keeps the storeys of one building apart", () => {
		// A building with three levels is three grids that happen to share an id, so a key
		// on the id alone put one item at the same coordinates on every one of them —
		// which is also why nothing could be hidden below a cave mouth at all.
		const index = placementIndex([
			{
				id: "ground",
				placement: placement({ kind: "interior", interiorId: 7, x: 3, y: 4 }),
				interiorId: 7,
				x: 3,
				y: 4,
			},
			{
				id: "deep",
				placement: placement({ kind: "interior", interiorId: 7, x: 3, y: 4, level: 2 }),
				interiorId: 7,
				level: 2,
				x: 3,
				y: 4,
			},
		]);
		expect(index.get(placementSlot(7, 3, 4))?.id).toBe("ground");
		expect(index.get(placementSlot(7, 3, 4, 2))?.id).toBe("deep");
		// And the ground floor keeps the key it always had, so a save that recorded taking
		// something still knows it is gone.
		expect(placementSlot(7, 3, 4, 0)).toBe(placementSlot(7, 3, 4));
	});
});

describe("finding a placed item in a running world", () => {
	function engineWith(placements: readonly Placement[], flags: GameState["flags"] = {}) {
		const state: GameState = {
			...createInitialState(
				{ id: "t", name: "t", seed: SEED, createdAt: "", bounds: BOUNDS },
				{ x: 0, y: 0 },
			),
			flags,
			placements,
		};
		return new GameEngine(state, { runEffect: () => {} });
	}

	it("hands over the authored item rather than what the ground would have given", () => {
		// A world tile the player is standing next to. Faced tile is one below, since a
		// new player faces down.
		const engine = engineWith([placement({ kind: "world", x: 0, y: 1 }, { showDecor: true })]);
		engine.dispatch({ t: "Interact" });
		const state = engine.getState();
		expect(state.inventory.some((item) => item.name === LEDGER.name)).toBe(true);
		expect(state.notice).toContain(LEDGER.name);
	});

	it("gives it once, and says so afterwards", () => {
		const engine = engineWith([
			placement({ kind: "world", x: 0, y: 1 }, { emptyText: "Only the empty niche." }),
		]);
		engine.dispatch({ t: "Interact" });
		engine.dispatch({ t: "Interact" });
		const state = engine.getState();
		const held = state.inventory.find((item) => item.name === LEDGER.name);
		expect(held?.quantity).toBe(1);
		expect(state.notice).toBe("Only the empty niche.");
	});

	it("is not there at all while its condition is unmet", () => {
		const engine = engineWith([
			placement({ kind: "world", x: 0, y: 1 }, { requires: { flag: "flood" }, showDecor: true }),
		]);
		expect(engine.markedPlacements()).toEqual([]);
		engine.dispatch({ t: "Interact" });
		expect(engine.getState().inventory.some((item) => item.name === LEDGER.name)).toBe(false);
	});

	it("appears once its condition holds", () => {
		const engine = engineWith(
			[placement({ kind: "world", x: 0, y: 1 }, { requires: { flag: "flood" }, showDecor: true })],
			{ flood: true },
		);
		expect(engine.markedPlacements()).toHaveLength(1);
		engine.dispatch({ t: "Interact" });
		expect(engine.getState().inventory.some((item) => item.name === LEDGER.name)).toBe(true);
	});

	it("stops being drawn once it has been taken", () => {
		const engine = engineWith([placement({ kind: "world", x: 0, y: 1 }, { showDecor: true })]);
		expect(engine.markedPlacements()).toHaveLength(1);
		engine.dispatch({ t: "Interact" });
		expect(engine.markedPlacements()).toEqual([]);
	});

	it("survives the tile having been searched before the story put anything there", () => {
		/*
		 * The failure this exists for is silent and unwinnable.
		 *
		 * A gated placement sits on a tile the generator already furnished — a shelf, a
		 * crate, a patch of ground. Search it *before* the condition holds and you get
		 * whatever the world had there, which is correct. But taking-once used to be
		 * recorded by the tile's own `lootKey`, so that search also marked the authored
		 * item as taken. When the story put it there a minute later, the game said "you
		 * have already been through it" about a thing that had never been there, and the
		 * errand pointing at that room could not be finished by any means at all.
		 */
		const engine = engineWith([
			placement(
				{ kind: "world", x: 0, y: 1 },
				{ requires: { flag: "flood" }, showDecor: true, emptyText: "Only the empty niche." },
			),
		]);
		// Searched early: nothing authored is here yet, and whatever happens must not
		// count as having taken the ledger.
		engine.dispatch({ t: "Interact" });
		expect(engine.getState().inventory.some((item) => item.name === LEDGER.name)).toBe(false);

		engine.dispatch({ t: "ApplyEffects", effects: [{ t: "SetFlag", key: "flood", value: true }] });
		expect(engine.markedPlacements()).toHaveLength(1);
		engine.dispatch({ t: "Interact" });
		expect(engine.getState().inventory.some((item) => item.name === LEDGER.name)).toBe(true);
	});

	it("is remembered by which placement it is, not by where it turned out to be", () => {
		// The resolver picks the tile, and it changes its mind when it learns something —
		// the axe at Camelot moved the day it started preferring a container the player
		// could reach. A positional flag would have applied the old tile's history to
		// whatever else landed there.
		const engine = engineWith([placement({ kind: "world", x: 0, y: 1 })]);
		engine.dispatch({ t: "Interact" });
		expect(engine.getState().flags[takenKey("ledger")]).toBe(true);
	});
});
