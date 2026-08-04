import { type Rng, rngFor } from "../../rand/rng.js";
import type { MacroSite, SiteKind } from "../../world/macro.js";
import type { StructureKind } from "./patch.js";
import type { SettlementSpec, StructureSpec } from "./settlement.js";

/**
 * The settlement a place has when no LLM has described it.
 *
 * Every field the director can supply has a deterministic default here, which
 * is what lets the whole world be generated, played and tested offline. It is
 * also the value committed permanently when a director call fails, so a network
 * problem produces a plain village rather than a hole in the map.
 */
const ROSTER: Readonly<Record<SiteKind, readonly (readonly [StructureKind, number])[]>> = {
	town: [
		["inn", 10],
		["shop", 9],
		["smithy", 7],
		["temple", 5],
		["apothecary", 4],
		["warehouse", 4],
		["stable", 3],
		["house", 14],
	],
	village: [
		["inn", 7],
		["shop", 6],
		["smithy", 5],
		["mill", 3],
		["house", 14],
		["farmhouse", 6],
	],
	hamlet: [
		["house", 14],
		["farmhouse", 8],
		["barn", 4],
		["shop", 2],
	],
	fort: [
		["barracks", 8],
		["tower", 6],
		["smithy", 4],
		["stable", 3],
		["warehouse", 3],
	],
	camp: [
		["house", 4],
		["stable", 1],
	],
	ruins: [["ruin", 10]],
	landmark: [["shrine", 1]],
	none: [],
};

const SIZE_BY_KIND: Readonly<Partial<Record<StructureKind, "small" | "medium" | "large">>> = {
	temple: "large",
	barracks: "large",
	warehouse: "large",
	barn: "large",
	inn: "medium",
	smithy: "medium",
	shop: "medium",
	mill: "medium",
	tower: "small",
};

const IMPORTANCE_BY_KIND: Readonly<Partial<Record<StructureKind, number>>> = {
	temple: 5,
	inn: 5,
	barracks: 5,
	smithy: 4,
	shop: 4,
	apothecary: 4,
	mill: 3,
	tower: 3,
	warehouse: 2,
	stable: 2,
	barn: 2,
	farmhouse: 1,
	house: 1,
};

function structureCount(site: MacroSite): number {
	switch (site.kind) {
		case "town":
			return 9 + site.importance;
		case "village":
			return 6 + Math.floor(site.importance / 2);
		case "fort":
			return 4 + Math.floor(site.importance / 2);
		case "hamlet":
			return 3 + Math.floor(site.importance / 2);
		case "camp":
			return 2;
		case "ruins":
			return 3;
		case "landmark":
			return 1;
		case "none":
			return 0;
	}
}

function pick(rng: Rng, table: readonly (readonly [StructureKind, number])[]): StructureKind {
	if (table.length === 0) return "house";
	const index = rng.weighted(table.map(([, weight]) => weight));
	return table[index]?.[0] ?? "house";
}

export function fallbackSettlementSpec(seed: number, site: MacroSite): SettlementSpec {
	const rng = rngFor(seed, "fallback-spec", site.mx, site.my);
	const table = ROSTER[site.kind];
	const count = structureCount(site);

	const structures: StructureSpec[] = [];
	for (let i = 0; i < count; i++) {
		const kind = pick(rng, table);
		structures.push({
			kind,
			size: SIZE_BY_KIND[kind] ?? "small",
			importance: IMPORTANCE_BY_KIND[kind] ?? 1,
		});
	}

	return {
		walled: site.kind === "fort" || (site.kind === "town" && site.importance >= 4),
		structures,
	};
}
