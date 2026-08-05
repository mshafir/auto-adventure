import { type BiomeId, biomeDef, classifyBiome } from "./biome.js";
import { elevationAt, elevationBand, moistureAt, temperatureAt } from "./fields.js";
import { isSettlement, MACRO, type MacroSite, macroSite, REGION } from "./macro.js";
import type { WorldSeed } from "./recipe.js";
import { riversAround } from "./rivers.js";
import { roadsAround } from "./roads.js";

/**
 * What the engine can tell the director about a place, computed *without*
 * generating a single chunk.
 *
 * This is the whole inversion in one function. The old design asked the model
 * to invent a location and then tried to reproduce it; here the location
 * already exists — its biome, its size, the roads that reach it, its
 * neighbours — and the model is handed the facts and asked to name and populate
 * them. Cheap enough to run for every site in the prefetch ring.
 */

export interface SiteContext {
	readonly siteId: number;
	readonly kind: MacroSite["kind"];
	readonly importance: number;
	readonly x: number;
	readonly y: number;
	readonly biome: BiomeId;
	readonly biomeName: string;
	readonly terrain: string;
	readonly roadCount: number;
	readonly nearRiver: boolean;
	readonly coastal: boolean;
	/** How many buildings the engine has room for. Caps the roster the LLM sends. */
	readonly buildingBudget: number;
	readonly neighbours: readonly { readonly kind: string; readonly bearing: string }[];
}

export interface RegionContext {
	readonly regionId: number;
	readonly biome: BiomeId;
	readonly biomeName: string;
	/** Biomes present across the region, most common first. */
	readonly biomes: readonly string[];
	readonly settlementKinds: readonly string[];
}

export function biomeAt(world: WorldSeed, x: number, y: number): BiomeId {
	const elevation = elevationAt(world, x, y);
	return classifyBiome(
		elevation,
		temperatureAt(world, x, y, elevation),
		moistureAt(world, x, y),
		world.rules,
	);
}

/** Rough building capacity of a site, mirroring what the plot pass can fit. */
export function buildingBudget(site: MacroSite): number {
	// A cave has nothing above ground; a castle's ward and a dock's row of sheds are
	// smaller than a town of the same radius, because most of the footprint is wall
	// and water respectively.
	if (site.kind === "cave") return 0;
	if (site.kind === "castle") return Math.max(3, Math.min(10, Math.round(site.radius / 3)));
	if (site.kind === "docks") return Math.max(2, Math.min(6, Math.round(site.radius / 4)));
	if (!isSettlement(site.kind)) return site.kind === "ruins" ? 3 : 1;
	const area = site.radius * site.radius * 1.9;
	return Math.max(2, Math.min(14, Math.round(area / 110)));
}

function bearingOf(dx: number, dy: number): string {
	const vertical = dy < 0 ? "north" : dy > 0 ? "south" : "";
	const horizontal = dx < 0 ? "west" : dx > 0 ? "east" : "";
	return `${vertical}${horizontal}` || "here";
}

export function siteContext(world: WorldSeed, site: MacroSite): SiteContext {
	const { x, y } = site.site;
	const elevation = elevationAt(world, x, y);
	const biome = biomeAt(world, x, y);

	const roads = roadsAround(world, site.mx, site.my).filter(
		(road) => road.from.id === site.id || road.to.id === site.id,
	);
	const rivers = riversAround(world, site.mx, site.my);
	const nearRiver = rivers.some((river) =>
		river.points.some((p) => Math.abs(p.x - x) < site.radius && Math.abs(p.y - y) < site.radius),
	);

	const neighbours: { kind: string; bearing: string }[] = [];
	for (let dy = -2; dy <= 2; dy++) {
		for (let dx = -2; dx <= 2; dx++) {
			if (dx === 0 && dy === 0) continue;
			const other = macroSite(world, site.mx + dx, site.my + dy);
			if (other.kind === "none") continue;
			neighbours.push({ kind: other.kind, bearing: bearingOf(dx, dy) });
		}
	}

	return {
		siteId: site.id,
		kind: site.kind,
		importance: site.importance,
		x,
		y,
		biome,
		biomeName: biomeDef(biome, world.rules).name,
		terrain: elevationBand(elevation, world.rules),
		roadCount: roads.length,
		nearRiver,
		coastal: elevation < world.rules.climate.seaLevel + 0.06,
		buildingBudget: buildingBudget(site),
		neighbours: neighbours.slice(0, 4),
	};
}

/** The region a position belongs to, sampled on a coarse lattice. */
export function regionContext(world: WorldSeed, regionId: number, at: { x: number; y: number }) {
	// Sample the region's own cell rather than an arbitrary radius, so two
	// positions in the same region always produce the same context.
	const rx = Math.floor(at.x / REGION) * REGION;
	const ry = Math.floor(at.y / REGION) * REGION;

	const counts = new Map<BiomeId, number>();
	const kinds = new Set<string>();
	const step = MACRO;
	for (let y = ry; y < ry + REGION; y += step) {
		for (let x = rx; x < rx + REGION; x += step) {
			const biome = biomeAt(world, x + step / 2, y + step / 2);
			counts.set(biome, (counts.get(biome) ?? 0) + 1);
			const site = macroSite(world, Math.floor(x / MACRO), Math.floor(y / MACRO));
			if (site.kind !== "none") kinds.add(site.kind);
		}
	}

	const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	const dominant = ordered[0]?.[0] ?? "grassland";

	const context: RegionContext = {
		regionId,
		biome: dominant,
		biomeName: biomeDef(dominant, world.rules).name,
		biomes: ordered.slice(0, 4).map(([id]) => biomeDef(id, world.rules).name),
		settlementKinds: [...kinds].sort(),
	};
	return context;
}
