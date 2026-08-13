import { MODELS } from "../../config.js";
import type { ArcEnding, ScenarioArc, ScenarioBeat } from "../../core/rules/arc.js";
import { orderedBeats } from "../../core/rules/arc.js";
import type { Condition } from "../../core/rules/condition.js";
import type { QuestObjective } from "../../core/rules/state.js";
import { namesMatch } from "../../core/rules/surroundings.js";
import { npcId, type SiteSpec } from "../../core/world/spec.js";
import type { ScenarioArtifact } from "../../scenario/artifact.js";
import { walkMainLine, withStory } from "../../scenario/play.js";
import { inspect, score } from "../../scenario/repair.js";
import { structured } from "../client.js";
import { ADJUST_SYSTEM, adjustPrompt } from "./prompts.js";
import { type AdjustmentResponse, AdjustmentSchema } from "./schemas.js";

/**
 * What the story says about the side errands that survived.
 *
 * The one pass that could not have run earlier. Which side quests fitted is a fact about the
 * ground — some of them were dropped because no plot could hold what they needed — and it is not
 * known until they have been placed in a real world. So anything the story wants to say *about*
 * them has to be written afterwards, which is what this is.
 *
 * **Constrained to what needs no map and no placement.** The call may only name settlements,
 * people and things the artifact already contains, and may only add beats anchored on them. That
 * constraint is what makes the pass cheap and safe, and it is enforced on the way in: a returned
 * beat naming anything unknown is rejected rather than repaired.
 *
 * **And never an alternative main-line beat**, which the spec asks for and this deliberately does
 * not do. Making one available means changing what an existing beat requires, and the main line
 * has already been walked and settled against what it requires now — so a story that gained an
 * unreachable step here would be exactly the failure the walk exists to prevent, arriving one
 * pass after the walk. A new beat is therefore always a side errand, gated on the side errands it
 * is about, which is the same content delivered without touching the settled line.
 *
 * **Verified, not assumed.** The changes are text and arc only, so the re-walk should pass
 * smoothly — which is precisely why it is worth running: a pass that is expected to succeed and
 * is never checked is how an unreachable beat ships. If it fails, the adjustment is discarded
 * *wholesale*. Not repaired, not partly applied: the world was already playable before this pass,
 * this is an enhancement, and chasing a fix for it would spend the main line's guarantee on a
 * flourish.
 */

export interface AdjustInput {
	readonly artifact: ScenarioArtifact;
	/** Ids of the optional beats that fitted. Nothing to adjust to when this is empty. */
	readonly fitted: readonly string[];
	/** Injected so the pass can be tested without a key and a minute. */
	readonly ask?: (input: AdjustInput) => Promise<AdjustmentResponse | undefined>;
	readonly onProgress?: (message: string) => void;
	readonly signal?: AbortSignal;
}

export interface AdjustResult {
	readonly artifact: ScenarioArtifact;
	readonly calls: number;
	/** What was applied, in words. */
	readonly changes: readonly string[];
	/** Why the whole adjustment was thrown away, when it was. */
	readonly discarded?: string;
}

/** As long as the rest of the offline authoring calls get. See `AUTHOR_TIMEOUT_MS`. */
const ADJUST_TIMEOUT_MS = 180_000;

/**
 * How long the verifying walk may take.
 *
 * Shorter than settling's minute, because this walks a story that has already settled over caches
 * that are already warm: what is left is engine commands. A walk that somehow needs longer than
 * this has found something worth discarding the adjustment over anyway.
 */
const VERIFY_BUDGET_MS = 30_000;

export async function adjustTheStory(input: AdjustInput): Promise<AdjustResult> {
	const say = input.onProgress ?? (() => undefined);
	const arc = input.artifact.arc;
	// Skipped entirely when nothing fitted. There is nothing to adjust to, and a call spent to be
	// told so is a call wasted.
	if (!arc || input.fitted.length === 0) {
		return { artifact: input.artifact, calls: 0, changes: [] };
	}

	const response = await (input.ask ?? askForAdjustment)(input);
	if (!response) return { artifact: input.artifact, calls: 0, changes: [] };

	const lowered = lowerAdjustment(response, input.artifact, input.fitted);
	for (const said of lowered?.rejected ?? []) say(said);
	if (!lowered) {
		say("the story had nothing to add about the side errands");
		return { artifact: input.artifact, calls: 1, changes: [] };
	}

	const candidate: ScenarioArtifact = { ...input.artifact, arc: lowered.arc };
	const walk = await withStory(candidate, (playing) =>
		walkMainLine(candidate, playing, Date.now() + VERIFY_BUDGET_MS),
	);
	// Both halves, as every other repair here is judged: the walk says whether the story still
	// plays, and the offline checks say whether a new beat waits on something nothing sets.
	const worse = score(inspect(candidate)) > score(inspect(input.artifact));
	if (walk.stuck || worse) {
		const why = walk.stuck
			? `beat ${walk.stuck.beat} would not open afterwards: ${walk.stuck.why}`
			: "it left more wrong with the world than it found";
		say(`the adjustment was dropped — ${why}`);
		return { artifact: input.artifact, calls: 1, changes: [], discarded: why };
	}

	for (const change of lowered.changes) say(change);
	return { artifact: candidate, calls: 1, changes: lowered.changes };
}

async function askForAdjustment(input: AdjustInput): Promise<AdjustmentResponse | undefined> {
	const artifact = input.artifact;
	const arc = artifact.arc;
	if (!arc) return undefined;
	const beats = orderedBeats(arc);
	const sites = Object.values(artifact.sites);

	return await structured({
		kind: "site",
		model: MODELS.bible,
		schema: AdjustmentSchema,
		system: ADJUST_SYSTEM,
		prompt: adjustPrompt({
			lore: artifact.lore,
			beats: beats.map((beat) => shown(artifact, beat)),
			fitted: input.fitted.map((id) => ({
				summary: summaryOf(beats.find((beat) => beat.id === id)) ?? id,
			})),
			sites: sites.map((spec) => ({ spec })),
		}),
		// Warmer than the reading pass's 0.2 and cooler than the arc's 0.9. This one is writing
		// rather than judging, so it needs room; but it is writing *about* a world that already
		// exists, and invention is the failure mode a whole validation layer here exists to catch.
		temperature: 0.7,
		timeoutMs: ADJUST_TIMEOUT_MS,
		...(input.signal ? { signal: input.signal } : {}),
	});
}

function shown(
	artifact: ScenarioArtifact,
	beat: ScenarioBeat,
): { place: string; person: string; summary: string; optional: boolean } {
	const spec = artifact.sites[String(beat.siteId)];
	const npc = spec?.npcs.find((person) => person.slot === beat.npcSlot);
	return {
		place: spec?.name ?? `site ${beat.siteId}`,
		person: npc ? `${npc.name} the ${npc.role}` : "nobody",
		summary: summaryOf(beat) ?? beat.id,
		optional: Boolean(beat.optional),
	};
}

function summaryOf(beat: ScenarioBeat | undefined): string | undefined {
	if (!beat) return undefined;
	return beat.journal ?? beat.quest?.description ?? beat.id;
}

export interface Adjustment {
	readonly arc: ScenarioArc;
	/** What was applied, in words. */
	readonly changes: readonly string[];
	/** What was refused on the way in, in words. */
	readonly rejected: readonly string[];
}

/**
 * Turn the model's indices into an arc, refusing anything that names what is not here.
 *
 * Separated from the call so it can be tested without one, as `lowerArc` is — and it carries more
 * weight than `lowerArc` does, because this runs *after* the world has been declared playable.
 * Everything it lets through has to be true of the artifact as it stands.
 *
 * Returns nothing at all when nothing survived, so the caller can tell "the model wrote something
 * unusable" from "the model wrote nothing", and skip the walk in both cases.
 */
export function lowerAdjustment(
	response: AdjustmentResponse,
	artifact: ScenarioArtifact,
	fitted: readonly string[],
): Adjustment | undefined {
	const arc = artifact.arc;
	if (!arc) return undefined;
	const changes: string[] = [];
	const rejected: string[] = [];
	const sites = Object.values(artifact.sites);
	const beats = orderedBeats(arc);
	const taken = new Set(arc.beats.map((beat) => beat.id));

	/** The flags a `needs` list resolves to, or nothing if any of it names what did not fit. */
	const needed = (indices: readonly number[], what: string): Condition | undefined => {
		const ids = indices.map((index) => fitted[index]);
		if (ids.length === 0 || ids.some((id) => id === undefined)) {
			rejected.push(`${what} waits on a side errand that is not in this world; left it out`);
			return undefined;
		}
		const flags = ids.map((id) => ({ flag: `arc:${id as string}` }));
		return flags.length === 1 ? (flags[0] as Condition) : { all: flags };
	};

	const revised = new Map<string, { journal?: string; errand?: string }>();
	for (const revision of response.revisions) {
		const beat = beats[revision.beat];
		if (!beat) {
			rejected.push(`a revision named beat ${revision.beat}, which is not in this story`);
			continue;
		}
		// Text only, and nothing else about the beat is reachable from here. Where a beat
		// happens, who opens it and what it sets are what the walk has already proved, and a
		// revision that could change them would invalidate the proof it is written on top of.
		revised.set(beat.id, {
			...(revision.journal ? { journal: revision.journal } : {}),
			...(revision.errand ? { errand: revision.errand } : {}),
		});
		changes.push(`beat ${beat.id}: said again, now that the side errands are known`);
	}

	const added: ScenarioBeat[] = [];
	let order = Math.max(...beats.map((beat) => beat.order), -1);
	for (const raw of response.beats) {
		const spec = sites[raw.siteIndex];
		if (!spec) {
			rejected.push(`beat ${raw.id} happens at a settlement this world does not have; dropped it`);
			continue;
		}
		const npc = spec.npcs[raw.npcIndex];
		if (!npc) {
			rejected.push(`beat ${raw.id} is opened by somebody who is not at ${spec.name}; dropped it`);
			continue;
		}
		if (taken.has(raw.id)) {
			rejected.push(`beat ${raw.id} is already the name of a beat in this story; dropped it`);
			continue;
		}
		// Somebody who already has something to say. A beat added *after* the dialogue pass has
		// written the conversations is a beat whose anchor has nothing written for it, and the
		// validator says so — "the errand lands in the journal with only the deterministic menu
		// to account for it". Measured on a real run: the one beat this pass added carried
		// exactly that finding, which made the whole adjustment score worse and got it discarded
		// wholesale. A pass that can never keep its own work is a call spent for nothing.
		//
		// Skipped where the world has no conversations at all, which is what `--no-trees` leaves:
		// there is no better anchor to insist on, and the finding lands on every beat equally.
		const speaks = Object.keys(artifact.trees ?? {}).length === 0;
		if (!speaks && !artifact.trees?.[npcId(spec.siteId, npc.slot)]) {
			rejected.push(
				`beat ${raw.id} opens at ${npc.name}, who has no written conversation to open it with; dropped it`,
			);
			continue;
		}
		const requires = needed(raw.needs, `beat ${raw.id}`);
		if (!requires) continue;
		const objective = raw.quest?.objective
			? lowerObjective(raw.quest.objective, artifact, spec, raw.id, rejected)
			: undefined;
		// An objective that named something absent is the whole beat's problem, not the
		// objective's: an errand that hands out nothing to do closes the moment it is given.
		if (raw.quest?.objective && !objective) continue;

		taken.add(raw.id);
		order += 1;
		added.push({
			id: raw.id,
			order,
			siteId: spec.siteId,
			npcSlot: npc.slot,
			requires,
			setsFlag: `arc:${raw.id}`,
			// Always. See the file's header: a main-line beat cannot be added without changing
			// what the settled line requires.
			optional: true,
			...(raw.journal ? { journal: raw.journal } : {}),
			...(raw.quest
				? {
						quest: {
							id: raw.id,
							name: raw.quest.name,
							description: raw.quest.description,
							objectives: objective ? [objective] : [],
						},
					}
				: {}),
		});
		changes.push(`added a side errand at ${spec.name}: ${raw.quest?.name ?? raw.summary}`);
	}

	const endings: ArcEnding[] = [];
	if (response.ending) {
		const when = needed(response.ending.needs, "the new ending");
		if (when) {
			endings.push({
				id: `end:side:${response.ending.needs.join("-")}`,
				when,
				title: response.ending.title,
				sections: [{ heading: response.ending.heading, body: response.ending.body }],
			});
			changes.push(`wrote an ending for a player who did the side errands`);
		}
	}

	if (added.length === 0 && endings.length === 0 && revised.size === 0) return undefined;

	const withRevisions = arc.beats.map((beat) => {
		const said = revised.get(beat.id);
		if (!said) return beat;
		return {
			...beat,
			...(said.journal ? { journal: said.journal } : {}),
			...(said.errand && beat.quest ? { quest: { ...beat.quest, description: said.errand } } : {}),
		};
	});

	return {
		arc: {
			...arc,
			beats: [...withRevisions, ...added],
			// Ahead of the ones already there, because `pickEnding` takes the first match in author
			// order: an ending for a player who did more has to be asked about first, or the
			// ordinary one answers for them and the new page can never be reached.
			...(endings.length > 0 ? { endings: [...endings, ...(arc.endings ?? [])] } : {}),
		},
		changes,
		rejected,
	};
}

/**
 * An objective that names something this world contains, or nothing.
 *
 * Resolved by the same loose name matching the engine ticks objectives with, so a target this
 * accepts is one the game will accept: anything else is an errand the player can never close,
 * handed out by a pass whose whole warrant is that it changes nothing that has to work.
 *
 * A `talk` target has to be at the beat's *own* settlement, which is stricter than "somewhere in
 * this world" and is the rule the validator actually applies: it resolves an objective against
 * the surroundings of the beat that handed it out. Found on a real run — the model wrote "speak
 * to Oster" at a beat two towns away from Oster, this accepted it, and `checkQuests` immediately
 * called it a target nothing answers to.
 */
function lowerObjective(
	raw: { readonly kind: "reach" | "talk"; readonly target: string },
	artifact: ScenarioArtifact,
	here: SiteSpec,
	beatId: string,
	rejected: string[],
): QuestObjective | undefined {
	const specs = Object.values(artifact.sites);
	const found =
		raw.kind === "reach"
			? specs.find((spec) => namesMatch(spec.name, raw.target))?.name
			: here.npcs.find((npc) => namesMatch(npc.name, raw.target))?.name;
	if (!found) {
		rejected.push(
			raw.kind === "talk"
				? `beat ${beatId} asks the player to speak to "${raw.target}", who is not at ${here.name}; dropped it`
				: `beat ${beatId} asks the player to reach "${raw.target}", which is not in this world; dropped it`,
		);
		return undefined;
	}
	// Spelled the way the world spells it, not the way the model asked for it — the same thing
	// `spellObjectivesAsTheWorldDoes` does, done here because there is no repair pass after this.
	return { kind: raw.kind, target: found, done: false };
}
