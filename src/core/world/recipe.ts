import type { StructureKind } from "../gen/features/patch.js";
import { T, type TerrainId } from "../tiles/terrain.js";
import { type BiomeDef, type BiomeId, DEFAULT_BIOME_TABLE } from "./biome-table.js";
import type { BoundaryStyle } from "./bounds.js";
import { CHUNK } from "./coords.js";
import type { SiteKind } from "./macro.js";

/**
 * What a scenario gets to say about how its world is generated.
 *
 * Until now a scenario could pin a seed and nothing else, which made "control the
 * generation" a contradiction in terms: the seed *is* the generation, and the only
 * lever an author had was to roll it again and look at what came out. A recipe is
 * the other half — the constants the generator used to hold as module-level
 * literals, lifted into data an author can write down.
 *
 * Two rules keep this from breaking the thing that makes the generator work.
 *
 * **A recipe is world-constant.** Every field below is fixed for the whole world;
 * nothing here is per-chunk, and nothing here can be looked up by chunk. That is
 * what preserves the seam contract — a tile stays a pure function of
 * `(seed, recipe, worldX, worldY)`, and since the recipe does not vary with
 * position-of-the-observer, two chunks computing the same tile still agree.
 *
 * **Zones are smooth.** The one obviously-local knob an author wants — *make the
 * forest thick near this town* — is expressed as a radial field with a falloff
 * rather than as a rectangle of override. `fields.ts` warns that per-chunk
 * influence puts a hard discontinuity at a chunk edge that no blending can hide;
 * a sum of smooth radial fields has no discontinuity anywhere, so it can be
 * evaluated inside the pure field functions with nothing to reconcile.
 *
 * Every default reproduces the constant it replaced exactly, so an absent recipe
 * generates byte-identical terrain to the generator before recipes existed.
 */
export interface WorldRecipe {
	readonly climate?: ClimateRecipe;
	readonly biomes?: BiomeOverrides;
	readonly sites?: SiteRecipe;
	readonly places?: readonly PlaceRecipe[];
	readonly zones?: readonly ZoneRecipe[];
	readonly bounds?: BoundsRecipe;
}

/**
 * What the edge of a bounded world is made of.
 *
 * The survey picks a style from the ground it finds — ocean where the rim is wet,
 * cliffs otherwise — which is a good default and was the only answer available.
 * `mountains` existed in {@link BoundaryStyle} from the beginning and was unreachable,
 * because nothing ever chose it: a world ringed in ice could not ask to be.
 *
 * Saying nothing keeps the survey's choice, so this is purely an override and no
 * existing world moves.
 */
export interface BoundsRecipe {
	readonly style?: BoundaryStyle;
}

/**
 * The shape of the world before anything is built on it.
 *
 * These move coastlines and mountain ranges, so they move where towns can be, where
 * roads can run and which biomes exist at all. A scenario that wants an archipelago
 * or a highland plateau changes the world here rather than hunting for a seed that
 * happened to produce one.
 */
export interface ClimateRecipe {
	/** Below this elevation is sea. Raising it drowns the map. */
	readonly seaLevel?: number;
	readonly shoreLevel?: number;
	readonly uplandLevel?: number;
	readonly alpineLevel?: number;
	/** Added to the raw elevation field. Positive means more land than ocean. */
	readonly elevationBias?: number;
	/** World units per noise unit: larger means broader continents. */
	readonly elevationScale?: number;
	readonly moistureBias?: number;
	readonly moistureScale?: number;
	readonly temperatureBias?: number;
	readonly temperatureScale?: number;
	/** Tiles from equator to pole. Wider means the player feels one climate. */
	readonly latitudeBand?: number;
	readonly roughnessScale?: number;
}

/**
 * What a biome is made of, per biome, as overrides on the built-in table.
 *
 * Partial by design: an author who wants denser woodland says `{ forest: {
 * scatterDensity: 0.8 } }` and inherits the ground, the scatter table and the rest.
 * Replacing a whole biome definition to change one number is how these files grow
 * to a thousand lines of copied defaults.
 */
export type BiomeOverrides = Partial<Record<BiomeId, BiomeOverride>>;

export interface BiomeOverride {
	readonly name?: string;
	readonly ground?: TerrainId;
	readonly groundAlt?: TerrainId;
	readonly scatterDensity?: number;
	readonly scatter?: readonly (readonly [TerrainId, number])[];
	readonly habitable?: boolean;
}

/** How thickly the world is settled, and with what. */
export interface SiteRecipe {
	/**
	 * Percentage of habitable macro cells carrying each kind of site.
	 *
	 * Percentages rather than relative weights, because the interesting number is
	 * *how much of the map is empty* and that only exists if the weights are
	 * absolute. They are consumed in a fixed order from the top of the roll, so the
	 * defaults reproduce the old threshold ladder exactly.
	 */
	readonly weights?: Partial<Record<SettledKind, number>>;
	/** The same, for ground too steep or too wild to live on. */
	readonly wildWeights?: Partial<Record<SettledKind, number>>;
	/** Footprint radius: `base + perImportance * importance`. */
	readonly radius?: Partial<Record<SettledKind, RadiusRule>>;
	/** Upper bound on the 1..n importance roll. */
	readonly maxImportance?: number;
	/** Below this civilization value, only ruins and landmarks appear. */
	readonly civilizationFloor?: number;
	/** Above this slope, likewise. */
	readonly maxSlope?: number;
	/**
	 * What each kind of settlement is built out of, when nobody has written it down.
	 *
	 * This is the table that decides what every unauthored place in the world is made
	 * of, and until it lived here there was no way to say anything about it: a pack
	 * could rename the smith and rewrite what he talked about, and every hamlet was
	 * still fourteen houses to eight farmhouses to four barns. A pack-swapped world
	 * read as the same world with different labels on it.
	 *
	 * It belongs to the *recipe* rather than to the content pack, and the reason is
	 * mechanical rather than editorial. A roster changes what the generator builds, and
	 * `generateFeature` caches patches under {@link worldKey} — the seed and the recipe
	 * and nothing else. A roster carried by the pack would be a town generated under one
	 * pack and served, from cache, to a world opened under another. The recipe is
	 * already hashed into that key, so putting it here makes the cache correct for free
	 * instead of making it an argument. A pack that wants a say ships a recipe fragment,
	 * which is folded in before the world is resolved.
	 */
	readonly roster?: Partial<Record<SettledKind, RosterRule>>;
	/**
	 * What the routes between sites are surfaced with.
	 *
	 * Roads are the only thing in the world that is a *line* rather than a scatter or a
	 * footprint: the MST between settlements is laid down tile by tile, and until this
	 * existed the two terrains it laid were literals in the chunk pipeline. So a world
	 * could re-ground every biome it had and still have cobbles running through the
	 * desert — and a rail line, which is a route and nothing else, could not be expressed
	 * at all. A scatter table can put rails on the map; only this can put them in a line.
	 *
	 * `major` is the route between two important places and `minor` is everything else,
	 * which is the distinction the pipeline already drew.
	 */
	readonly roads?: RoadRecipe;
	/**
	 * What fills a plot nobody asked for.
	 *
	 * Separate from {@link roster} because it is consulted for a different reason: a
	 * settlement whose spec named fewer structures than the ground had room for. Filling
	 * from the site's own roster would arguably be better — a fort padded with barracks
	 * rather than with cottages — but it is a change to what every world generates, so it
	 * is a decision for an author to write down rather than one to make on their behalf.
	 */
	readonly filler?: readonly (readonly [StructureKind, number])[];
}

/**
 * One kind of settlement, as a recipe writes it.
 *
 * The three questions `fallback-spec.ts` used to answer with a table, a switch and an
 * expression: how many buildings, whether there is a wall round them, and what they are.
 */
export interface RosterRule {
	/**
	 * How many structures: `base + floor(perImportance * importance)`.
	 *
	 * A formula rather than a flat number because importance is what separates a
	 * hamlet of four cottages from one of six, and expressing that as a rule keeps the
	 * shape of the old `switch` — where a town grew by one building per point and a
	 * village by one per two — instead of flattening it away.
	 */
	readonly count: { readonly base: number; readonly perImportance?: number };
	/**
	 * Whether a wall goes round it. A number means "at this importance and above".
	 *
	 * A fort is walled because it is a fort; a town is walled once it is big enough to
	 * be worth walling. Those are two different statements and the type says so.
	 */
	readonly walled?: boolean | number;
	/** Weighted, and drawn from with replacement: `[kind, weight]`. */
	readonly structures: readonly (readonly [StructureKind, number])[];
}

export interface RoadRecipe {
	readonly major?: TerrainId;
	readonly minor?: TerrainId;
}

/** Every site kind except `none`, which is the absence of one. */
export type SettledKind = Exclude<SiteKind, "none">;

export interface RadiusRule {
	readonly base: number;
	readonly perImportance?: number;
}

/**
 * A site the author puts somewhere specific.
 *
 * Consulted before the procedural roll, keyed by the macro cell the position falls
 * in — so an authored place *replaces* whatever that cell would have rolled rather
 * than being added beside it. Everything downstream is unchanged: the site id is
 * still `hash32(seed, …, mx, my)`, so a `SiteSpec` written against an authored
 * place keys exactly as one written against a rolled site, and roads, rivers and
 * the halo see it like any other.
 */
export interface PlaceRecipe {
	readonly at: { readonly x: number; readonly y: number };
	readonly kind: SettledKind;
	/** 1..5. Defaults to the middle. */
	readonly importance?: number;
	/** Overrides the radius the kind and importance would give. */
	readonly radius?: number;
}

/**
 * A smooth radial influence on the fields, centred somewhere.
 *
 * This is the "thick forest near Harrowmere" mechanism, and the shape is not
 * incidental. Effects are deltas and multipliers weighted by a smoothstep falloff,
 * summed over every zone, so the influence is continuous everywhere and zero
 * outside the radius — which means it can live inside the pure field functions
 * without introducing an edge for two chunks to disagree about.
 *
 * Deliberately no elevation effect. Elevation decides where the sea is, where
 * towns may stand and where roads may run, and a local bump would move a coastline
 * under a settlement that had already been placed against the unbumped field.
 * Moisture and temperature only reach biome classification and weather, which is
 * where an author's "make this stretch wetter" belongs.
 */
export interface ZoneRecipe {
	readonly id?: string;
	readonly at: { readonly x: number; readonly y: number };
	readonly radius: number;
	/**
	 * Falloff sharpness. 1 is a soft smoothstep across the whole radius, larger
	 * concentrates the effect near the centre.
	 */
	readonly falloff?: number;
	readonly moisture?: number;
	readonly temperature?: number;
	/** Multiplies the biome's scatter density: 2 is twice as many trees. */
	readonly scatter?: number;
}

/**
 * Lay one recipe over another.
 *
 * This exists for exactly one caller: a content pack that ships a recipe fragment. A
 * pack is the natural place to say what a world is *made of* — a Camelot pack knows its
 * villages are longhouses — but a roster changes what the generator builds, and a pack
 * cannot be allowed near that at *runtime* because {@link worldKey} does not carry it.
 * So the fragment is folded in here, once, before the world is resolved: from that point
 * on it is part of the recipe, it hashes into the key like everything else, and it is
 * persisted into the artifact. A scenario built with a pack replays correctly even if the
 * pack is gone, because the part of it that shaped the map is no longer in the pack.
 *
 * The scenario wins over the pack, section by section. A scenario that names a pack and
 * then says something itself is correcting the pack, not being overridden by it.
 *
 * Maps merge by key and lists replace, the same two rules `mergePack` documents at
 * length: an author who rewrites the village roster expects the hamlet's to survive, and
 * one who writes `places` means these are the places.
 */
export function mergeRecipe(
	base: WorldRecipe | undefined,
	over: WorldRecipe | undefined,
): WorldRecipe | undefined {
	if (!base) return over;
	if (!over) return base;

	const sites =
		base.sites || over.sites
			? {
					...base.sites,
					...stripUndefined(over.sites),
					...(base.sites?.weights || over.sites?.weights
						? { weights: { ...base.sites?.weights, ...over.sites?.weights } }
						: {}),
					...(base.sites?.wildWeights || over.sites?.wildWeights
						? { wildWeights: { ...base.sites?.wildWeights, ...over.sites?.wildWeights } }
						: {}),
					...(base.sites?.radius || over.sites?.radius
						? { radius: { ...base.sites?.radius, ...over.sites?.radius } }
						: {}),
					...(base.sites?.roster || over.sites?.roster
						? { roster: { ...base.sites?.roster, ...over.sites?.roster } }
						: {}),
					...(base.sites?.roads || over.sites?.roads
						? { roads: { ...base.sites?.roads, ...stripUndefined(over.sites?.roads) } }
						: {}),
				}
			: undefined;

	return {
		...(base.climate || over.climate
			? { climate: { ...base.climate, ...stripUndefined(over.climate) } }
			: {}),
		...(base.biomes || over.biomes ? { biomes: { ...base.biomes, ...over.biomes } } : {}),
		...(sites ? { sites } : {}),
		...((over.places ?? base.places) ? { places: over.places ?? base.places } : {}),
		...((over.zones ?? base.zones) ? { zones: over.zones ?? base.zones } : {}),
		...(base.bounds || over.bounds
			? { bounds: { ...base.bounds, ...stripUndefined(over.bounds) } }
			: {}),
	};
}

// --- resolved ---------------------------------------------------------------

/**
 * A recipe with every default filled in.
 *
 * Separate from {@link WorldRecipe} so the generator never writes `?? 0.42` in a
 * hot loop and never has to remember which default belongs to which field. Built
 * once when a world opens.
 */
export interface WorldRules {
	/**
	 * Identifies these rules for cache keys, derived from the recipe they came from.
	 *
	 * Every generation cache — road routes, river traces, settlement patches — used to
	 * key on the seed, because the seed was the whole of a world's identity. It is not
	 * any more: two scenarios can share a seed and differ in their recipe, and serving
	 * one's cached town to the other would be a silent, unreproducible corruption. This
	 * is the second half of the key. `"d"` for the unconfigured rules, so an ordinary
	 * world's keys stay short and readable in a debugger.
	 */
	readonly key: string;
	readonly climate: Required<ClimateRecipe>;
	readonly biomes: Readonly<Record<BiomeId, BiomeDef>>;
	readonly sites: ResolvedSites;
	/** Authored sites by macro cell key, `${mx},${my}`. */
	readonly places: ReadonlyMap<string, PlaceRecipe>;
	readonly zones: readonly ZoneRecipe[];
	/** True when no zone can affect anything, so the field functions can skip them. */
	readonly flatFields: boolean;
	/**
	 * What the edge is, when the world says rather than the survey deciding.
	 *
	 * Left undefined rather than defaulted, and that is the whole of the contract: the
	 * survey's answer depends on the ground it samples, so there is no constant that
	 * could stand in for "whatever suits the rim" — a default here would silently
	 * replace the ground-following choice with a fixed one in every world at once.
	 */
	readonly bounds: BoundsRecipe;
}

export interface ResolvedSites {
	/** Kinds in roll order with their cumulative thresholds, settled ground. */
	readonly settled: readonly (readonly [SettledKind, number])[];
	/** The same, for wild ground. */
	readonly wild: readonly (readonly [SettledKind, number])[];
	readonly radius: Readonly<Record<SettledKind, RadiusRule>>;
	readonly maxImportance: number;
	readonly civilizationFloor: number;
	readonly maxSlope: number;
	readonly roster: Readonly<Record<SettledKind, RosterRule>>;
	readonly filler: readonly (readonly [StructureKind, number])[];
	readonly roads: Required<RoadRecipe>;
}

/**
 * A world's identity: the seed *and* the rules derived from it.
 *
 * One value rather than two arguments because they are one fact. Terrain used to be
 * a function of the seed alone, so passing a bare number was honest; now it is a
 * function of the seed and the recipe, and any code path that carried only the
 * number would generate a *different world* while looking like it agreed. Bundling
 * them makes that a type error instead of a seam.
 */
export interface WorldSeed {
	readonly seed: number;
	readonly rules: WorldRules;
}

const DEFAULT_CLIMATE: Required<ClimateRecipe> = {
	seaLevel: 0.42,
	shoreLevel: 0.46,
	uplandLevel: 0.66,
	alpineLevel: 0.8,
	elevationBias: 0.12,
	elevationScale: 240,
	moistureBias: 0,
	moistureScale: 170,
	temperatureBias: 0,
	temperatureScale: 400,
	latitudeBand: 8192,
	roughnessScale: 40,
};

/**
 * Percentage of habitable macro cells carrying each kind.
 *
 * These are the old threshold ladder read as gaps: `roll > 0.985` was town, and
 * `1 - 0.985` is 1.5%. Consumed in this order from 1.0 downward, they reproduce the
 * ladder exactly — which is what lets the generation goldens stay green through a
 * change that rewrote how the decision is made.
 */
const DEFAULT_WEIGHTS: Record<SettledKind, number> = {
	town: 1.5,
	village: 2.5,
	fort: 1.5,
	hamlet: 4.5,
	camp: 3,
	ruins: 2.5,
	landmark: 2.5,
	cave: 0,
	castle: 0,
	docks: 0,
};

/** Uninhabitable ground still gets ruins and landmarks; nothing else. */
const DEFAULT_WILD_WEIGHTS: Record<SettledKind, number> = {
	town: 0,
	village: 0,
	fort: 0,
	hamlet: 0,
	camp: 0,
	ruins: 6,
	landmark: 6,
	cave: 0,
	castle: 0,
	docks: 0,
};

const DEFAULT_RADIUS: Record<SettledKind, RadiusRule> = {
	town: { base: 20, perImportance: 3 },
	village: { base: 14, perImportance: 2 },
	fort: { base: 13, perImportance: 1 },
	hamlet: { base: 9, perImportance: 1 },
	ruins: { base: 10, perImportance: 1 },
	camp: { base: 6 },
	landmark: { base: 4 },
	castle: { base: 18, perImportance: 2 },
	docks: { base: 12, perImportance: 1 },
	cave: { base: 6 },
};

/**
 * What a settlement is made of, before a recipe has its say.
 *
 * Lifted verbatim out of `fallback-spec.ts`, weights and counts both, so a world with
 * no recipe generates the settlements it always did. The `count` formulas are the old
 * `structureCount` switch read back as arithmetic: `floor(1 * importance)` is the town's
 * `+ importance` and `floor(0.5 * importance)` is the village's `+ importance / 2`.
 *
 * A cave is a mouth and a volume behind it. Nothing is built on the surface, so its
 * roster is empty and the feature's own generator does all the work.
 */
const DEFAULT_ROSTER: Record<SettledKind, RosterRule> = {
	town: {
		count: { base: 9, perImportance: 1 },
		walled: 4,
		structures: [
			["inn", 10],
			["shop", 9],
			["smithy", 7],
			["temple", 5],
			["apothecary", 4],
			["warehouse", 4],
			["stable", 3],
			["house", 14],
		],
	},
	village: {
		count: { base: 6, perImportance: 0.5 },
		structures: [
			["inn", 7],
			["shop", 6],
			["smithy", 5],
			["mill", 3],
			["house", 14],
			["farmhouse", 6],
		],
	},
	hamlet: {
		count: { base: 3, perImportance: 0.5 },
		structures: [
			["house", 14],
			["farmhouse", 8],
			["barn", 4],
			["shop", 2],
		],
	},
	fort: {
		count: { base: 4, perImportance: 0.5 },
		walled: true,
		structures: [
			["barracks", 8],
			["tower", 6],
			["smithy", 4],
			["stable", 3],
			["warehouse", 3],
		],
	},
	camp: {
		count: { base: 2 },
		structures: [
			["house", 4],
			["stable", 1],
		],
	},
	ruins: { count: { base: 3 }, structures: [["ruin", 10]] },
	landmark: { count: { base: 1 }, structures: [["shrine", 1]] },
	castle: {
		count: { base: 5, perImportance: 1 },
		structures: [
			["barracks", 8],
			["tower", 7],
			["smithy", 3],
			["stable", 3],
			["warehouse", 3],
			["temple", 2],
		],
	},
	docks: {
		count: { base: 4, perImportance: 0.5 },
		structures: [
			["warehouse", 8],
			["inn", 4],
			["shop", 3],
			["house", 6],
		],
	},
	cave: { count: { base: 0 }, structures: [] },
};

/** Weighted filler used when a spec has fewer structures than there are plots. */
const DEFAULT_FILLER: readonly (readonly [StructureKind, number])[] = [
	["house", 10],
	["farmhouse", 3],
	["barn", 2],
	["stable", 1],
	["warehouse", 1],
];

/**
 * The order kinds are consumed from the roll.
 *
 * Fixed rather than derived from the weights object, because object key order is a
 * property of how a JSON file happened to be written and this decides what the
 * world looks like. Rarest first, so raising a common kind's weight cannot silently
 * push a rare one off the end of the roll.
 */
const ROLL_ORDER: readonly SettledKind[] = [
	"town",
	"castle",
	"village",
	"fort",
	"docks",
	"hamlet",
	"camp",
	"ruins",
	"cave",
	"landmark",
];

/**
 * Cumulative thresholds down from 1.0, in roll order.
 *
 * Written as `(100 - consumed) / 100` rather than as repeated subtraction of
 * `percent / 100`, and the shape is load-bearing to the last bit. Subtracting step by
 * step drifts (`0.9` came out `0.8999999999999999`); subtracting once and then
 * dividing still lands a ulp off the decimal literal (`1 - 0.18` is not `0.82`).
 * Doing all the arithmetic in whole percent and dividing last reproduces exactly the
 * literals the old chain of `if (roll > 0.82)` compared against — and a threshold one
 * ulp out is a macro cell somewhere in the world that rolls a hamlet where it used to
 * roll nothing.
 */
function ladder(weights: Partial<Record<SettledKind, number>>): (readonly [SettledKind, number])[] {
	const steps: (readonly [SettledKind, number])[] = [];
	let consumed = 0;
	for (const kind of ROLL_ORDER) {
		const percent = weights[kind] ?? 0;
		if (percent <= 0) continue;
		consumed += percent;
		steps.push([kind, (100 - consumed) / 100]);
	}
	return steps;
}

export function resolveRecipe(recipe?: WorldRecipe): WorldRules {
	const climate = { ...DEFAULT_CLIMATE, ...stripUndefined(recipe?.climate) };

	const biomes = {} as Record<BiomeId, BiomeDef>;
	for (const id of Object.keys(DEFAULT_BIOME_TABLE) as BiomeId[]) {
		const base = DEFAULT_BIOME_TABLE[id];
		const override = recipe?.biomes?.[id];
		biomes[id] = override ? { ...base, ...stripUndefined(override) } : base;
	}

	const sites: ResolvedSites = {
		settled: ladder({ ...DEFAULT_WEIGHTS, ...stripUndefined(recipe?.sites?.weights) }),
		wild: ladder({ ...DEFAULT_WILD_WEIGHTS, ...stripUndefined(recipe?.sites?.wildWeights) }),
		radius: { ...DEFAULT_RADIUS, ...stripUndefined(recipe?.sites?.radius) },
		maxImportance: recipe?.sites?.maxImportance ?? 5,
		civilizationFloor: recipe?.sites?.civilizationFloor ?? 0.16,
		maxSlope: recipe?.sites?.maxSlope ?? 0.035,
		// Merged per kind rather than per field: an author who rewrites the village is
		// saying what a village is, not adjusting one number about it, and inheriting
		// half the default village's structures under their own count would produce a
		// place neither of them described.
		roster: { ...DEFAULT_ROSTER, ...stripUndefined(recipe?.sites?.roster) },
		filler: recipe?.sites?.filler ?? DEFAULT_FILLER,
		roads: {
			major: recipe?.sites?.roads?.major ?? T.cobbleRoad,
			minor: recipe?.sites?.roads?.minor ?? T.dirtRoad,
		},
	};

	const places = new Map<string, PlaceRecipe>();
	for (const place of recipe?.places ?? []) {
		places.set(macroKeyFor(place.at.x, place.at.y), place);
	}

	const zones = (recipe?.zones ?? []).filter((zone) => zone.radius > 0);
	const flatFields = zones.every((zone) => !zone.moisture && !zone.temperature);

	return {
		key: recipeKey(recipe),
		climate,
		biomes,
		sites,
		places,
		zones,
		flatFields,
		bounds: { ...stripUndefined(recipe?.bounds) },
	};
}

/**
 * A short stable name for a recipe.
 *
 * Hashed from the recipe as written rather than from the resolved rules, so
 * resolving the same scenario twice — the session does it once, the validator
 * again — produces the same key and shares the caches instead of doubling them.
 */
function recipeKey(recipe?: WorldRecipe): string {
	if (!recipe) return "d";
	const text = JSON.stringify(recipe);
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

/** How a generation cache names a world: the seed and the recipe together. */
export function worldKey(world: WorldSeed): string {
	return `${world.seed}:${world.rules.key}`;
}

/** The rules an unconfigured world runs on — every constant the generator used to hold. */
export const DEFAULT_RULES: WorldRules = resolveRecipe();

/**
 * Resolved rules per recipe object, so repeated lookups are free.
 *
 * `worldSeed` is called wherever a `WorldMeta` is in hand rather than being threaded
 * from one place, which is the difference between a change that touches five files
 * and one that touches fifty. Memoising on the recipe's identity is what makes that
 * affordable: resolving builds a biome table and a place index, and doing it on the
 * movement path would be absurd.
 */
const resolved = new WeakMap<WorldRecipe, WorldRules>();

/** The world a seed and an optional recipe describe. */
export function worldSeed(seed: number, recipe?: WorldRecipe): WorldSeed {
	if (!recipe) return { seed, rules: DEFAULT_RULES };
	let rules = resolved.get(recipe);
	if (!rules) {
		rules = resolveRecipe(recipe);
		resolved.set(recipe, rules);
	}
	return { seed, rules };
}

/**
 * Total influence of every zone at a position, per effect.
 *
 * Summed rather than maximised, so two overlapping zones compound the way an author
 * writing both of them would expect. Weights use a smoothstep on the distance so the
 * influence and its first derivative both reach zero at the radius: a linear falloff
 * leaves a visible ring where the gradient changes, which reads as a crop circle.
 */
export function zoneInfluence(
	rules: WorldRules,
	x: number,
	y: number,
): { moisture: number; temperature: number; scatter: number } {
	let moisture = 0;
	let temperature = 0;
	let scatter = 1;
	for (const zone of rules.zones) {
		const distance = Math.hypot(x - zone.at.x, y - zone.at.y);
		if (distance >= zone.radius) continue;
		const t = 1 - distance / zone.radius;
		const smooth = t * t * (3 - 2 * t);
		const weight = zone.falloff && zone.falloff !== 1 ? smooth ** zone.falloff : smooth;
		if (zone.moisture) moisture += zone.moisture * weight;
		if (zone.temperature) temperature += zone.temperature * weight;
		// Interpolated from 1 rather than multiplied outright, so the effect fades to
		// "no change" at the rim instead of snapping from the full multiplier to none.
		if (zone.scatter !== undefined) scatter *= 1 + (zone.scatter - 1) * weight;
	}
	return { moisture, temperature, scatter };
}

/** How much a zone multiplies scatter density here. 1 when nothing applies. */
export function zoneScatter(rules: WorldRules, x: number, y: number): number {
	if (rules.zones.length === 0) return 1;
	return zoneInfluence(rules, x, y).scatter;
}

function macroKeyFor(x: number, y: number): string {
	return placeKey(Math.floor(x / CHUNK), Math.floor(y / CHUNK));
}

/** How {@link WorldRules.places} is keyed: by macro cell, the way sites are. */
export function placeKey(mx: number, my: number): string {
	return `${mx},${my}`;
}

/**
 * Drop keys explicitly set to `undefined` before spreading.
 *
 * `{ ...defaults, ...{ seaLevel: undefined } }` produces `seaLevel: undefined`, which
 * type-checks against `Required<ClimateRecipe>` and then reads as `NaN` the first time
 * it is compared. JSON never produces that, but an object built in code with an
 * optional field routinely does.
 */
function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
	if (!value) return {};
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) out[key] = entry;
	}
	return out as Partial<T>;
}
