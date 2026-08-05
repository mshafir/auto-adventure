import { MODELS } from "../../config.js";
import { DEFAULT_PACK } from "../../core/content/default.js";
import type { ContentPack } from "../../core/content/pack.js";
import type { SettlementSpec } from "../../core/gen/features/settlement.js";
import type { ScenarioBrief } from "../../core/world/brief.js";
import { regionContext, siteContext } from "../../core/world/context.js";
import type { ChunkCoord } from "../../core/world/coords.js";
import { HALO } from "../../core/world/coords.js";
import { isSettlement, type MacroSite, sitesAround } from "../../core/world/macro.js";
import type { WorldSeed } from "../../core/world/recipe.js";
import type { RegionSpec, SiteSpec, SpecSource, WorldLore } from "../../core/world/spec.js";
import { logger } from "../../utils/log.js";
import { aiAvailable, structured } from "../client.js";
import { fallbackLore, fallbackRegion, fallbackSite } from "./fallback.js";
import {
	LORE_SYSTEM,
	lorePrompt,
	REGION_SYSTEM,
	regionPrompt,
	SITE_SYSTEM,
	sitePrompt,
} from "./prompt.js";
import { RegionSpecSchema, SiteSpecSchema, WorldLoreSchema } from "./schemas.js";

export interface DirectorOptions {
	readonly world: WorldSeed;
	/**
	 * What the player asked this world to be about. Steers every authoring call.
	 * Absent means the default premise, which is what every world before briefs
	 * existed had.
	 */
	readonly brief?: ScenarioBrief;
	/** Specs already known from the save. */
	readonly lore?: WorldLore;
	readonly regions?: Readonly<Record<string, RegionSpec>>;
	readonly sites?: Readonly<Record<string, SiteSpec>>;
	readonly sources?: Readonly<Record<string, SpecSource>>;
	/** Persist newly-learned content. */
	readonly onLore: (lore: WorldLore) => void;
	readonly onRegion: (spec: RegionSpec) => void;
	readonly onSite: (spec: SiteSpec, source: SpecSource) => void;
	/** A site's layout changed and its chunks must be rebuilt. */
	readonly onSiteChanged: (site: MacroSite) => void;
	/** Force the deterministic path even when a key is present. */
	readonly disabled?: boolean;
	/**
	 * The flavour tables the deterministic path names things from.
	 *
	 * Only the fallbacks consult it. A model is given the brief instead, which says
	 * the same thing in prose — a pack is how a world *without* a model gets a
	 * register of its own.
	 */
	readonly content?: ContentPack;
}

/** At most this many model calls in flight, so a walk across a busy region does
 * not open twenty sockets at once. */
const MAX_IN_FLIGHT = 2;

/**
 * Decides what places are called and who lives in them.
 *
 * Everything here is *advisory and late*. The generator never waits on the
 * director: a chunk that needs a settlement it has no spec for builds the
 * deterministic one immediately and rebuilds later if a better answer arrives.
 * That inverts the old design, where walking east blocked on two streaming LLM
 * calls before the player saw a tile.
 *
 * The one hard rule is **commitment**: once the player has been close enough to
 * a settlement to see it, its layout is frozen. A late spec for a committed site
 * is discarded rather than applied, because a town rearranging itself around a
 * standing player is worse than a town with a procedural name.
 */
export class Director {
	private lore: WorldLore | undefined;
	private readonly regions = new Map<string, RegionSpec>();
	private readonly sites = new Map<string, SiteSpec>();
	private readonly sources = new Map<string, SpecSource>();
	private readonly committed = new Set<string>();
	private readonly pending = new Set<string>();
	private readonly queue: (() => Promise<void>)[] = [];
	private inFlight = 0;
	private readonly enabled: boolean;

	private readonly pack: ContentPack;

	constructor(private readonly options: DirectorOptions) {
		this.enabled = !options.disabled && aiAvailable();
		this.pack = options.content ?? DEFAULT_PACK;
		this.lore = options.lore;
		for (const [id, spec] of Object.entries(options.regions ?? {})) this.regions.set(id, spec);
		for (const [id, spec] of Object.entries(options.sites ?? {})) this.sites.set(id, spec);
		for (const [id, source] of Object.entries(options.sources ?? {})) {
			this.sources.set(id, source);
			// Anything restored from a save is by definition already settled.
			this.committed.add(id);
		}
	}

	get active(): boolean {
		return this.enabled;
	}

	getLore(): WorldLore {
		return this.lore ?? fallbackLore(this.pack);
	}

	/** The settlement roster for a site, if one is known. Synchronous by
	 * contract — the chunk generator calls this inside its hot loop. */
	specFor = (site: MacroSite): SettlementSpec | undefined => {
		return this.sites.get(String(site.id))?.settlement;
	};

	siteSpec(siteId: number): SiteSpec | undefined {
		return this.sites.get(String(siteId));
	}

	regionSpec(regionId: number): RegionSpec | undefined {
		return this.regions.get(String(regionId));
	}

	/**
	 * Freeze the layout of every settlement near a position.
	 *
	 * Called as the player moves. After this, a spec arriving for one of these
	 * sites is dropped: the deterministic layout the player is standing in is now
	 * the real one, permanently.
	 */
	commitNear(cc: ChunkCoord): void {
		for (const site of sitesAround(this.options.world, cc.cx, cc.cy, 1)) {
			const key = String(site.id);
			if (this.committed.has(key)) continue;
			this.committed.add(key);
			if (this.sites.has(key)) continue;
			const spec = this.materialiseFallback(site);
			this.sites.set(key, spec);
			this.sources.set(key, "fallback");
			this.options.onSite(spec, "fallback");
		}
	}

	/**
	 * Ask for whatever is missing around a position.
	 *
	 * Fire-and-forget: this returns immediately and results arrive through the
	 * callbacks. The radius is one wider than the chunk prefetch ring so a spec
	 * has a chance to land before the chunk that needs it is ever drawn.
	 */
	request(cc: ChunkCoord): void {
		// Anything the player is already on top of settles now, whether or not a
		// director call for it is still out. With no key at all this is the entire
		// pipeline: every place still gets a name, procedurally.
		this.commitNear(cc);
		if (!this.enabled) return;

		for (const site of sitesAround(this.options.world, cc.cx, cc.cy, HALO + 1)) {
			if (!isSettlement(site.kind) && site.kind !== "ruins") continue;
			const key = String(site.id);
			if (this.sites.has(key) || this.committed.has(key) || this.pending.has(key)) continue;
			this.pending.add(key);
			this.enqueue(() => this.resolveSite(site));
		}
	}

	private enqueue(task: () => Promise<void>): void {
		this.queue.push(task);
		this.pump();
	}

	private pump(): void {
		while (this.inFlight < MAX_IN_FLIGHT && this.queue.length > 0) {
			const task = this.queue.shift();
			if (!task) return;
			this.inFlight++;
			void task()
				.catch((error) => logger.warn(`director task failed: ${error}`))
				.finally(() => {
					this.inFlight--;
					this.pump();
				});
		}
	}

	private async ensureLore(): Promise<WorldLore> {
		if (this.lore) return this.lore;
		const response = await structured({
			kind: "bible",
			model: MODELS.bible,
			schema: WorldLoreSchema,
			system: LORE_SYSTEM,
			prompt: lorePrompt(this.options.brief),
			temperature: 1,
		});
		// A failed bible call is not worth retrying every chunk: adopt the
		// deterministic one and move on, so the region calls below still happen.
		this.lore = response ?? fallbackLore(this.pack);
		this.options.onLore(this.lore);
		return this.lore;
	}

	private async ensureRegion(regionId: number, at: { x: number; y: number }): Promise<RegionSpec> {
		const key = String(regionId);
		const known = this.regions.get(key);
		if (known) return known;

		const context = regionContext(this.options.world, regionId, at);
		const lore = await this.ensureLore();
		const response = await structured({
			kind: "region",
			model: MODELS.director,
			schema: RegionSpecSchema,
			system: REGION_SYSTEM,
			prompt: regionPrompt(lore, context, this.options.brief),
			temperature: 0.9,
		});

		const spec: RegionSpec = response
			? {
					id: key,
					name: response.name,
					blurb: response.blurb,
					tone: response.tone,
					culture: response.culture,
					...(response.factionName ? { factionName: response.factionName } : {}),
					lore: response.lore,
					ambient: response.ambient,
				}
			: fallbackRegion(this.options.world.seed, context, this.pack);

		this.regions.set(key, spec);
		this.options.onRegion(spec);
		return spec;
	}

	private async resolveSite(site: MacroSite): Promise<void> {
		const key = String(site.id);
		try {
			const context = siteContext(this.options.world, site);
			const lore = await this.ensureLore();
			const region = await this.ensureRegion(site.regionId, site.site);

			const response = await structured({
				kind: "site",
				model: MODELS.director,
				schema: SiteSpecSchema,
				system: SITE_SYSTEM,
				prompt: sitePrompt(lore, region, context, this.options.brief),
				temperature: 0.9,
			});

			// The player may have walked into this place while the call was out.
			// Their town is now the one they can see, not the one that just arrived.
			if (this.committed.has(key)) {
				logger.debug(`director: dropping late spec for committed site ${key}`);
				return;
			}

			const spec = response
				? {
						siteId: site.id,
						name: response.name,
						shortName: response.shortName,
						description: response.description,
						settlement: {
							name: response.name,
							walled: response.walled,
							structures: response.structures.map((s) => ({
								kind: s.kind,
								size: s.size,
								importance: s.importance,
								...(s.name ? { name: s.name } : {}),
								...(s.signText ? { signText: s.signText } : {}),
							})),
						},
						npcs: response.npcs.map((n, slot) => ({
							slot,
							name: n.name,
							role: n.role,
							glyph: n.glyph,
							appearance: n.appearance,
							persona: n.persona,
							disposition: n.disposition,
							placement: n.placement,
							...(n.structureName ? { structureName: n.structureName } : {}),
							knows: n.knows,
						})),
						hooks: response.hooks,
					}
				: this.materialiseFallback(site);

			const source: SpecSource = response ? "llm" : "fallback";
			this.sites.set(key, spec);
			this.sources.set(key, source);
			this.committed.add(key);
			this.options.onSite(spec, source);
			// The roster changed, so the settlement has to be rebuilt from it.
			if (source === "llm") this.options.onSiteChanged(site);
		} finally {
			this.pending.delete(key);
		}
	}

	private materialiseFallback(site: MacroSite): SiteSpec {
		return fallbackSite(
			this.options.world.seed,
			site,
			siteContext(this.options.world, site),
			this.pack,
		);
	}
}
