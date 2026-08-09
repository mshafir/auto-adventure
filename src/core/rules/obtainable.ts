import type { GoodsTables } from "../content/goods.js";
import { getInterior } from "../gen/features/interior.js";
import type { StructureKind } from "../gen/features/patch.js";
import type { TerrainId } from "../tiles/terrain.js";
import { forageYields, isForageable } from "./forage.js";
import { containerContents, isContainer } from "./loot.js";
import { shopStock, tradeKind } from "./shop.js";

/**
 * Item names a `have` objective could legitimately name.
 *
 * Five sources, and all five have to be here or an errand gets refused that the
 * player could actually have satisfied: what is on sale, what the buildings here
 * actually hold, what the land around gives up, what the scenario placed by hand, and
 * what the player already carries. This is why "fetch me timber" is a legal errand in
 * a milling town and an illegal one in a fishing village, without anything holding a
 * catalogue of its own.
 *
 * Extracted from the engine so the offline validator can ask the identical
 * question. That matters more than the duplication it saves: while the two had
 * separate notions of "obtainable", a scenario could pass authoring carrying a fetch
 * quest the running game would refuse, and the only symptom was an errand that never
 * appeared. One implementation cannot disagree with itself.
 *
 * Pure, so it answers equally for a live engine's rosters and for content generated
 * offline from a seed.
 */

/** Sweep spacing for the ground sources, in tiles. */
const FORAGE_STRIDE = 3;

/** How far past a settlement's own footprint its land is considered to reach. */
export const FORAGE_MARGIN = 24;

export interface ObtainableGround {
	readonly centre: { readonly x: number; readonly y: number };
	/** The settlement's radius; the sweep reaches `FORAGE_MARGIN` beyond it. */
	readonly radius: number;
	/**
	 * Terrain at a position, or undefined where nothing has been generated.
	 *
	 * Undefined is not the same as barren: it means "do not promise this", which is
	 * why the live engine passes only resident chunks and the validator — which has
	 * generated the whole bounded world — can pass all of it.
	 */
	readonly terrainAt: (x: number, y: number) => TerrainId | undefined;
}

export interface ObtainableInput {
	readonly seed: number;
	/**
	 * The tables that say what exists to be had.
	 *
	 * Required rather than defaulted, and this is the one place in the goods work where
	 * that is worth the churn at every call site. The whole reason this function was
	 * extracted (see above) is that the validator and the running engine must not have
	 * separate notions of "obtainable" — and the moment goods became per-world, a default
	 * here would be exactly how they acquire one: a scenario authored against a pack's
	 * catalogue, then validated against the built-in one, passes with a fetch quest the
	 * game will refuse. A default would make that silent. This makes it a type error.
	 */
	readonly goods: GoodsTables;
	readonly siteId: number;
	/** Everyone at the site. Non-traders are ignored here rather than by callers. */
	readonly people: readonly { readonly role: string; readonly slot: number }[];
	readonly buildings: readonly { readonly interiorId: number; readonly kind: string }[];
	readonly ground?: ObtainableGround;
	/**
	 * Whether the player has already emptied a container.
	 *
	 * Omitted means none have, which is the right default for an authoring-time
	 * check: a scenario is validated as it will first be played, not as some save
	 * happens to have left it.
	 */
	readonly emptied?: (interiorId: number, x: number, y: number) => boolean;
	readonly carried?: readonly string[];
	/**
	 * Items the scenario put somewhere by hand.
	 *
	 * Fifth source, and the one the other four cannot express: a placement is the
	 * whole point of naming a specific thing in a specific place, so an errand for it
	 * is the most likely errand a story writes. Without this the validator would
	 * refuse a fetch quest for the very item the scenario placed to be fetched.
	 *
	 * Not scoped to this site, deliberately. A placement is somewhere definite in a
	 * finite world and being sent across it is normal, which is the same reasoning
	 * `validate.ts` already applies to items authored conversations hand over.
	 */
	readonly placed?: readonly string[];
}

export function obtainableItems(input: ObtainableInput): string[] {
	const names = new Set<string>();

	for (const person of input.people) {
		const kind = tradeKind(person.role, input.goods);
		if (!kind) continue;
		for (const item of shopStock(input.seed, input.siteId, person.slot, kind, input.goods)) {
			names.add(item.name);
		}
	}

	// What is *in* the crates, not what a building of this kind could hold.
	//
	// Asking `itemsStoredIn(kind)` was the bug behind "I took a quest and cannot find
	// it": a barn can store timber, so timber was offered as fetchable, but whether
	// any barn container actually rolled timber is a separate throw of the dice.
	// Contents are pure, so the real answer is available for the asking.
	for (const building of input.buildings) {
		const interior = getInterior(input.seed, building.interiorId, building.kind as StructureKind);
		for (let y = 0; y < interior.height; y++) {
			for (let x = 0; x < interior.width; x++) {
				const decor = interior.decor[y * interior.width + x] ?? 0;
				if (!isContainer(decor)) continue;
				if (input.emptied?.(building.interiorId, x, y)) continue;
				for (const item of containerContents(
					input.seed,
					building.interiorId,
					x,
					y,
					decor,
					building.kind,
					0,
					input.goods,
				)) {
					names.add(item.name);
				}
			}
		}
	}

	if (input.ground) for (const name of groundYields(input.ground, input.goods)) names.add(name);
	for (const placed of input.placed ?? []) names.add(placed);
	for (const carried of input.carried ?? []) names.add(carried);

	return [...names];
}

/**
 * Everything the land immediately around a settlement can be gathered for.
 *
 * Reaches past the town's own footprint, because "the crops near the forest" is
 * exactly the sort of errand somebody gives and the forest is rarely inside the
 * walls. Sampled rather than walked tile by tile: this only needs to know which
 * *kinds* of ground are present, and a stride of three cannot miss a patch of crops
 * or a stretch of forest floor while costing a ninth as many reads.
 */
function groundYields(ground: ObtainableGround, goods: GoodsTables): Set<string> {
	const names = new Set<string>();
	const reach = ground.radius + FORAGE_MARGIN;
	for (let y = ground.centre.y - reach; y <= ground.centre.y + reach; y += FORAGE_STRIDE) {
		for (let x = ground.centre.x - reach; x <= ground.centre.x + reach; x += FORAGE_STRIDE) {
			const terrain = ground.terrainAt(x, y);
			if (terrain === undefined || !isForageable(terrain, goods)) continue;
			for (const name of forageYields(terrain, goods)) names.add(name);
		}
	}
	return names;
}
