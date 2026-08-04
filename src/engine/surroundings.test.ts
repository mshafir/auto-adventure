import { describe, expect, it } from "vitest";
import { fallbackSite } from "../ai/director/fallback.js";
import { getInterior } from "../core/gen/features/interior.js";
import type { StructureKind } from "../core/gen/features/patch.js";
import { hashString } from "../core/rand/hash.js";
import { forageYields, isForageable } from "../core/rules/forage.js";
import { containerContents, isContainer } from "../core/rules/loot.js";
import { shopStock, tradeKind } from "../core/rules/shop.js";
import { createInitialState } from "../core/rules/state.js";
import { siteContext } from "../core/world/context.js";
import { type MacroSite, macroSite } from "../core/world/macro.js";
import { GameEngine } from "./engine.js";

function findTown(seed: number): MacroSite {
	for (let r = 0; r < 20; r++) {
		for (let my = -r; my <= r; my++) {
			for (let mx = -r; mx <= r; mx++) {
				const site = macroSite(seed, mx, my);
				if (site.kind === "town") return site;
			}
		}
	}
	throw new Error("no town in range");
}

/** An engine standing in the middle of a fully generated town. */
function townEngine(name: string) {
	const seed = hashString(name);
	const site = findTown(seed);
	const spec = fallbackSite(seed, site, siteContext(seed, site));
	const engine = new GameEngine(
		createInitialState(
			{ id: "t", name: "t", seed, createdAt: "2026-01-01T00:00:00.000Z" },
			site.site,
		),
		{
			runEffect: () => undefined,
			specFor: (s) => (s.id === site.id ? spec.settlement : undefined),
			siteSpec: (id) => (id === site.id ? spec : undefined),
		},
	);
	engine.dispatch({ t: "SiteLearned", spec, source: "fallback" });
	engine.getChunks().prefetch({ cx: site.mx, cy: site.my }, 2);
	engine.populateNpcs({ cx: site.mx, cy: site.my });
	return { engine, site, seed };
}

const SEEDS = ["hollowmoor", "vale", "default", "harrow"];

describe("what a town tells the model it has", () => {
	it("offers no item that cannot actually be got there", () => {
		/**
		 * The bug this exists to prevent, reported from play as "I took a quest and
		 * cannot find it": the item list was built from what each building *kind*
		 * can store rather than what its containers actually hold. A barn can store
		 * timber, so timber was offered as fetchable — and in one measured town no
		 * container held any, so the errand could never be completed however
		 * thoroughly the player searched.
		 */
		for (const name of SEEDS) {
			const { engine, site, seed } = townEngine(name);

			const buyable = new Set<string>();
			for (const npc of engine.getNpcs().atSite(site.id)) {
				const kind = tradeKind(npc.spec.role);
				if (!kind) continue;
				for (const item of shopStock(seed, site.id, npc.spec.slot, kind)) buyable.add(item.name);
			}

			const findable = new Set<string>();
			for (const building of engine.getNpcs().buildingsAt(site)) {
				const interior = getInterior(seed, building.interiorId, building.kind as StructureKind);
				for (let y = 0; y < interior.height; y++) {
					for (let x = 0; x < interior.width; x++) {
						const decor = interior.decor[y * interior.width + x] ?? 0;
						if (!isContainer(decor)) continue;
						for (const item of containerContents(
							seed,
							building.interiorId,
							x,
							y,
							decor,
							building.kind,
						)) {
							findable.add(item.name);
						}
					}
				}
			}

			const carried = new Set(engine.getState().inventory.map((i) => i.name));

			// And whatever the ground around the town can be gathered for.
			const gatherable = new Set<string>();
			const reach = site.radius + 24;
			for (let y = site.site.y - reach; y <= site.site.y + reach; y++) {
				for (let x = site.site.x - reach; x <= site.site.x + reach; x++) {
					const terrain = engine.getWorldView().terrainAt(x, y);
					if (isForageable(terrain)) for (const n of forageYields(terrain)) gatherable.add(n);
				}
			}

			for (const offered of engine.surroundingsFor(site.id).items) {
				const obtainable =
					buyable.has(offered) ||
					findable.has(offered) ||
					gatherable.has(offered) ||
					carried.has(offered);
				expect(
					obtainable,
					`${name}: offered "${offered}" but it cannot be bought, found or gathered`,
				).toBe(true);
			}
		}
	}, 30_000);

	it("still offers something, so an errand is possible at all", () => {
		// The cheap way to satisfy the test above is to offer nothing.
		for (const name of SEEDS) {
			const { engine, site } = townEngine(name);
			expect(engine.surroundingsFor(site.id).items.length, name).toBeGreaterThan(3);
		}
	}, 30_000);

	it("stops offering what the player has already emptied out of the crates", () => {
		// An item that exists only in one crate is no longer fetchable once that
		// crate has been searched, and promising it again would send the player
		// looking for something the world no longer contains.
		const { engine, site, seed } = townEngine("default");
		const before = new Set(engine.surroundingsFor(site.id).items);

		// Empty every container in the town.
		const flags: Record<string, boolean> = {};
		for (const building of engine.getNpcs().buildingsAt(site)) {
			const interior = getInterior(seed, building.interiorId, building.kind as StructureKind);
			for (let y = 0; y < interior.height; y++) {
				for (let x = 0; x < interior.width; x++) {
					const decor = interior.decor[y * interior.width + x] ?? 0;
					if (isContainer(decor)) flags[`looted:${building.interiorId}:${x},${y}`] = true;
				}
			}
		}
		engine.hydrate({ ...engine.getState(), flags });

		const after = new Set(engine.surroundingsFor(site.id).items);
		expect(after.size).toBeLessThan(before.size);
	}, 30_000);

	it("names the buildings and people that are really there", () => {
		const { engine, site } = townEngine("hollowmoor");
		const surroundings = engine.surroundingsFor(site.id);
		expect(surroundings.buildings.length).toBeGreaterThan(0);
		expect(surroundings.people.length).toBeGreaterThan(0);
		expect(surroundings.place).toBeDefined();
	}, 30_000);
});
