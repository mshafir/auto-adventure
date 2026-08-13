import { escalationModel, MODELS } from "../../config.js";
import { DEFAULT_PACK } from "../../core/content/default.js";
import { mergePack, type PackOverride } from "../../core/content/pack.js";
import {
	type ArcEnding,
	beatNpcId,
	type ScenarioArc,
	type ScenarioBeat,
} from "../../core/rules/arc.js";
import type { Placement } from "../../core/rules/placement.js";
import type { QuestObjective } from "../../core/rules/state.js";
import type { ScenarioBrief } from "../../core/world/brief.js";
import { mergeRecipe, type WorldRecipe, worldSeed } from "../../core/world/recipe.js";
import type { NpcSpec, RegionSpec, SiteSpec, WorldLore } from "../../core/world/spec.js";
import { npcId } from "../../core/world/spec.js";
import { ARTIFACT_VERSION, type ScenarioArtifact } from "../../scenario/artifact.js";
import { fitSideQuests } from "../../scenario/fit.js";
import { inspect, repairUntilClean, score } from "../../scenario/repair.js";
import { settleTheStory } from "../../scenario/settle.js";
import { signpostsFor } from "../../scenario/signposts.js";
import {
	planFor,
	type Survey,
	storySites,
	surveyWorld,
	walkableSites,
} from "../../scenario/survey.js";
import { buildPassability, type Finding, siteIndex } from "../../scenario/validate.js";
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
import { adjustTheStory } from "./adjust.js";
import { mendArtifact } from "./mend.js";
import {
	ARC_SYSTEM,
	arcPrompt,
	SHAPE_SYSTEM,
	shapePrompt,
	TREE_SYSTEM,
	treePrompt,
} from "./prompts.js";
import { authorReactions, type Reactions } from "./reactions.js";
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
	/**
	 * The content pack this scenario is being written for.
	 *
	 * Needed here rather than only at play time because a pack has two halves. The
	 * cosmetic half names the people a place with no model gets; the recipe fragment says
	 * what the place is built out of. Attaching the pack to the artifact afterwards —
	 * which is what `generate.ts` did, and all it could do — meant a Camelot world was
	 * surveyed, plotted and populated as an ordinary one and then handed a Camelot
	 * vocabulary at the door.
	 */
	readonly pack?: PackOverride;
	/** What that pack is called, for the artifact to point at. */
	readonly packName?: string;
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
const ARC_TIMEOUT_MS = 240_000;

/**
 * How long any *other* authoring call may take.
 *
 * The client's default is twenty seconds, and it is twenty seconds for a reason that
 * does not apply here: it is tuned for the live director, where a call has to resolve
 * before the player walks into the chunk that needs it. Nothing is walking anywhere
 * during authoring. The player is watching a progress screen that already says the
 * elapsed time.
 *
 * Left at the default, that mismatch is silent and expensive. A reasoning model —
 * `openai/gpt-5-mini` among them — routinely spends more than twenty seconds on a
 * prompt this size, so every attempt timed out, every retry timed out, and the run
 * came out with fallback lore, procedural place names and *no conversations at all*:
 * a world where every beat opens, drops an errand in the journal, and has nothing to
 * say for it. Nothing failed loudly. It simply cost four minutes and produced a
 * degraded world, and the only trace was a wall of `WARN ai … aborted` in a log file.
 *
 * Three minutes, measured rather than guessed. A `tiny` world on `openai/gpt-5-nano`
 * — the *cheap* half of that pair, on the smallest world this tool can produce — spent
 * between 25 and 90 seconds per site call, with one landing at 89.9s. A ceiling the
 * slowest observed call grazes is a ceiling that will be crossed by the next prompt
 * that happens to be a little longer, and the symptom is not an error but a quietly
 * thinner world.
 */
const AUTHOR_TIMEOUT_MS = 180_000;

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
	/**
	 * What is still wrong with it, after everything that could be fixed was.
	 *
	 * Handed back rather than left for the caller to re-derive, because deriving it means
	 * generating the whole bounded world again — several seconds of the slowest work in
	 * the pipeline, to recompute an answer this pass already had.
	 */
	readonly findings: readonly Finding[];
	/** What the repair pass changed, in the words of the faults it removed. */
	readonly repairs: readonly string[];
	/**
	 * The main-line beat that could not be settled, when one could not.
	 *
	 * Absent means every main-line beat opened and closed in a real session, which is a far
	 * stronger statement than "no findings". Present means the story does not play, and the
	 * boundary declines to write the world on the strength of it — so this is the one field here
	 * that decides something rather than reporting it.
	 */
	readonly unplayable?: {
		readonly beat: string;
		readonly why: string;
		/** Every fix tried on it, in words, in the order they were tried. */
		readonly tried: readonly string[];
	};
}

/**
 * The lore, with the player's own choices put back over it.
 *
 * `lorePrompt` asks for these too, and asking is not enough on its own: a model told to
 * preserve a field preserves it most of the time, and the times it does not are a player who
 * picked a world by its name being overruled by a machine on the one decision they made
 * before paying for it.
 *
 * Two fields and no more. The era, the factions, the deities and the premise as the model
 * chose to phrase it are the pass's own work, and a brief that named a world is not a brief
 * that wrote one.
 *
 * Exported for its test: the pass around it runs six model calls, and a rule buried inside
 * one of them is a rule the next person deletes by accident.
 */
export function bindLore(written: WorldLore, brief: ScenarioBrief | undefined): WorldLore {
	const title = brief?.title?.trim();
	const tone = brief?.tone?.trim();
	if (!title && !tone) return written;
	return {
		...written,
		...(title ? { title } : {}),
		...(tone ? { tone } : {}),
	};
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
			timeoutMs: AUTHOR_TIMEOUT_MS,
			...abortable,
		});
		if (shape) {
			calls++;
			recipe = recipeFor(shape);
			say(`world: ${shape.sea} sea, ${shape.climate}, ${shape.wet}, ${shape.settled}ly settled`);
		}
	}

	// --- pass 1: survey ------------------------------------------------------
	// Free apart from the reachability sweep below, which is one generation of the whole
	// bounded world — the same work the validator does at the end, done first so the story
	// is never plotted somewhere it would then be refused.
	// The pack's recipe fragment goes under whatever the caller asked for, so a scenario
	// that names a pack *and* states a climate keeps its own climate. Folded in before
	// the survey, because everything after this point is measured against the world it
	// produces — see `PackOverride.world` for why it cannot be consulted later.
	recipe = mergeRecipe(options.pack?.world, recipe);
	const world = worldSeed(options.seed, recipe);
	const pack = mergePack(DEFAULT_PACK, options.pack);
	const survey = surveyWorld(world, options.brief.duration, recipe);
	// Sites the survey had to make bigger so they could hold the roster they will be asked
	// for. Folded into the recipe here, because growth that lived only in the survey would
	// be a town that shrank the next time the artifact was opened, with every placement in
	// it written against the larger one.
	if (survey.places.length > 0) {
		recipe = { ...recipe, places: [...(recipe?.places ?? []), ...survey.places] };
	}
	// Which of them the player can actually get to. A straight line is the right measure
	// for ordering a story outward and the wrong one for deciding a place can be visited:
	// a town across an inlet is thirty tiles away and unreachable, and a beat set there is
	// a story that cannot be finished. Costs one sweep of the bounded world, paid here so
	// that sixty model calls are not spent writing a scene nobody can walk to.
	const walkable = walkableSites(survey);
	const settlements = storySites(survey).filter((entry) => walkable.has(entry.site.id));
	say(
		`surveyed ${survey.sites.length} sites (${settlements.length} settlements) in a ${
			survey.bounds.maxX - survey.bounds.minX
		}-tile world`,
	);
	const stranded = survey.sites.length - walkable.size;
	if (stranded > 0)
		say(`${stranded} place(s) cannot be walked to from the start; the story will not go there`);
	if (survey.boundaryAdjustment !== 0)
		say(`moved the boundary ${survey.boundaryAdjustment} tiles to avoid cutting a town in half`);
	const madeRoom = Object.keys(survey.grown).length;
	if (madeRoom > 0)
		say(
			`made room in ${madeRoom} place${madeRoom === 1 ? "" : "s"} for what they will be asked to hold`,
		);

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
	const written =
		(await structured({
			kind: "bible",
			model: MODELS.bible,
			schema: WorldLoreSchema,
			system: LORE_SYSTEM,
			prompt: lorePrompt(options.brief),
			temperature: 1,
			timeoutMs: AUTHOR_TIMEOUT_MS,
			...abortable,
		})) ?? fallbackLore();
	const lore = bindLore(written, options.brief);
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
			timeoutMs: AUTHOR_TIMEOUT_MS,
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
					timeoutMs: AUTHOR_TIMEOUT_MS,
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
			: fallbackSite(world, entry.site, entry.context, pack);
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

	// --- pass 4b: what the world does about it -------------------------------
	// After the arc because everything it writes hangs off a flag the arc set, and before
	// the dialogue because it is one call rather than one per person — a run that dies in
	// the long pass should already have the short one banked.
	let reactions: Reactions = { triggers: [], barriers: [] };
	if (arc) {
		const castles = survey.sites
			.filter((entry) => entry.site.kind === "castle")
			.map((entry) => ({
				siteId: entry.site.id,
				name:
					sites[String(entry.site.id)]?.name ??
					`the castle at ${entry.site.site.x},${entry.site.site.y}`,
				description: sites[String(entry.site.id)]?.description ?? "A castle.",
			}));
		const result = await authorReactions({ lore, arc, castles, ...abortable });
		if (result.called) calls++;
		reactions = result.reactions;
		if (reactions.triggers.length + reactions.barriers.length > 0)
			say(
				`the world answers: ${reactions.triggers.length} reaction(s)${
					reactions.barriers.length > 0 ? `, ${reactions.barriers.length} gate(s) barred` : ""
				}`,
			);
	}
	stopIfAsked("the world's reactions");

	// --- pass 5: dialogue ----------------------------------------------------
	const trees: Record<string, DialogueTree> = {};
	if (!options.skipTrees) {
		const everyone = Object.values(sites).flatMap((spec) =>
			spec.npcs.map((npc) => ({ spec, npc })),
		);
		/*
		 * Who is worth paying a prose model to write for.
		 *
		 * Everybody, normally: a town where only the plot speaks in its own voice is a
		 * town of shopfronts. But this pass is one call per person and it dominates the
		 * bill — a measured `tiny` run spent 20 of its 40 calls here, which is most of
		 * the reason the cheap size was not cheap.
		 *
		 * So the smallest size writes for the people the story hangs on and nobody else.
		 * That is the size whose whole purpose is to exercise the pipeline rather than to
		 * be played, and it still exercises this pass — the anchors go through exactly the
		 * same call. Everyone else falls back to the deterministic menu, which is built
		 * from what they know and is a real conversation, and which `tiny` was never
		 * going to be judged on.
		 */
		const anchors = new Set((arc?.beats ?? []).map((beat) => beatNpcId(beat)));
		const brief = options.brief.duration === "tiny";
		const people = brief
			? everyone.filter(({ spec, npc }) => anchors.has(npcId(spec.siteId, npc.slot)))
			: everyone;
		if (brief && people.length < everyone.length) {
			say(
				`writing conversations for the ${people.length} the story turns on, not all ${everyone.length}`,
			);
		}
		await pooled(people, concurrency, async ({ spec, npc }) => {
			const id = npcId(spec.siteId, npc.slot);
			const beat = arc?.beats.find(
				(candidate) => candidate.siteId === spec.siteId && candidate.npcSlot === npc.slot,
			);
			// Where this scene sends the player, so the person handing out the errand can say
			// so in their own voice. Only across a real journey: telling somebody to go to the
			// town they are standing in reads as the character not knowing where they are.
			const onward = beat && arc ? nextStop(arc, beat, sites) : undefined;
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
				...(onward ? { sendsTo: onward } : {}),
				availableFlags: (arc?.beats ?? []).map((candidate) => candidate.setsFlag),
				...abortable,
			});
			calls++;
			if (tree) trees[id] = tree;
		});
		const written = Object.keys(trees).length;
		// Against what was *attempted*, not against the whole cast: the smallest size
		// deliberately writes for a handful of people, and measuring that against twenty
		// would report a healthy run as a failed one every single time.
		// Said as a fraction, and said loudly when the fraction is bad. "wrote 12
		// conversations" reads as success whether the world has twelve people or ninety,
		// and a run where every single call failed reported "wrote 0 conversations" in the
		// same even tone as everything else — one line, scrolled past, and the player was
		// handed a story whose every scene was missing.
		say(`wrote ${written} of ${people.length} conversations`);
		if (written < people.length / 2) {
			const unwritten = (arc?.beats ?? []).filter((beat) => !trees[beatNpcId(beat)]).length;
			say(
				`most of the dialogue pass failed — ${unwritten} of ${arc?.beats.length ?? 0} story scenes are unwritten`,
			);
		}
	}
	// Last check, before anything is assembled. Past here the artifact exists and is
	// worth keeping: stopping would throw away a finished world to save nothing.
	stopIfAsked("the conversations");

	const drafted: ScenarioArtifact = {
		artifactVersion: ARTIFACT_VERSION,
		id: options.id,
		title: arc?.title ?? lore.title,
		blurb: arc?.premise ?? lore.premise,
		brief: options.brief,
		seed: options.seed,
		// Named here rather than stapled on by `generate.ts` afterwards, because the
		// repair loop below validates this artifact several times and `goodsFor` needs
		// something to resolve. A world authored against a pack's catalogue and then
		// checked against the built-in one is the exact disagreement `obtainableItems`
		// exists to prevent.
		...(options.packName ? { pack: options.packName } : {}),
		...(recipe ? { recipe } : {}),
		spawn: survey.spawn,
		bounds: survey.bounds,
		lore,
		regions,
		sites,
		...(arc ? { arc } : {}),
		...(reactions.triggers.length > 0 ? { triggers: reactions.triggers } : {}),
		...(reactions.barriers.length > 0 ? { barriers: reactions.barriers } : {}),
		...(plotted?.placements.length ? { placements: plotted.placements } : {}),
		...(Object.keys(trees).length > 0 ? { trees } : {}),
		authoredWith: {
			models: { bible: MODELS.bible, director: MODELS.director, dialogue: MODELS.dialogue },
			calls,
			at: new Date().toISOString(),
		},
	};

	// --- pass 5b: put up the signposts ---------------------------------------
	// Free, and worth doing before anything is checked so the validator judges the world
	// the player will actually walk. It costs one sweep of the bounded world, which is the
	// most expensive non-model work in the pipeline — paid here once rather than inside the
	// derivation, so the repair loop below is not made to pay for it again.
	const posted = signpostsFor(drafted, buildPassability(drafted), siteIndex(drafted));
	for (const gap of posted.missed) say(gap);
	if (posted.signs.length > 0) {
		say(`put up ${posted.signs.length} signpost(s) on the way out of town`);
	}
	const signed: ScenarioArtifact =
		posted.signs.length > 0 ? { ...drafted, signs: posted.signs } : drafted;

	// --- pass 6: check it, and fix what can be fixed --------------------------
	// Here rather than in the callers, so the CLI and the launcher get the same world
	// from the same input. It costs a few seconds of world generation at the end of a
	// run that has already spent minutes, and it is the only pass that measures the
	// others: everything above this line is a model being asked to be careful.
	say("checking the world against itself");
	const mechanical = repairUntilClean(signed, say);
	let artifact = mechanical.artifact;
	let findings = mechanical.findings;
	const repairs = [...mechanical.repairs];

	// --- pass 7: the faults that need words ----------------------------------
	// Last, and bounded, because passes 1–6 should have made it rare. Kept only if the
	// validator agrees it helped: a rewritten conversation is a real change to the world,
	// and one that trades a spoken fork for a broken tree is not a repair.
	if (findings.length > 0 && !options.skipTrees) {
		const mended = await mendArtifact({
			artifact,
			writeTree,
			onProgress: say,
			...abortable,
		});
		calls += mended.calls;
		if (mended.repairs.length > 0) {
			// The same two halves the mechanical loop is judged on. A rewritten conversation
			// can point at a node it no longer contains — which `validate.ts` has nothing to
			// say about and `readScenarioFile` refuses outright — so weighing only the
			// expensive check would let a mend produce a world the launcher will not open.
			//
			// The refusals are carried into both sides of the comparison, because they are in
			// `findings` and `inspect` does not produce them. Leaving them out of `after` alone
			// would make every mend look like an improvement by exactly the weight of a fault it
			// had nothing to do with.
			const after = [
				...inspect(mended.artifact),
				...mechanical.refused.map((message) => ({ severity: "error" as const, message })),
			];
			if (score(after) < score(findings)) {
				artifact = mended.artifact;
				findings = after;
				repairs.push(...mended.repairs);
			} else {
				say("the rewrites made nothing better; kept the world as it was");
			}
		}
	}

	// --- pass 8: play it ------------------------------------------------------
	// The only pass that makes a claim rather than an inspection: every beat of the main line
	// opened and closed in a real session. It fixes what it can as it goes — somebody standing
	// in a building that was never built, a thing hidden in a room that does not exist, a site
	// with no room for the buildings the story was written against — and where it cannot, it
	// says which beat and what it tried.
	//
	// A beat it cannot settle is carried out in {@link AuthorResult.unplayable}, and the boundary
	// declines to write the world on the strength of it. That is the whole point of the pass: a
	// story that stops at its second scene is not a world with a blemish, it is a world that
	// cannot be played, and the player is offered another rather than handed this one.
	//
	// After the rewrites rather than before, so the walk plays the artifact that will actually
	// be written: a mend that changed a conversation after the walk would make the walk's claim
	// stale.
	say("playing the story through");
	const settled = await settleTheStory(artifact, say);
	let settledArtifact = settled.artifact;
	// Every fault a pass looked at and deliberately left, in one list. The repairs' refusals are
	// already in `findings`; the two passes below add their own, and both kinds are the same
	// thing — something wrong that could only have been fixed by taking story away.
	const refusals = [...mechanical.refused];
	repairs.push(...settled.fixes);
	if (Object.keys(settled.grown).length > 0) {
		say(`made room in ${Object.keys(settled.grown).length} place(s) the story had outgrown`);
	}
	if (settled.settled) {
		say(`walked ${settled.opened.length} beat(s) of the main line to the end`);
	} else {
		say(
			`beat ${settled.stuck?.beat} could not be settled: ${settled.stuck?.why}${
				settled.stuck?.tried.length ? ` (tried ${settled.stuck.tried.join("; ")})` : ""
			}`,
		);
	}
	for (const concession of settled.concessions) say(`given: ${concession}`);

	// --- pass 9: fit the side quests ------------------------------------------
	// Only once the main line stands, and both of the next two passes are skipped otherwise for
	// the same reason: arranging the side errands of a story that does not play is arranging the
	// furniture in a house with no floor, and the pass after this one would be a paid call about
	// it.
	const sideQuests: string[] = [];
	if (settled.settled) {
		const fitted = await fitSideQuests(settledArtifact, say);
		sideQuests.push(...fitted.fitted);
		repairs.push(...fitted.fixes, ...fitted.dropped);
		// The refusals join the findings, as the repair pass's do: a side errand that would not
		// fit and could not be dropped is a fault a person should be shown.
		refusals.push(...fitted.refused);
		for (const concession of fitted.concessions) say(`given: ${concession}`);
		if (fitted.fitted.length > 0 || fitted.dropped.length > 0) {
			say(`fitted ${fitted.fitted.length} side errand(s), dropped ${fitted.dropped.length}`);
		}
		settledArtifact = fitted.artifact;
	}

	// --- pass 10: say what the story makes of them -----------------------------
	// Gated on `skipTrees` as well, since that is the flag that already means "spend no model
	// calls" and this is the last one in the run.
	if (settled.settled && sideQuests.length > 0 && !options.skipTrees) {
		const adjusted = await adjustTheStory({
			artifact: settledArtifact,
			fitted: sideQuests,
			onProgress: say,
			...abortable,
		});
		calls += adjusted.calls;
		repairs.push(...adjusted.changes);
		// Reported rather than swallowed. A pass that quietly declines to keep its own work reads
		// exactly like a pass that was never run.
		if (adjusted.discarded)
			refusals.push(`the story's own adjustment was dropped: ${adjusted.discarded}`);
		settledArtifact = adjusted.artifact;
	}

	// Re-checked only when the last three passes changed something, because a finding their fixes
	// removed should not still be reported at the end of the run — and re-deriving them means
	// generating the whole bounded world again.
	//
	// The refusals are carried across rather than recomputed. `inspect` does not know about
	// them — they are a repair declining to shorten the main story, not a property of the
	// artifact — and settling cannot resolve one either, because what it declined to delete is
	// story rather than placement. Dropping them here would make a main-line fault vanish from
	// the report precisely when the pass beside it had been busy.
	const asError = (message: string) => ({ severity: "error" as const, message });
	if (settledArtifact !== artifact) {
		artifact = settledArtifact;
		findings = [...inspect(artifact), ...refusals.map(asError)];
	} else if (refusals.length > mechanical.refused.length) {
		// Nothing was written to, so the expensive half would answer exactly what it answered
		// before; only the refusals are new, and re-deriving the rest would cost a sweep of the
		// bounded world to be told so.
		findings = [...findings, ...refusals.slice(mechanical.refused.length).map(asError)];
	}

	say(
		findings.length === 0
			? "nothing wrong with it"
			: `${findings.filter((finding) => finding.severity === "error").length} error(s), ${
					findings.filter((finding) => finding.severity !== "error").length
				} warning(s)`,
	);
	/*
	 * A world with no story at all is unplayable too, and nothing else here can say so.
	 *
	 * `settleTheStory` reports a world with no arc as settled, correctly — there is nothing to
	 * walk and walking nothing succeeds — so a run whose arc pass came back empty passed every
	 * check in the pipeline and was written out as a finished scenario. What the player got was
	 * a map with people on it who have nothing to say about anything, which is the one thing a
	 * *prebuilt* scenario is for and the one thing it did not have.
	 *
	 * Found by running this for real: two live runs in a row printed "no story could be plotted"
	 * and everything after it reported a clean world.
	 */
	const storyless =
		!artifact.arc || artifact.arc.beats.length === 0
			? {
					beat: "the story itself",
					why: "no story could be plotted for this world",
					tried: [] as string[],
				}
			: undefined;

	return {
		artifact,
		calls,
		findings,
		repairs,
		...(settled.stuck ? { unplayable: settled.stuck } : storyless ? { unplayable: storyless } : {}),
	};
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
	/** Which fork each beat written so far belongs to, for the sibling check below. */
	const branchOf = (id: string) => beats.find((beat) => beat.id === id)?.branch;
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
		//
		// And never a sibling arm of the same fork. The model reliably conflates "these are
		// alternatives" with "this follows that", and writing both makes each arm wait on a
		// flag only the *other* arm sets — so whichever the player picks, the beat they
		// picked can never open and the story stops at the choice. Dropping the parent
		// leaves the arm waiting on whatever came before the fork, which is what an arm
		// should wait on.
		const named =
			raw.partOf && seen.has(raw.partOf) && raw.partOf !== raw.id ? raw.partOf : undefined;
		const sibling =
			named !== undefined && raw.branch !== undefined && branchOf(named) === raw.branch;
		if (sibling) {
			logger.debug(`arc: ${raw.id} is an arm of ${raw.branch}, not a step of ${named}`);
		}
		const parent = sibling ? undefined : named;

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

/**
 * Where the story goes after this beat, in words a character could say.
 *
 * The main line only, and only when it leads somewhere else. A side errand is something
 * the player chooses to go looking for, so sending them off to one from the main line's
 * own scene would be the story recommending its own detour; and a beat whose successor is
 * in the same settlement is a scene followed by another scene, which needs no directions.
 */
export function nextStop(
	arc: ScenarioArc,
	after: ScenarioBeat,
	sites: Readonly<Record<string, SiteSpec>>,
): { readonly place: string; readonly person?: string } | undefined {
	const main = arc.beats.filter((beat) => !beat.optional).sort((a, b) => a.order - b.order);
	const at = main.findIndex((beat) => beat.id === after.id);
	const next = at >= 0 ? main[at + 1] : undefined;
	if (!next || next.siteId === after.siteId) return undefined;

	const spec = sites[String(next.siteId)];
	if (!spec) return undefined;
	const person = spec.npcs.find((npc) => npc.slot === next.npcSlot);
	return { place: spec.name, ...(person ? { person: person.name } : {}) };
}

export interface WriteTreeInput {
	readonly lore: WorldLore;
	readonly site: SiteSpec;
	readonly npc: NpcSpec;
	readonly id: string;
	readonly beat?: {
		readonly summary: string;
		readonly setsFlag: string;
		readonly questName?: string;
	};
	/** Where this scene sends the player, when it is a scene that sends them anywhere. */
	readonly sendsTo?: {
		readonly place: string;
		readonly person?: string;
	};
	readonly availableFlags: readonly string[];
	/** Flags a reply must be hidden behind. Used by the repair pass, not the first run. */
	readonly insist?: readonly string[];
	/** What was wrong with the last attempt, for a rewrite. See `treePrompt`. */
	readonly notes?: readonly string[];
	readonly signal?: AbortSignal;
}

export async function writeTree(input: WriteTreeInput): Promise<DialogueTree | undefined> {
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
			...(input.sendsTo ? { sendsTo: input.sendsTo } : {}),
			availableFlags: input.availableFlags,
			...(input.insist ? { insist: input.insist } : {}),
			...(input.notes ? { notes: input.notes } : {}),
		}),
		temperature: 0.85,
		timeoutMs: AUTHOR_TIMEOUT_MS,
		// The one call in the pipeline that is both expensive to lose and measurably
		// flaky: a conversation nobody wrote is a person with nothing to say, and the
		// tree schema is the largest thing any model here is asked to fill in.
		...(escalationModel() ? { escalateTo: escalationModel() as string } : {}),
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
