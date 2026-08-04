import { z } from "zod";
import { ActionSchema } from "../ai/dialogue/schema.js";
import type { DialogueTree } from "../ai/dialogue/tree.js";
import { fallbackRegion, fallbackSite } from "../ai/director/fallback.js";
import { PLACEMENTS, STRUCTURE_KINDS } from "../ai/director/schemas.js";
import { hashString } from "../core/rand/hash.js";
import type { ScenarioArc, ScenarioBeat } from "../core/rules/arc.js";
import type { QuestObjective } from "../core/rules/state.js";
import { resolveName } from "../core/rules/surroundings.js";
import { normalizeBrief } from "../core/world/brief.js";
import type { RegionSpec, SiteSpec } from "../core/world/spec.js";
import { npcId } from "../core/world/spec.js";
import { ARTIFACT_VERSION, type ScenarioArtifact } from "./artifact.js";
import { CardBodySchema, ScenarioBriefSchema } from "./schema.js";
import { surveyWorld } from "./survey.js";

/**
 * A scenario as a person (or an agent) writes it.
 *
 * The artifact format is what the *game* needs: site ids as keys, flags chained
 * between beats, npc ids composed from a site and a slot. None of that is what an
 * author wants to think about, and every one of them is a way to produce a file that
 * loads and is quietly wrong. A draft says only the things that require judgement —
 * names, people, what happens — and this module derives the rest.
 *
 * Specifically: beat order, gating flags and quest ids are computed rather than
 * written, so an arc cannot be authored with a beat that waits on a flag nothing
 * sets, and anything left out falls back to the deterministic content instead of
 * being missing. That makes authoring incremental: draft the towns that matter,
 * assemble, play it, come back for the rest.
 */

const StructureDraftSchema = z.object({
	kind: z.enum(STRUCTURE_KINDS),
	size: z.enum(["small", "medium", "large"]),
	importance: z.number().int().min(1).max(5),
	name: z.string().max(60).optional(),
	signText: z.string().max(60).optional(),
});

const NpcDraftSchema = z.object({
	name: z.string().min(1).max(60),
	role: z.string().min(1).max(40),
	glyph: z
		.string()
		.regex(/^[A-Za-z]$/, "one letter")
		.optional(),
	appearance: z.string().max(200),
	persona: z.string().max(300),
	disposition: z.number().int().min(-100).max(100).optional(),
	placement: z.enum(PLACEMENTS),
	structureName: z.string().max(60).optional(),
	knows: z.array(z.string().max(200)).max(6),
});

const SiteDraftSchema = z.object({
	siteId: z.number().int(),
	name: z.string().min(1).max(60),
	shortName: z.string().min(1).max(24),
	description: z.string().max(400),
	walled: z.boolean().optional(),
	structures: z.array(StructureDraftSchema).max(20),
	npcs: z.array(NpcDraftSchema).max(8),
	hooks: z.array(z.string().max(200)).max(3),
});

const RegionDraftSchema = z.object({
	regionId: z.number().int(),
	name: z.string().min(1).max(60),
	blurb: z.string().max(300),
	tone: z.string().max(80),
	culture: z.string().max(160),
	factionName: z.string().max(60).optional(),
	lore: z.array(z.string().max(200)).max(5),
	ambient: z.array(z.string().max(120)).max(6),
});

const BeatDraftSchema = z.object({
	id: z
		.string()
		.min(1)
		.max(48)
		.regex(/^[a-z0-9][a-z0-9-]*$/, "lower-case slug"),
	siteId: z.number().int(),
	npcSlot: z.number().int().min(0),
	journal: z.string().max(240).optional(),
	/** A full screen shown as this beat opens. For the turns dialogue cannot carry. */
	card: CardBodySchema.optional(),
	quest: z
		.object({
			name: z.string().min(1).max(80),
			description: z.string().max(240),
			objective: z
				.object({
					kind: z.enum(["have", "reach", "talk", "flag"]),
					target: z.string().min(1).max(80),
					quantity: z.number().int().min(1).max(99).optional(),
				})
				.optional(),
		})
		.optional(),
});

const NodeDraftSchema = z.object({
	id: z
		.string()
		.min(1)
		.max(48)
		.regex(/^[a-z0-9][a-z0-9-]*$/, "lower-case slug"),
	speech: z.string().min(1).max(600),
	requiresFlag: z.string().max(64).optional(),
	choices: z
		.array(
			z.object({
				text: z.string().min(1).max(120),
				goto: z.string().max(48).nullable(),
				requiresFlag: z.string().max(64).optional(),
			}),
		)
		.max(6),
	actions: z.array(ActionSchema).max(3).optional(),
});

const TreeDraftSchema = z.object({
	siteId: z.number().int(),
	npcSlot: z.number().int().min(0),
	entry: z.string().min(1).max(48),
	/** Alternative openings, each used once its flag is set. Most specific first. */
	entryAfter: z
		.array(z.object({ node: z.string().max(48), flag: z.string().max(64) }))
		.max(3)
		.optional(),
	revisit: z.string().max(48).optional(),
	nodes: z.array(NodeDraftSchema).min(1).max(12),
});

export const ScenarioDraftSchema = z.object({
	id: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z0-9][a-z0-9-]*$/, "lower-case letters, digits and dashes only"),
	/** A word or a number. Defaults to the id, so a scenario reproduces itself. */
	seed: z.union([z.string(), z.number()]).optional(),
	brief: ScenarioBriefSchema,
	title: z.string().min(1).max(80),
	blurb: z.string().max(400),
	lore: z.object({
		title: z.string().min(1).max(60),
		premise: z.string().max(400),
		era: z.string().max(80),
		tone: z.string().max(80),
		factions: z.array(z.string().max(60)).max(6),
		deities: z.array(z.string().max(60)).max(4),
	}),
	regions: z.array(RegionDraftSchema).optional(),
	sites: z.array(SiteDraftSchema).optional(),
	arc: z
		.object({
			title: z.string().min(1).max(120),
			premise: z.string().max(600),
			beats: z.array(BeatDraftSchema).min(1).max(14),
		})
		.optional(),
	trees: z.array(TreeDraftSchema).optional(),
});

export type ScenarioDraft = z.infer<typeof ScenarioDraftSchema>;

/**
 * Turn a draft into an artifact.
 *
 * Deterministic given the draft: the survey is recomputed from the seed and the
 * duration rather than carried in the file, so an artifact assembled twice from one
 * draft is identical, and a draft can never disagree with the world it describes.
 */
export function assembleArtifact(draft: ScenarioDraft, at: string): ScenarioArtifact {
	const brief = normalizeBrief(draft.brief) ?? {};
	const seed = resolveDraftSeed(draft);
	const survey = surveyWorld(seed, brief.duration);

	const regions: Record<string, RegionSpec> = {};
	const drafted = new Map(draft.regions?.map((region) => [region.regionId, region]) ?? []);
	for (const context of survey.regions) {
		const written = drafted.get(context.regionId);
		const id = String(context.regionId);
		regions[id] = written
			? {
					id,
					name: written.name,
					blurb: written.blurb,
					tone: written.tone,
					culture: written.culture,
					...(written.factionName ? { factionName: written.factionName } : {}),
					lore: written.lore,
					ambient: written.ambient,
				}
			: fallbackRegion(seed, context);
	}

	const sites: Record<string, SiteSpec> = {};
	const draftedSites = new Map(draft.sites?.map((site) => [site.siteId, site]) ?? []);
	for (const entry of survey.sites) {
		const written = draftedSites.get(entry.site.id);
		const key = String(entry.site.id);
		if (!written) {
			// Not authored: the deterministic roster, which is a real place with real
			// people in it. This is what makes partial drafts worth assembling.
			sites[key] = fallbackSite(seed, entry.site, entry.context);
			continue;
		}
		sites[key] = {
			siteId: entry.site.id,
			name: written.name,
			shortName: written.shortName,
			description: written.description,
			settlement: {
				name: written.name,
				walled: written.walled ?? false,
				structures: written.structures.map((structure) => ({
					kind: structure.kind,
					size: structure.size,
					importance: structure.importance,
					...(structure.name ? { name: structure.name } : {}),
					...(structure.signText ? { signText: structure.signText } : {}),
				})),
			},
			npcs: written.npcs.map((npc, slot) => ({
				slot,
				name: npc.name,
				role: npc.role,
				// A letter per role is the classic answer and the only one with no
				// glyph-width risk, so one is derived when none was given.
				glyph: npc.glyph ?? npc.role.charAt(0).toUpperCase() ?? "P",
				appearance: npc.appearance,
				persona: npc.persona,
				disposition: npc.disposition ?? 0,
				placement: npc.placement,
				...(npc.structureName ? { structureName: npc.structureName } : {}),
				knows: npc.knows,
			})),
			hooks: written.hooks,
		};
	}

	const arc = draft.arc ? lowerArc(draft.arc, sites) : undefined;
	const trees = lowerTrees(draft.trees ?? []);

	return {
		artifactVersion: ARTIFACT_VERSION,
		id: draft.id,
		title: draft.title,
		blurb: draft.blurb,
		brief,
		seed,
		spawn: survey.spawn,
		bounds: survey.bounds,
		lore: draft.lore,
		regions,
		sites,
		...(arc ? { arc } : {}),
		...(Object.keys(trees).length > 0 ? { trees } : {}),
		authoredWith: { models: { author: "claude-code" }, calls: 0, at },
	};
}

/**
 * Which world a draft is written against.
 *
 * Must agree with `resolveSeed` exactly, and therefore calls the same `hashString`
 * rather than reimplementing it. An earlier version had its own copy of the hash to
 * stay independent of the game's configuration, which meant `--seed thornwick`
 * surveyed one world and assembled against another: every authored site id was
 * suddenly a site of nowhere, and the only clue was a wall of "unauthored site"
 * errors naming ids that had been correct when written.
 */
export function resolveDraftSeed(draft: ScenarioDraft): number {
	const raw = draft.seed ?? draft.id;
	if (typeof raw === "number") return Math.trunc(raw);
	return /^-?\d+$/.test(raw) ? Number(raw) : hashString(raw);
}

/**
 * Chain the beats.
 *
 * Order, gating flag and quest id are all derived, so a drafted arc cannot wait on a
 * flag nothing sets, cannot skip its own opening, and cannot be reordered by editing
 * the file in the wrong place. The story is the order it is written in.
 */
function lowerArc(
	draft: NonNullable<ScenarioDraft["arc"]>,
	sites: Readonly<Record<string, SiteSpec>>,
): ScenarioArc {
	// Canonicalised here so the objective carries the world's spelling rather than
	// the author's. `verifyQuests` matches on significant words, so "the mill" never
	// completes against a building called "Harrowmill Mill" — the runtime does this
	// for a quest an NPC opens, via `resolveObjectiveTarget`, and an authored quest
	// needs the same treatment or it is quietly the one kind that cannot finish.
	// Exactly the candidates `resolveObjectiveTarget` offers a `reach` target at
	// runtime: place names and building names. Notably *not* `shortName`, which the
	// runtime never consults — canonicalising to a name the game cannot resolve would
	// be worse than leaving the author's own words in place.
	const placeNames: string[] = [];
	for (const spec of Object.values(sites)) {
		placeNames.push(spec.name);
		for (const structure of spec.settlement.structures) {
			if (structure.name) placeNames.push(structure.name);
		}
	}
	const peopleNames = Object.values(sites).flatMap((spec) => spec.npcs.map((npc) => npc.name));

	const canonical = (kind: QuestObjective["kind"], target: string): string => {
		if (kind === "reach") return resolveName(target, placeNames) ?? target;
		if (kind === "talk") return resolveName(target, peopleNames) ?? target;
		// `have` names an item, which the author types themselves and nothing here can
		// spell better; `flag` names nothing in the world at all. Validation reports an
		// item no conversation gives.
		return target;
	};

	const beats: ScenarioBeat[] = draft.beats.map((raw, order) => {
		const objectives: QuestObjective[] = raw.quest?.objective
			? [
					{
						kind: raw.quest.objective.kind,
						target: canonical(raw.quest.objective.kind, raw.quest.objective.target),
						...(raw.quest.objective.quantity ? { quantity: raw.quest.objective.quantity } : {}),
						done: false,
					},
				]
			: [];
		const previous = draft.beats[order - 1];
		return {
			id: raw.id,
			order,
			siteId: raw.siteId,
			npcSlot: raw.npcSlot,
			requires: previous ? [`arc:${previous.id}`] : [],
			setsFlag: `arc:${raw.id}`,
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
			...(raw.card ? { card: raw.card } : {}),
		};
	});
	return { title: draft.title, premise: draft.premise, beats };
}

function lowerTrees(
	drafts: readonly z.infer<typeof TreeDraftSchema>[],
): Record<string, DialogueTree> {
	const trees: Record<string, DialogueTree> = {};
	for (const draft of drafts) {
		const id = npcId(draft.siteId, draft.npcSlot);
		const nodes: Record<string, DialogueTree["nodes"][string]> = {};
		for (const node of draft.nodes) {
			nodes[node.id] = {
				id: node.id,
				speech: node.speech,
				...(node.requiresFlag ? { requires: [node.requiresFlag] } : {}),
				choices: node.choices.map((choice) => ({
					text: choice.text,
					goto: choice.goto,
					...(choice.requiresFlag ? { requires: [choice.requiresFlag] } : {}),
				})),
				...(node.actions?.length ? { actions: node.actions } : {}),
			};
		}
		// An alternative opening's flag becomes a requirement *on the node it names*,
		// because that is the only gate the runtime consults. Lowering `entryAfter` to
		// a bare list of candidates dropped the flag on the floor: the alternative was
		// listed first and required nothing, so it always won, and the first-meeting
		// greeting it was written to replace could never be read at all.
		for (const option of draft.entryAfter ?? []) {
			const node = nodes[option.node];
			if (!node) continue;
			const already = node.requires ?? [];
			if (already.includes(option.flag)) continue;
			nodes[option.node] = { ...node, requires: [...already, option.flag] };
		}

		// Gated openings first, so the most specific one that qualifies is used.
		const entry = [...(draft.entryAfter ?? []).map((option) => option.node), draft.entry].filter(
			(node) => nodes[node],
		);
		if (entry.length === 0) continue;
		trees[id] = {
			npcId: id,
			entry,
			...(draft.revisit && nodes[draft.revisit] ? { revisit: [draft.revisit] } : {}),
			nodes,
		};
	}
	return trees;
}
