import { DEFAULT_PACK } from "../../core/content/default.js";
import type { ContentPack } from "../../core/content/pack.js";
import { fallbackSettlementSpec } from "../../core/gen/features/fallback-spec.js";
import { rngFor } from "../../core/rand/rng.js";
import type { RegionContext, SiteContext } from "../../core/world/context.js";
import type { MacroSite } from "../../core/world/macro.js";
import { personName, placeName, regionName } from "../../core/world/names.js";
import type { WorldSeed } from "../../core/world/recipe.js";
import type { NpcSpec, RegionSpec, SiteSpec, WorldLore } from "../../core/world/spec.js";

/**
 * The world with no director.
 *
 * Not a stub: `--no-ai` and "your key stopped working" produce exactly this, and
 * it has to be a game rather than an error state. Every place gets a name, every
 * settlement gets a handful of people with roles and something to say. What it
 * lacks is a story tying them together — which is precisely what the LLM is for.
 */

export function fallbackLore(pack: ContentPack = DEFAULT_PACK): WorldLore {
	return pack.lore;
}

export function fallbackRegion(
	seed: number,
	context: RegionContext,
	pack: ContentPack = DEFAULT_PACK,
): RegionSpec {
	const name = regionName(seed, context.regionId, context.biome, pack);
	return {
		id: String(context.regionId),
		name,
		blurb: `${name} is ${context.biomeName.toLowerCase()} country, and keeps to itself.`,
		tone: "quiet",
		culture: "smallholders and road-traders",
		lore: [],
		// The first line names the landscape, so it is worth composing rather than
		// quoting; the rest come from the pack, where a scenario can set its own.
		ambient: [`The wind moves across the ${context.biomeName.toLowerCase()}.`, ...pack.ambient],
	};
}

export function fallbackSite(
	world: WorldSeed,
	site: MacroSite,
	context: SiteContext,
	pack: ContentPack = DEFAULT_PACK,
): SiteSpec {
	const seed = world.seed;
	const settlement = fallbackSettlementSpec(world, site);
	const name = placeName(seed, site.id, site.kind, context.biome, pack);
	const rng = rngFor(seed, "fallback-npcs", site.mx, site.my);

	// One NPC per notable structure, then a couple of people in the square, up to
	// a cap that keeps a hamlet from feeling like a city.
	const cap = site.kind === "town" ? 5 : site.kind === "village" ? 4 : site.kind === "camp" ? 1 : 2;
	const npcs: NpcSpec[] = [];
	const seen = new Set<string>();

	for (const structure of settlement.structures) {
		if (npcs.length >= cap) break;
		const outdoor = pack.outdoorRoles[structure.kind];
		if (!outdoor || seen.has(outdoor.role)) continue;
		seen.add(outdoor.role);
		npcs.push(makeNpc(seed, site, npcs.length, outdoor.role, outdoor.placement, pack));
	}
	const wanderers = pack.wanderers;
	while (npcs.length < Math.min(cap, 2) && wanderers.length > 0) {
		const chosen = wanderers[rng.int(wanderers.length)] ?? wanderers[0];
		if (!chosen) break;
		if (seen.has(chosen.role)) {
			// Only a handful of wanderers exist; stop rather than loop forever.
			if (seen.size >= wanderers.length) break;
			continue;
		}
		seen.add(chosen.role);
		npcs.push(makeNpc(seed, site, npcs.length, chosen.role, chosen.placement, pack));
	}

	return {
		siteId: site.id,
		name,
		shortName: name.split(" ")[0] ?? name,
		description: `A ${site.kind} of ${context.biomeName.toLowerCase()}, ${
			context.roadCount > 1 ? "where two roads meet" : "at the end of a road"
		}.`,
		settlement: { ...settlement, name },
		npcs,
		hooks: [],
	};
}

function makeNpc(
	seed: number,
	site: MacroSite,
	slot: number,
	role: string,
	placement: string,
	pack: ContentPack,
): NpcSpec {
	return {
		slot,
		name: personName(seed, site.id, slot, pack),
		role,
		glyph: (role[0] ?? "p").toUpperCase(),
		appearance: `A ${role}, dressed for the work and the weather.`,
		persona: `Plainspoken. Talks about the ${role === "guard" ? "road" : "trade"} and little else.`,
		disposition: 0,
		// A pack supplies placements as plain strings; an anchor kind the generator
		// does not emit falls back to a doorstep rather than leaving somebody nowhere.
		placement: placement as NpcSpec["placement"],
		knows: [],
	};
}
