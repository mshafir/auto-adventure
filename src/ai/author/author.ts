import { MODELS } from "../../config.js";
import type { ScenarioArc, ScenarioBeat } from "../../core/rules/arc.js";
import type { QuestObjective } from "../../core/rules/state.js";
import type { ScenarioBrief } from "../../core/world/brief.js";
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
import { ARC_SYSTEM, arcPrompt, TREE_SYSTEM, treePrompt } from "./prompts.js";
import { ArcSchema, TreeSchema } from "./schemas.js";

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
	/** Model calls in flight at once. */
	readonly concurrency?: number;
	/** Skip the per-NPC dialogue pass, which is most of the cost. */
	readonly skipTrees?: boolean;
	readonly onProgress?: (message: string) => void;
}

const DEFAULT_CONCURRENCY = 4;

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
	let calls = 0;

	// --- pass 0: survey, free ------------------------------------------------
	const survey = surveyWorld(options.seed, options.brief.duration);
	const settlements = storySites(survey);
	say(
		`surveyed ${survey.sites.length} sites (${settlements.length} settlements) in a ${
			survey.bounds.maxX - survey.bounds.minX
		}-tile world`,
	);
	if (survey.boundaryAdjustment !== 0)
		say(`moved the boundary ${survey.boundaryAdjustment} tiles to avoid cutting a town in half`);

	// --- pass 1: lore --------------------------------------------------------
	const lore =
		(await structured({
			kind: "bible",
			model: MODELS.bible,
			schema: WorldLoreSchema,
			system: LORE_SYSTEM,
			prompt: lorePrompt(options.brief),
			temperature: 1,
		})) ?? fallbackLore();
	calls++;
	say(`lore: ${lore.title}`);

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

	// --- pass 4: the arc -----------------------------------------------------
	const storyable = settlements
		.map((entry) => ({ entry, spec: sites[String(entry.site.id)] }))
		.filter((pair): pair is { entry: typeof pair.entry; spec: SiteSpec } => Boolean(pair.spec))
		.filter((pair) => pair.spec.npcs.length > 0);

	const arc = await plotArc({
		brief: options.brief,
		lore,
		beats: Math.min(planFor(options.brief.duration).beats, storyable.length),
		sites: storyable,
	});
	if (arc) calls++;
	say(arc ? `plotted ${arc.beats.length} beats` : "no story could be plotted");

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
			});
			calls++;
			if (tree) trees[id] = tree;
		});
		say(`wrote ${Object.keys(trees).length} conversations`);
	}

	const artifact: ScenarioArtifact = {
		artifactVersion: ARTIFACT_VERSION,
		id: options.id,
		title: arc?.title ?? lore.title,
		blurb: arc?.premise ?? lore.premise,
		brief: options.brief,
		seed: options.seed,
		spawn: survey.spawn,
		bounds: survey.bounds,
		lore,
		regions,
		sites,
		...(arc ? { arc } : {}),
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
}): Promise<ScenarioArc | undefined> {
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
	});
	if (!response) return undefined;

	const seen = new Set<string>();
	const beats: ScenarioBeat[] = [];
	for (const raw of response.beats) {
		const chosen = input.sites[raw.siteIndex];
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

		beats.push({
			id: raw.id,
			order,
			siteId: chosen.entry.site.id,
			npcSlot: npc.slot,
			// Each beat waits on the one before, which is what makes the story a
			// sequence rather than a set of things lying about in the world.
			requires: order === 0 ? [] : [`arc:${beats[order - 1]?.id}`],
			setsFlag: flag,
			...(raw.quest
				? {
						quest: {
							id: raw.id,
							name: raw.quest.name,
							description: raw.quest.description,
							objectives,
						},
					}
				: {}),
			...(raw.journal ? { journal: raw.journal } : {}),
		});
	}

	if (beats.length === 0) return undefined;
	return { title: response.title, premise: response.premise, beats };
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
