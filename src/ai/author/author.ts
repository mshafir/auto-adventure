import { MODELS } from "../../config.js";
import type { ArcEnding, ScenarioArc, ScenarioBeat } from "../../core/rules/arc.js";
import type { Placement } from "../../core/rules/placement.js";
import type { QuestObjective } from "../../core/rules/state.js";
import type { ScenarioBrief } from "../../core/world/brief.js";
import { type WorldRecipe, worldSeed } from "../../core/world/recipe.js";
import type { NpcSpec, RegionSpec, SiteSpec, WorldLore } from "../../core/world/spec.js";
import { npcId } from "../../core/world/spec.js";
import { ARTIFACT_VERSION, type ScenarioArtifact } from "../../scenario/artifact.js";
import { planFor, type Survey, storySites, surveyWorld } from "../../scenario/survey.js";
import { logger } from "../../utils/log.js";
import { structured } from "../client.js";
import type { DialogueTree } from "../dialogue/tree.js";
import { fallbackLore, fallbackRegion, fallbackSite } from "../director/fallback.js";
import {
	LORE_SYSTEM,
	lorePrompt,
	REGION_SYSTEM,
	regionPrompt,
	SITE_SYSTEM,
	sitePrompt,
} from "../director/prompt.js";
import { RegionSpecSchema, SiteSpecSchema, WorldLoreSchema } from "../director/schemas.js";
import {
	ARC_SYSTEM,
	arcPrompt,
	SHAPE_SYSTEM,
	shapePrompt,
	TREE_SYSTEM,
	treePrompt,
} from "./prompts.js";
import { type ArcResponse, ArcSchema, TreeSchema, WorldShapeSchema } from "./schemas.js";
import { recipeFor } from "./shape.js";

/**
 * Author a whole world, offline.
 *
 * The order is the point. The survey costs nothing and is done first, so every
 * later pass is told what already exists rather than guessing. The arc is plotted
 * *before* the towns are populated, so each town knows its part in the story
 * instead of having one assigned to it afterwards — which is the difference between
 * a story that runs through a world and a story stapled onto one.
 *
 * Nothing here is on a player's critical path, so unlike the live director this may
 * take minutes and may retry. What it must not do is produce a broken artifact
 * quietly, which is what `validate.ts` is for.
 */

export interface AuthorOptions {
	readonly id: string;
	readonly brief: ScenarioBrief;
	readonly seed: number;
	/** How the world generates, beyond the seed. */
	readonly recipe?: WorldRecipe;
	/** Model calls in flight at once. */
	readonly concurrency?: number;
	/** Skip the per-NPC dialogue pass, which is most of the cost. */
	readonly skipTrees?: boolean;
	/** Skip asking a model what kind of country this is; use the default world. */
	readonly skipShape?: boolean;
	readonly onProgress?: (message: string) => void;
	/**
	 * The caller giving up part-way.
	 *
	 * Checked between passes and passed to every call, so aborting stops the in-flight
	 * requests as well as the ones not yet made. There is nothing to resume from — a
	 * half-authored world is not a world — so this throws {@link AuthoringStopped} rather
	 * than returning a partial artifact and letting a caller mistake it for a finished one.
	 */
	readonly signal?: AbortSignal;
}

/** Thrown when {@link AuthorOptions.signal} aborts. Nothing was written. */
export class AuthoringStopped extends Error {
	constructor(pass: string) {
		super(`authoring stopped during ${pass}`);
		this.name = "AuthoringStopped";
	}
}

const DEFAULT_CONCURRENCY = 4;

/**
 * How long the arc pass may take before it is given up on.
 *
 * Generous, because nothing is waiting on it: this is offline authoring, the player is
 * already watching a progress screen, and the alternative to waiting two minutes is a
 * world with no story in it.
 */
const ARC_TIMEOUT_MS = 120_000;

/**
 * The kinds the default world has none of, so worth reporting when one appears.
 *
 * A world of hamlets and farmland is what the generator produces left alone. These
 * three are what the shape pass can add, and whether they landed is the one thing about
 * the map that a reader of the progress log cannot infer from the site count.
 */
const LANDMARK_KINDS = ["castle", "cave", "docks"] as const;

/** Run tasks with a ceiling on how many are in flight. */
async function pooled<T, R>(
	items: readonly T[],
	limit: number,
	run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await run(items[index] as T, index);
		}
	});
	await Promise.all(workers);
	return results;
}

export interface AuthorResult {
	readonly artifact: ScenarioArtifact;
	readonly calls: number;
}

export async function authorScenario(options: AuthorOptions): Promise<AuthorResult> {
	const say = options.onProgress ?? (() => undefined);
	const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
	const signal = options.signal;
	/** Between passes, where stopping leaves nothing half-built. */
	const stopIfAsked = (pass: string) => {
		if (signal?.aborted) throw new AuthoringStopped(pass);
	};
	/** Spread into every call, so aborting reaches the requests already in flight. */
	const abortable = signal ? { signal } : {};
	let calls = 0;

	// --- pass 0: what kind of country --------------------------------------
	// Before the survey, because the survey runs *against* a world and the world has to
	// exist first. An explicit recipe from the caller wins: somebody who wrote one down
	// has looked at the map, and a model has not.
	let recipe = options.recipe;
	if (!recipe && !options.skipShape) {
		const shape = await structured({
			kind: "bible",
			model: MODELS.bible,
			schema: WorldShapeSchema,
			system: SHAPE_SYSTEM,
			prompt: shapePrompt(options.brief),
			temperature: 0.8,
			...abortable,
		});
		if (shape) {
			calls++;
			recipe = recipeFor(shape);
			say(`world: ${shape.sea} sea, ${shape.climate}, ${shape.wet}, ${shape.settled}ly settled`);
		}
	}

	// --- pass 1: survey, free ------------------------------------------------
	const world = worldSeed(options.seed, recipe);
	const survey = surveyWorld(world, options.brief.duration);
	const settlements = storySites(survey);
	say(
		`surveyed ${survey.sites.length} sites (${settlements.length} settlements) in a ${
			survey.bounds.maxX - survey.bounds.minX
		}-tile world`,
	);
	if (survey.boundaryAdjustment !== 0)
		say(`moved the boundary ${survey.boundaryAdjustment} tiles to avoid cutting a town in half`);

	// What the ground refused, and what it allowed. Both are worth saying out loud: a
	// recipe asking for six harbours in a landlocked world produces neither an error nor
	// a harbour, and without this the only symptom is a world that feels thinner than
	// the brief asked for.
	const declined = Object.entries(survey.declined);
	if (declined.length > 0) {
		say(
			`the ground suited none of ${declined
				.map(([kind, count]) => `${count} ${kind}${count === 1 ? "" : "s"}`)
				.join(", ")}`,
		);
	}
	const landmarks = LANDMARK_KINDS.filter((kind) =>
		survey.sites.some((entry) => entry.site.kind === kind),
	);
	if (landmarks.length > 0) say(`the map has ${landmarks.join(", ")} on it`);

	// --- pass 1: lore --------------------------------------------------------
	const lore =
		(await structured({
			kind: "bible",
			model: MODELS.bible,
			schema: WorldLoreSchema,
			system: LORE_SYSTEM,
			prompt: lorePrompt(options.brief),
			temperature: 1,
			...abortable,
		})) ?? fallbackLore();
	calls++;
	say(`lore: ${lore.title}`);
	stopIfAsked("the lore");

	// --- pass 2: regions -----------------------------------------------------
	const regions: Record<string, RegionSpec> = {};
	await pooled(survey.regions, concurrency, async (context) => {
		const response = await structured({
			kind: "region",
			model: MODELS.director,
			schema: RegionSpecSchema,
			system: REGION_SYSTEM,
			prompt: regionPrompt(lore, context, options.brief),
			temperature: 0.9,
			...abortable,
		});
		calls++;
		const id = String(context.regionId);
		regions[id] = response
			? {
					id,
					name: response.name,
					blurb: response.blurb,
					tone: response.tone,
					culture: response.culture,
					...(response.factionName ? { factionName: response.factionName } : {}),
					lore: response.lore,
					ambient: response.ambient,
				}
			: fallbackRegion(options.seed, context);
	});
	say(`named ${Object.keys(regions).length} regions`);
	stopIfAsked("the regions");

	// --- pass 3: sites -------------------------------------------------------
	const sites: Record<string, SiteSpec> = {};
	await pooled(survey.sites, concurrency, async (entry) => {
		const region = regions[String(entry.site.regionId)];
		const response = region
			? await structured({
					kind: "site",
					model: MODELS.director,
					schema: SiteSpecSchema,
					system: SITE_SYSTEM,
					prompt: sitePrompt(lore, region, entry.context, options.brief),
					temperature: 0.9,
					...abortable,
				})
			: undefined;
		calls++;
		sites[String(entry.site.id)] = response
			? {
					siteId: entry.site.id,
					name: response.name,
					shortName: response.shortName,
					description: response.description,
					settlement: {
						name: response.name,
						walled: response.walled,
						structures: response.structures.map((structure) => ({
							kind: structure.kind,
							size: structure.size,
							importance: structure.importance,
							...(structure.name ? { name: structure.name } : {}),
							...(structure.signText ? { signText: structure.signText } : {}),
						})),
					},
					npcs: response.npcs.map((npc, slot) => ({
						slot,
						name: npc.name,
						role: npc.role,
						glyph: npc.glyph,
						appearance: npc.appearance,
						persona: npc.persona,
						disposition: npc.disposition,
						placement: npc.placement,
						...(npc.structureName ? { structureName: npc.structureName } : {}),
						knows: npc.knows,
					})),
					hooks: response.hooks,
				}
			: fallbackSite(options.seed, entry.site, entry.context);
	});
	say(`populated ${Object.keys(sites).length} places`);
	stopIfAsked("the places");

	// --- pass 4: the arc -----------------------------------------------------
	const storyable = settlements
		.map((entry) => ({ entry, spec: sites[String(entry.site.id)] }))
		.filter((pair): pair is { entry: typeof pair.entry; spec: SiteSpec } => Boolean(pair.spec))
		.filter((pair) => pair.spec.npcs.length > 0);

	const plotted = await plotArc({
		brief: options.brief,
		lore,
		beats: Math.min(planFor(options.brief.duration).beats, storyable.length),
		sites: storyable,
		...abortable,
	});
	const arc = plotted?.arc;
	if (arc) calls++;
	say(arc ? `plotted ${arc.beats.length} beats` : "no story could be plotted");
	stopIfAsked("the plot");
	if (plotted?.placements.length) say(`hid ${plotted.placements.length} things to find`);

	// --- pass 5: dialogue ----------------------------------------------------
	const trees: Record<string, DialogueTree> = {};
	if (!options.skipTrees) {
		const people = Object.values(sites).flatMap((spec) => spec.npcs.map((npc) => ({ spec, npc })));
		await pooled(people, concurrency, async ({ spec, npc }) => {
			const id = npcId(spec.siteId, npc.slot);
			const beat = arc?.beats.find(
				(candidate) => candidate.siteId === spec.siteId && candidate.npcSlot === npc.slot,
			);
			const tree = await writeTree({
				lore,
				site: spec,
				npc,
				id,
				...(beat
					? {
							beat: {
								summary: beat.journal ?? beat.quest?.description ?? "",
								setsFlag: beat.setsFlag,
								...(beat.quest ? { questName: beat.quest.name } : {}),
							},
						}
					: {}),
				availableFlags: (arc?.beats ?? []).map((candidate) => candidate.setsFlag),
				...abortable,
			});
			calls++;
			if (tree) trees[id] = tree;
		});
		say(`wrote ${Object.keys(trees).length} conversations`);
	}
	// Last check, before anything is assembled. Past here the artifact exists and is
	// worth keeping: stopping would throw away a finished world to save nothing.
	stopIfAsked("the conversations");

	const artifact: ScenarioArtifact = {
		artifactVersion: ARTIFACT_VERSION,
		id: options.id,
		title: arc?.title ?? lore.title,
		blurb: arc?.premise ?? lore.premise,
		brief: options.brief,
		seed: options.seed,
		...(recipe ? { recipe } : {}),
		spawn: survey.spawn,
		bounds: survey.bounds,
		lore,
		regions,
		sites,
		...(arc ? { arc } : {}),
		...(plotted?.placements.length ? { placements: plotted.placements } : {}),
		...(Object.keys(trees).length > 0 ? { trees } : {}),
		authoredWith: {
			models: { bible: MODELS.bible, director: MODELS.director, dialogue: MODELS.dialogue },
			calls,
			at: new Date().toISOString(),
		},
	};
	return { artifact, calls };
}

/**
 * Turn the model's indices into real ids.
 *
 * The model chooses by index into the lists it was shown, never by id. A
 * hallucinated site id would be a beat anchored to nobody, which is a story that
 * silently never starts; an out-of-range index is simply dropped here.
 */
async function plotArc(input: {
	readonly brief: ScenarioBrief;
	readonly lore: WorldLore;
	readonly beats: number;
	readonly sites: readonly { readonly entry: { site: { id: number } }; readonly spec: SiteSpec }[];
	readonly signal?: AbortSignal;
}): Promise<{ arc: ScenarioArc; placements: Placement[] } | undefined> {
	if (input.sites.length === 0 || input.beats === 0) return undefined;

	const response = await structured({
		kind: "site",
		model: MODELS.bible,
		schema: ArcSchema,
		system: ARC_SYSTEM,
		prompt: arcPrompt({
			brief: input.brief,
			lore: input.lore,
			beats: input.beats,
			// biome-ignore lint/suspicious/noExplicitAny: the prompt needs only the fields both shapes share
			sites: input.sites as any,
		}),
		temperature: 0.9,
		// The one call that legitimately needs longer than the default twenty seconds. It
		// is shown every settlement and every person in the world and asked to plot a whole
		// story across them, so it is by far the largest prompt and the largest answer —
		// and it was timing out, which is a silent catastrophe rather than a slow pass:
		// a world whose arc call fails has no story at all, and every later pass carries on
		// as though that were the intended shape.
		timeoutMs: ARC_TIMEOUT_MS,
		...(input.signal ? { signal: input.signal } : {}),
	});
	if (!response) return undefined;
	return lowerArc(response, input.sites);
}

/**
 * Turn the model's answer into beats, placements and endings.
 *
 * Separated from the call so it can be tested without one. Everything interesting the
 * authoring pass does to a story happens here — the sequencing, the sub-errands, the
 * hidden items — and none of it is worth trusting on the strength of having read it.
 */
/**
 * A building at this settlement that the thing can actually be hidden in.
 *
 * The model chooses `where` from the closed list of structure kinds, which stops it
 * inventing a "vault" and does not stop it choosing a barracks at a settlement that has
 * no barracks. That combination is worse than it sounds: the placement fails to resolve,
 * the item is nowhere, and the beat carries an objective to be holding it — so the story
 * stops dead at a step no player can complete, silently, with a warning in a log nobody
 * is reading.
 *
 * Falls back to the settlement's most prominent building rather than dropping the item,
 * because *where* a thing is hidden is flavour and *that* it can be found is the story.
 */
function hidingPlace(wanted: string, spec: SiteSpec): string {
	const built = spec.settlement.structures;
	if (built.some((structure) => structure.kind === wanted)) return wanted;
	const fallback = [...built].sort((a, b) => b.importance - a.importance)[0];
	return fallback?.kind ?? wanted;
}

export function lowerArc(
	response: ArcResponse,
	sites: readonly { readonly entry: { site: { id: number } }; readonly spec: SiteSpec }[],
): { arc: ScenarioArc; placements: Placement[] } | undefined {
	const seen = new Set<string>();
	// Mutable while it is being assembled: a parent's objectives are not knowable until
	// its steps have been read, and a `ScenarioBeat` is readonly by the time it ships.
	const beats: (Omit<ScenarioBeat, "quest"> & { quest?: ScenarioBeat["quest"] })[] = [];
	const placements: Placement[] = [];
	// The beat before this one *on the main line*. A side errand must not become the
	// thing the next beat waits on, or the story stops until the player finds it —
	// which is the precise opposite of what "optional" means.
	let previousMain: string | undefined;

	for (const raw of response.beats) {
		const chosen = sites[raw.siteIndex];
		if (!chosen) continue;
		const npc = chosen.spec.npcs[raw.npcIndex];
		if (!npc) continue;
		if (seen.has(raw.id)) continue;
		seen.add(raw.id);

		const order = beats.length;
		const flag = `arc:${raw.id}`;
		const objectives: QuestObjective[] = raw.quest?.objective
			? [
					{
						kind: raw.quest.objective.kind,
						target: raw.quest.objective.target,
						...(raw.quest.objective.quantity ? { quantity: raw.quest.objective.quantity } : {}),
						done: false,
					},
				]
			: [];

		// Something hidden becomes two things at once: a placement the engine resolves
		// against real geometry, and an objective to be carrying it. Both, because a
		// placement alone is an item nobody was asked for, and an objective alone is an
		// item that is nowhere — which is the dead end this whole pass exists to avoid.
		if (raw.find) {
			placements.push({
				id: `find:${raw.id}`,
				at: {
					kind: "site",
					siteId: chosen.entry.site.id,
					structure: hidingPlace(raw.find.where, chosen.spec),
				},
				item: { name: raw.find.item, description: raw.find.description },
				showDecor: true,
			});
			objectives.push({ kind: "have", target: raw.find.item, done: false });
		}

		// A step is only a step if its parent is a beat already written and is not itself.
		const parent =
			raw.partOf && seen.has(raw.partOf) && raw.partOf !== raw.id ? raw.partOf : undefined;

		beats.push({
			id: raw.id,
			order,
			siteId: chosen.entry.site.id,
			npcSlot: npc.slot,
			// Each main beat waits on the one before, which is what makes the story a
			// sequence rather than a set of things lying about in the world. A step of an
			// earlier errand waits on *that*, and a side errand waits on nothing at all.
			requires: parent ? [`arc:${parent}`] : previousMain ? [`arc:${previousMain}`] : [],
			setsFlag: flag,
			...(raw.optional ? { optional: true } : {}),
			...(raw.branch ? { branch: raw.branch } : {}),
			...(raw.quest || raw.find
				? {
						quest: {
							id: raw.id,
							name: raw.quest?.name ?? `The ${raw.find?.item}`,
							description: raw.quest?.description ?? raw.find?.description ?? "",
							objectives,
							...(parent ? { parentId: parent } : {}),
						},
					}
				: {}),
			...(raw.journal ? { journal: raw.journal } : {}),
		});

		// A branch arm does not advance the main line either: the next beat must wait on
		// whatever came *before* the fork, or one arm becomes a prerequisite of the other.
		if (!raw.optional && !parent && !raw.branch) previousMain = raw.id;
	}

	if (beats.length === 0) return undefined;

	// A parent cannot close until its steps do. Added afterwards rather than as the
	// steps are read, because a parent is written before the things that belong to it.
	for (const beat of beats) {
		const steps = beats.filter((other) => other.quest?.parentId === beat.id);
		if (steps.length === 0 || !beat.quest) continue;
		beat.quest = {
			...beat.quest,
			objectives: [
				...beat.quest.objectives,
				...steps.map((step) => ({ kind: "quest" as const, target: step.id, done: false })),
			],
		};
	}

	const ids = new Set(beats.map((beat) => beat.id));
	const endings: ArcEnding[] = response.endings
		.filter((ending) => ids.has(ending.beat))
		.map((ending) => ({
			id: `end:${ending.beat}`,
			// Keyed on the arm's own flag rather than on the branch group: `pickEnding`
			// takes the first match in author order, so an ending is simply "this is the
			// arm that was taken".
			when: { flag: `arc:${ending.beat}` },
			title: ending.title,
			sections: [{ heading: ending.heading, body: ending.body }],
		}));

	return {
		arc: {
			title: response.title,
			premise: response.premise,
			beats,
			...(endings.length > 0 ? { endings } : {}),
		},
		placements,
	};
}

async function writeTree(input: {
	readonly lore: WorldLore;
	readonly site: SiteSpec;
	readonly npc: NpcSpec;
	readonly id: string;
	readonly beat?: {
		readonly summary: string;
		readonly setsFlag: string;
		readonly questName?: string;
	};
	readonly availableFlags: readonly string[];
	readonly signal?: AbortSignal;
}): Promise<DialogueTree | undefined> {
	const response = await structured({
		kind: "dialogue",
		model: MODELS.dialogue,
		schema: TreeSchema,
		system: TREE_SYSTEM,
		prompt: treePrompt({
			lore: input.lore,
			site: input.site,
			npc: input.npc,
			...(input.beat ? { beat: input.beat } : {}),
			availableFlags: input.availableFlags,
		}),
		temperature: 0.85,
		...(input.signal ? { signal: input.signal } : {}),
	});
	if (!response) return undefined;

	const nodes: Record<string, DialogueTree["nodes"][string]> = {};
	for (const node of response.nodes) {
		nodes[node.id] = {
			id: node.id,
			speech: node.speech,
			...(node.requiresFlag ? { requires: [node.requiresFlag] } : {}),
			choices: node.choices.map((choice) => ({
				text: choice.text,
				goto: choice.goto,
				...(choice.requiresFlag ? { requires: [choice.requiresFlag] } : {}),
			})),
			...(node.actions.length > 0 ? { actions: node.actions } : {}),
		};
	}

	// Openings, most specific first, so a gated one is preferred once its flag is set.
	const entry = [...response.entryAfter.map((option) => option.node), response.entry].filter(
		(id) => nodes[id],
	);
	if (entry.length === 0) {
		logger.warn(`tree for ${input.id} has no usable opening; dropping it`);
		return undefined;
	}

	return {
		npcId: input.id,
		entry,
		...(response.revisit && nodes[response.revisit] ? { revisit: [response.revisit] } : {}),
		nodes,
	};
}

export type { Survey };
