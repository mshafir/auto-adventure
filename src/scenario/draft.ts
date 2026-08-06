import { z } from "zod";
import { ActionSchema } from "../ai/dialogue/schema.js";
import type { DialogueTree } from "../ai/dialogue/tree.js";
import { fallbackRegion, fallbackSite } from "../ai/director/fallback.js";
import { PLACEMENTS, STRUCTURE_KINDS } from "../ai/director/schemas.js";
import { DEFAULT_PACK } from "../core/content/default.js";
import {
	isOverrideEmpty,
	mergeOverride,
	mergePack,
	type PackOverride,
} from "../core/content/pack.js";
import { PackOverrideSchema } from "../core/content/schema.js";
import { hashString } from "../core/rand/hash.js";
import type { ScenarioArc, ScenarioBeat } from "../core/rules/arc.js";
import { ConditionSchema } from "../core/rules/condition-schema.js";
import type { QuestObjective } from "../core/rules/state.js";
import { resolveName } from "../core/rules/surroundings.js";
import { normalizeBrief } from "../core/world/brief.js";
import { worldSeed } from "../core/world/recipe.js";
import { WorldRecipeSchema } from "../core/world/recipe-schema.js";
import type { RegionSpec, SiteSpec } from "../core/world/spec.js";
import { npcId } from "../core/world/spec.js";
import { ARTIFACT_VERSION, type ScenarioArtifact } from "./artifact.js";
import {
	AuthoredEffectSchema,
	BarrierSchema,
	CardBodySchema,
	LockSchema,
	PlacementSchema,
	ScenarioBriefSchema,
	TimeOptionsSchema,
	TriggerSchema,
} from "./schema.js";
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

/**
 * The parts of the newer vocabulary a draft carries through untouched.
 *
 * Everything else in this file is *derived* — beat order, gating flags, quest ids, npc
 * ids — because those are the things an author can get wrong by writing. Conditions,
 * triggers, locks, gates, placed items and forks are not like that: there is nothing to
 * derive them from, and an author writing one has already said the whole of it.
 *
 * Before this existed the loop was: assemble once, hand-edit the artifact, then never
 * re-assemble — because re-running the tool discarded every hand edit without saying
 * so. A draft that cannot say what the game can do is a draft nobody can keep.
 */
const StructureDraftSchema = z.object({
	kind: z.enum(STRUCTURE_KINDS),
	size: z.enum(["small", "medium", "large"]),
	importance: z.number().int().min(1).max(5),
	name: z.string().max(60).optional(),
	signText: z.string().max(60).optional(),
	/** What has to be true to get inside. Absent means the door simply opens. */
	lock: LockSchema.optional(),
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
	/** What has to be true for this person to be in the world at all. */
	requires: ConditionSchema.optional(),
	/** Keep them at their own anchor at every hour, rather than on a schedule. */
	stays: z.boolean().optional(),
	/** Stand inside `structureName` rather than outdoors, on its ground floor. */
	indoors: z.boolean().optional(),
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
					// `quest` names another beat's errand, and is what makes one job with
					// three parts rather than three unrelated jobs.
					kind: z.enum(["have", "reach", "talk", "flag", "quest"]),
					target: z.string().min(1).max(80),
					quantity: z.number().int().min(1).max(99).optional(),
				})
				.optional(),
			/** The beat whose errand this one is a step of. */
			parentId: z.string().max(48).optional(),
		})
		.optional(),
	/** A side errand: it opens and journals, but the story can end without it. */
	optional: z.boolean().optional(),
	/** A fork this beat is one arm of. Siblings are barred once one is taken. */
	branch: z.string().max(48).optional(),
	/** Opens on its own once this is true, rather than on a conversation. */
	opensOn: ConditionSchema.optional(),
	/**
	 * What must already be true, overriding the derived chain.
	 *
	 * Rarely needed: {@link derivedRequires} already handles the straight line, side
	 * errands and both ends of a fork. This is the escape hatch for a beat that waits
	 * on something the story never wrote a flag for — an item in hand, an errand
	 * closed, a place stood in.
	 */
	requires: ConditionSchema.optional(),
	/** What else the beat does to the world as it opens. */
	effects: z.array(AuthoredEffectSchema).max(8).optional(),
});

const NodeDraftSchema = z.object({
	id: z
		.string()
		.min(1)
		.max(48)
		.regex(/^[a-z0-9][a-z0-9-]*$/, "lower-case slug"),
	speech: z.string().min(1).max(600),
	requiresFlag: z.string().max(64).optional(),
	/**
	 * A full condition, where a flag will not do.
	 *
	 * The case that forced it: a line that hands something over must not be reachable
	 * twice, and "not already carrying it" is not a flag anybody set. Without this the
	 * only way to write a gift was to write one that could be collected all afternoon.
	 */
	requires: ConditionSchema.optional(),
	choices: z
		.array(
			z.object({
				text: z.string().min(1).max(120),
				goto: z.string().max(48).nullable(),
				requiresFlag: z.string().max(64).optional(),
				requires: ConditionSchema.optional(),
			}),
		)
		.max(6),
	// Four, not three. A hand-over is take the thing, give the thanks, warm them to
	// you, and *record that it happened* — and the last of those is not optional
	// decoration: without it the opening that fired is gated on an item that is now
	// gone, so the next hello falls back to asking for it again. The cap was quietly
	// forcing authors to drop the one action that makes the character remember.
	actions: z.array(ActionSchema).max(4).optional(),
});

const TreeDraftSchema = z.object({
	siteId: z.number().int(),
	npcSlot: z.number().int().min(0),
	entry: z.string().min(1).max(48),
	/**
	 * Alternative openings, each used once its condition holds. Most specific first.
	 *
	 * `flag` is the shorthand and covers almost every case. `when` is for the opening
	 * that is about something other than the story having moved — coming back with the
	 * thing you were sent for, which is a question about the player's pack rather than
	 * about a flag anybody remembered to set.
	 */
	entryAfter: z
		.array(
			z
				.object({
					node: z.string().max(48),
					flag: z.string().max(64).optional(),
					when: ConditionSchema.optional(),
				})
				.refine((option) => option.flag !== undefined || option.when !== undefined, {
					message: "an alternative opening needs a flag or a when",
				}),
		)
		.max(3)
		.optional(),
	revisit: z.string().max(48).optional(),
	// Sixteen, not twelve. A conversation with real choices in it fans out fast — a
	// greeting, three things to ask about, and a couple of answers that lead on is
	// already eight — and the cap was quietly pushing every tree back towards a
	// corridor with one question in it.
	nodes: z.array(NodeDraftSchema).min(1).max(16),
});

export const ScenarioDraftSchema = z.object({
	id: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z0-9][a-z0-9-]*$/, "lower-case letters, digits and dashes only"),
	/** A word or a number. Defaults to the id, so a scenario reproduces itself. */
	seed: z.union([z.string(), z.number()]).optional(),
	/**
	 * How the world generates, beyond the seed.
	 *
	 * The difference between choosing a world and describing one. Without this a draft
	 * can only re-roll the seed until something usable comes up; with it the author says
	 * where the towns are, how wet the map is and where the woods are thick, and the
	 * survey below runs against that world rather than the default one.
	 */
	recipe: WorldRecipeSchema.optional(),
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
			/**
			 * The last page, shown once every beat is reached and every errand closed.
			 *
			 * Optional: one is assembled from the premise and what the player actually did
			 * when nobody writes one, so a scenario always ends rather than stopping.
			 */
			ending: CardBodySchema.optional(),
			/**
			 * Outcomes to choose between, first match in author order.
			 *
			 * What makes a fork worth taking. An entry with no `when` always matches, which
			 * is how the last one becomes the catch-all.
			 */
			endings: z
				.array(
					CardBodySchema.extend({
						id: z.string().min(1).max(64),
						when: ConditionSchema.optional(),
					}),
				)
				.max(8)
				.optional(),
		})
		.optional(),
	trees: z.array(TreeDraftSchema).optional(),
	/** A tile pack directory under `.packs/tiles/`, by name. */
	tiles: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z0-9][a-z0-9-]*$/, "lower-case letters, digits and dashes only")
		.optional(),
	/** Whether this world has a clock. Absent means the ordinary day/night cycle. */
	time: TimeOptionsSchema.optional(),
	/** Things that happen because the world became a certain way. */
	triggers: z.array(TriggerSchema).max(64).optional(),
	/** Gates across the open world. */
	barriers: z.array(BarrierSchema).max(32).optional(),
	/** Particular things in particular places. */
	placements: z.array(PlacementSchema).max(64).optional(),
	/**
	 * A pack in `.packs/`, by name. The usual way to say what a world sounds like.
	 *
	 * Named rather than copied in so the pack stays one file that can be edited once
	 * and reviewed on its own. `content` below is still there for the tables this
	 * particular scenario wants differently from the pack it borrows.
	 */
	pack: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z0-9][a-z0-9-]*$/, "lower-case letters, digits and dashes only")
		.optional(),
	/**
	 * Flavour tables for this scenario, laid over the pack and then the defaults.
	 *
	 * Maps merge by key and lists replace, so overriding one trade's appearance is one
	 * line while supplying `family` means "these are the families in my world".
	 */
	content: PackOverrideSchema.optional(),
});

export type ScenarioDraft = z.infer<typeof ScenarioDraftSchema>;

export interface AssembleOptions {
	/**
	 * The tables `draft.pack` names, already read.
	 *
	 * Passed in rather than loaded here so this module stays free of the filesystem —
	 * it has to run from a validator and a test with no `.packs` directory in sight.
	 * The tool that owns the draft file is the one that can read a pack beside it.
	 */
	readonly pack?: PackOverride;
}

/**
 * Turn a draft into an artifact.
 *
 * Deterministic given the draft: the survey is recomputed from the seed and the
 * duration rather than carried in the file, so an artifact assembled twice from one
 * draft is identical, and a draft can never disagree with the world it describes.
 */
export function assembleArtifact(
	draft: ScenarioDraft,
	at: string,
	options: AssembleOptions = {},
): ScenarioArtifact {
	const brief = normalizeBrief(draft.brief) ?? {};
	const seed = resolveDraftSeed(draft);
	const world = worldSeed(seed, draft.recipe);
	const survey = surveyWorld(world, brief.duration);
	// The filler is named from the scenario's own pack, or half the world reads in a
	// different register from the half the author wrote. The named pack goes under the
	// draft's own tables, so a scenario borrowing a pack can still change one line of it.
	const pack = mergePack(DEFAULT_PACK, mergeOverride(options.pack, draft.content));

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
			: fallbackRegion(seed, context, pack);
	}

	const sites: Record<string, SiteSpec> = {};
	const draftedSites = new Map(draft.sites?.map((site) => [site.siteId, site]) ?? []);
	for (const entry of survey.sites) {
		const written = draftedSites.get(entry.site.id);
		const key = String(entry.site.id);
		if (!written) {
			// Not authored: the deterministic roster, which is a real place with real
			// people in it. This is what makes partial drafts worth assembling.
			sites[key] = fallbackSite(seed, entry.site, entry.context, pack);
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
					...(structure.lock ? { lock: structure.lock } : {}),
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
				...(npc.requires ? { requires: npc.requires } : {}),
				...(npc.stays ? { stays: true } : {}),
				...(npc.indoors ? { indoors: true } : {}),
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
		// The reference travels, not the resolved copy: `readScenarioFile` resolves it
		// again on the way in, so the artifact stays as small as the draft was.
		...(draft.pack ? { pack: draft.pack } : {}),
		...(draft.content && !isOverrideEmpty(draft.content) ? { content: draft.content } : {}),
		seed,
		...(draft.recipe ? { recipe: draft.recipe } : {}),
		spawn: survey.spawn,
		bounds: survey.bounds,
		lore: draft.lore,
		regions,
		sites,
		...(arc ? { arc } : {}),
		// Carried through untouched. There is nothing to derive these from — an author
		// writing a trigger has already said the whole of it — and being unable to write
		// them in a draft is what forced every scenario into hand-editing its artifact
		// and then never re-assembling it again.
		...(draft.tiles ? { tiles: draft.tiles } : {}),
		...(draft.time ? { time: draft.time } : {}),
		...(draft.triggers?.length ? { triggers: draft.triggers } : {}),
		...(draft.barriers?.length ? { barriers: draft.barriers } : {}),
		...(draft.placements?.length ? { placements: draft.placements } : {}),
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
		return {
			id: raw.id,
			order,
			siteId: raw.siteId,
			npcSlot: raw.npcSlot,
			requires: raw.requires ?? derivedRequires(draft.beats, order),
			setsFlag: `arc:${raw.id}`,
			...(raw.quest
				? {
						quest: {
							id: raw.id,
							name: raw.quest.name,
							description: raw.quest.description,
							objectives,
							...(raw.quest.parentId ? { parentId: raw.quest.parentId } : {}),
						},
					}
				: {}),
			...(raw.journal ? { journal: raw.journal } : {}),
			...(raw.card ? { card: raw.card } : {}),
			...(raw.optional ? { optional: true } : {}),
			...(raw.branch ? { branch: raw.branch } : {}),
			...(raw.opensOn ? { opensOn: raw.opensOn } : {}),
			...(raw.effects?.length ? { effects: raw.effects } : {}),
		};
	});
	return {
		title: draft.title,
		premise: draft.premise,
		beats,
		...(draft.ending ? { ending: draft.ending } : {}),
		...(draft.endings?.length ? { endings: draft.endings } : {}),
	};
}

/**
 * What a beat waits on, when nobody said otherwise.
 *
 * Three rules, and the last two exist because the naive chain has a trap at each end
 * of a fork — traps an author is very unlikely to catch by reading, because both look
 * fine until somebody plays the arm that was not tested.
 *
 * 1. Ordinarily: the beat before it.
 * 2. **Skipping side errands.** Chaining onto an optional beat makes the main story
 *    wait on an errand the player was explicitly told they could ignore.
 * 3. **Rejoining a fork with `any`.** A beat after a fork must accept *either* arm.
 *    Waiting on one arm dead-ends the other; waiting on the beat before the fork lets
 *    the fork be skipped entirely, which leaves `remaining` above zero forever because
 *    neither arm was ever barred. `{ any: [...] }` is the only spelling that survives
 *    both, and deriving it means an author never has to know that.
 */
function derivedRequires(
	beats: readonly z.infer<typeof BeatDraftSchema>[],
	order: number,
): ScenarioBeat["requires"] {
	// An arm of a fork waits on what came *before* the fork, never on its siblings —
	// they are alternatives, so waiting on one would make the other unreachable and the
	// fork a corridor.
	const group = beats[order]?.branch;
	let index = order - 1;
	while (index >= 0) {
		const candidate = beats[index];
		if (!candidate) break;
		if (!candidate.optional && !(group !== undefined && candidate.branch === group)) break;
		index--;
	}

	const previous = beats[index];
	if (!previous) return [];
	if (previous.branch === undefined) return [`arc:${previous.id}`];

	// Every arm of the group that ends here, however many were written and wherever
	// they sit among the optional beats that were just skipped.
	const arms = beats
		.slice(0, index + 1)
		.filter((beat) => beat.branch === previous.branch)
		.map((beat) => ({ flag: `arc:${beat.id}` }));
	return arms.length > 1 ? { any: arms } : (arms[0] ?? []);
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
				...(node.requires
					? { requires: node.requires }
					: node.requiresFlag
						? { requires: [node.requiresFlag] }
						: {}),
				choices: node.choices.map((choice) => ({
					text: choice.text,
					goto: choice.goto,
					...(choice.requires
						? { requires: choice.requires }
						: choice.requiresFlag
							? { requires: [choice.requiresFlag] }
							: {}),
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
			if (option.when) {
				nodes[option.node] = { ...node, requires: option.when };
				continue;
			}
			if (option.flag === undefined) continue;
			// The flag spelling stays a list, which is what every draft has produced so
			// far. A node already carrying a full condition is left alone rather than
			// being silently widened into an `all`.
			const already = Array.isArray(node.requires) ? node.requires : undefined;
			if (already === undefined && node.requires !== undefined) continue;
			if (already?.includes(option.flag)) continue;
			nodes[option.node] = { ...node, requires: [...(already ?? []), option.flag] };
		}

		// Gated openings first, so the most specific one that qualifies is used.
		const gated = (draft.entryAfter ?? []).map((option) => option.node).filter((n) => nodes[n]);
		const entry = [...gated, draft.entry].filter((node) => nodes[node]);
		if (entry.length === 0) continue;
		// The gated openings go in front of `revisit` too, and this is not a nicety:
		// `openingNode` consults `revisit` first on every meeting after the first, and a
		// plain revisit node requires nothing, so it always qualifies. A tree with both a
		// `revisit` and an `entryAfter` therefore *never* reached the alternative opening
		// — which is the one that carries the fork, the reward, or the scene after the
		// story moved. Written once, unreadable ever after the first hello.
		//
		// Only when there is a revisit node to shadow it: with none, `openingNode` falls
		// through to `entry`, which already leads with the same gated openings.
		const hasRevisit = draft.revisit !== undefined && nodes[draft.revisit] !== undefined;
		trees[id] = {
			npcId: id,
			entry,
			...(hasRevisit ? { revisit: [...gated, draft.revisit as string] } : {}),
			nodes,
		};
	}
	return trees;
}
