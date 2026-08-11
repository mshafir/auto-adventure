import { escalationModel, MODELS } from "../../config.js";
import { beatNpcId, orderedBeats, type ScenarioBeat } from "../../core/rules/arc.js";
import { signBoard } from "../../core/rules/signage.js";
import { sitesInside } from "../../core/world/macro.js";
import { type NpcSpec, npcId, type SiteSpec } from "../../core/world/spec.js";
import { artifactWorld, type ScenarioArtifact } from "../../scenario/artifact.js";
import { inspect, score } from "../../scenario/repair.js";
import type { Finding } from "../../scenario/validate.js";
import { logger } from "../../utils/log.js";
import { structured } from "../client.js";
import type { DialogueTree } from "../dialogue/tree.js";
import { nextStop, type WriteTreeInput } from "./author.js";
import { READING_SYSTEM, readingPrompt } from "./prompts.js";
import { ReadingSchema } from "./schemas.js";

/**
 * Read the world back, then fix what reading it found.
 *
 * The pass that is *offered* rather than run. Everything before it is either free or part
 * of the price of writing a world at all; this one costs a call for the reading and a call
 * per scene it rewrites, so it is a decision — and the person who has just watched four
 * minutes of authoring is the right one to make it, with the findings in front of them.
 *
 * Two halves, and they are different kinds of thing.
 *
 * The **reading** is validation a static check cannot do. `validate.ts` asks whether the
 * world is structurally sound and a world can be perfectly sound and unplayable, because
 * what went wrong is what the prose *says*: a scene that does not name the town the next
 * scene is in breaks no rule at all. So a model is walked through the story in order and
 * asked the one question that matters — after this scene, would a player know where to go?
 *
 * The **rewriting** is the findings handed back. Every finding that is about a conversation
 * carries the conversation's id (see {@link Finding.tree}), so the faults can be grouped by
 * scene and each scene rewritten *once*, briefed with the sentences describing what was
 * wrong with it. That is far more reliable than asking again and hoping: a rewrite told
 * "this opens while the player is carrying the thing and then takes it, so every later
 * hello asks for it again" fixes that, and a rewrite told nothing produces a different
 * conversation with the same fault.
 *
 * Judged the way every other repair here is judged: the validator's own score, before and
 * after, and a round that does not improve it is thrown away. A rewritten conversation is a
 * real change to the world and one that trades a forgetful hand-over for a broken `goto` is
 * not a repair.
 */

export interface PolishInput {
	readonly artifact: ScenarioArtifact;
	/** What the authoring passes already know is wrong. */
	readonly findings: readonly Finding[];
	/** Injected so the pass can be tested without a key and several minutes. */
	readonly writeTree: (input: WriteTreeInput) => Promise<DialogueTree | undefined>;
	readonly onProgress?: (message: string) => void;
	readonly signal?: AbortSignal;
	/** How many conversations may be rewritten. */
	readonly budget?: number;
}

export interface PolishResult {
	readonly artifact: ScenarioArtifact;
	readonly calls: number;
	/** What was changed, in the words of the faults removed. */
	readonly repairs: readonly string[];
	/** What is wrong with it now — the mechanical findings, plus what the reading said. */
	readonly findings: readonly Finding[];
	/** The reader's one-sentence answer, for the screen to show. */
	readonly verdict?: string;
}

/**
 * How many scenes a polish may rewrite.
 *
 * Larger than the automatic mend's six, because this one was asked for: somebody who
 * pressed the key has decided to spend on it, and the whole point is that it goes further
 * than the pass that runs whether they wanted it or not. Still bounded — an unbounded
 * repair loop on a bad run is a bill nobody agreed to.
 */
export const DEFAULT_POLISH_BUDGET = 12;

/** As long as the rest of the offline passes get. See `AUTHOR_TIMEOUT_MS`. */
const POLISH_TIMEOUT_MS = 180_000;

/** Lines of a conversation shown to the reader, per scene. Enough to judge, not the whole tree. */
const SPEECH_SHOWN = 4;

export async function polishArtifact(input: PolishInput): Promise<PolishResult> {
	const say = input.onProgress ?? (() => undefined);
	let calls = 0;

	// --- the reading ---------------------------------------------------------
	say("reading the world back as a player would");
	const reading = await readWorld(input);
	if (reading) calls++;

	const notes = reading?.notes ?? [];
	const extra: Finding[] = notes.map((note) => ({
		severity: "warning" as const,
		message: `reading it back: ${note.what}`,
		...(note.tree ? { tree: note.tree } : {}),
	}));
	if (reading) {
		say(
			notes.length === 0
				? `it reads clean: ${reading.verdict}`
				: `${notes.length} thing(s) a player would trip on: ${reading.verdict}`,
		);
	}

	// --- the rewriting -------------------------------------------------------
	// Both sets together, because a scene with a structural fault *and* a note about it
	// should be rewritten once knowing both — two rewrites of one conversation would have
	// the second throw away the first's work.
	const byTree = groupByTree([...input.findings, ...extra]);
	if (byTree.size === 0) {
		say("nothing here needs writing again");
		return {
			artifact: input.artifact,
			calls,
			repairs: [],
			findings: [...input.findings, ...extra],
			...(reading?.verdict ? { verdict: reading.verdict } : {}),
		};
	}

	let budget = input.budget ?? DEFAULT_POLISH_BUDGET;
	const trees: Record<string, DialogueTree> = { ...(input.artifact.trees ?? {}) };
	const repairs: string[] = [];

	// Worst first: a scene with an error in it is a step of the story that cannot be taken,
	// and a scene with two warnings is merely rough twice. The budget will usually run out.
	const ordered = [...byTree.entries()].sort((a, b) => score(b[1]) - score(a[1]));

	for (const [id, faults] of ordered) {
		if (budget <= 0 || input.signal?.aborted) break;
		const who = personFor(input.artifact, id);
		if (!who) continue;

		budget--;
		calls++;
		const beat = beatAt(input.artifact, who.spec.siteId, who.npc.slot);
		const onward =
			beat && input.artifact.arc
				? nextStop(input.artifact.arc, beat, input.artifact.sites)
				: undefined;
		const tree = await input.writeTree({
			lore: input.artifact.lore,
			site: who.spec,
			npc: who.npc,
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
			availableFlags: (input.artifact.arc?.beats ?? []).map((each) => each.setsFlag),
			notes: faults.map((finding) => finding.message),
			...(input.signal ? { signal: input.signal } : {}),
		});
		if (!tree) continue;
		trees[id] = tree;
		repairs.push(`${who.spec.name}: rewrote ${who.npc.name} — ${faults[0]?.message ?? "again"}`);
		say(`rewrote ${who.npc.name} at ${who.spec.name}`);
	}

	if (repairs.length === 0) {
		return {
			artifact: input.artifact,
			calls,
			repairs: [],
			findings: [...input.findings, ...extra],
			...(reading?.verdict ? { verdict: reading.verdict } : {}),
		};
	}

	/*
	 * Kept only if the validator agrees, and *both* sides of that comparison are asked here.
	 *
	 * Weighing the result against `input.findings` instead was wrong in a way a test caught:
	 * the caller's list is whatever the caller happened to have, computed against an artifact
	 * that has been through a boundary or two since, and a comparison between two different
	 * questions is not a comparison. Asking twice costs one extra sweep of the bounded world
	 * on a pass that has already spent a model call.
	 *
	 * The reading's notes are left out of it deliberately: they are one model's opinion at one
	 * moment, and asking again would give a different list — so scoring against them would let
	 * a rewrite "improve" the world by producing prose that happened to please a second read.
	 */
	const candidate: ScenarioArtifact = { ...input.artifact, trees };
	const before = inspect(input.artifact);
	const after = inspect(candidate);
	if (score(after) > score(before)) {
		say("the rewrites made it worse; kept the world as it was");
		return {
			artifact: input.artifact,
			calls,
			repairs: [],
			findings: [...input.findings, ...extra],
			...(reading?.verdict ? { verdict: reading.verdict } : {}),
		};
	}

	return {
		artifact: candidate,
		calls,
		repairs,
		findings: after,
		...(reading?.verdict ? { verdict: reading.verdict } : {}),
	};
}

interface Reading {
	readonly verdict: string;
	readonly notes: readonly { readonly what: string; readonly tree?: string }[];
}

/**
 * Ask a model to walk the story through and say where a player would stop.
 *
 * The beats are shown in play order with who anchors them, what the errand says, and the
 * first few lines each character speaks — which is the whole of what a player would have.
 * Notes come back keyed by beat index, and an index is turned into that beat's anchor here,
 * so a note becomes something the rewrite loop can act on rather than a sentence.
 */
async function readWorld(input: PolishInput): Promise<Reading | undefined> {
	const arc = input.artifact.arc;
	if (!arc || arc.beats.length === 0) return undefined;

	const beats = orderedBeats(arc);
	const shown = beats.map((beat) => {
		const spec = input.artifact.sites[String(beat.siteId)];
		const npc = spec?.npcs.find((person) => person.slot === beat.npcSlot);
		const tree = input.artifact.trees?.[beatNpcId(beat)];
		return {
			place: spec?.name ?? `site ${beat.siteId}`,
			person: npc ? `${npc.name} the ${npc.role}` : "nobody",
			summary: beat.journal ?? beat.quest?.description ?? beat.id,
			...(beat.quest ? { errand: `${beat.quest.name} — ${beat.quest.description}` } : {}),
			says: Object.values(tree?.nodes ?? {})
				.slice(0, SPEECH_SHOWN)
				.map((node) => node.speech),
		};
	});

	const response = await structured({
		kind: "site",
		model: MODELS.bible,
		schema: ReadingSchema,
		system: READING_SYSTEM,
		prompt: readingPrompt({
			lore: input.artifact.lore,
			beats: shown,
			signs: boardsIn(input.artifact),
			known: input.findings.map((finding) => finding.message),
		}),
		// Low, unlike every other authoring call. This one is being asked what is true about
		// a world that already exists, and invention is the failure mode: a warm reading
		// produces six imaginative notes about a story that plays perfectly well, each of
		// which costs a rewrite.
		temperature: 0.2,
		timeoutMs: POLISH_TIMEOUT_MS,
		...(escalationModel() ? { escalateTo: escalationModel() as string } : {}),
		...(input.signal ? { signal: input.signal } : {}),
	});
	if (!response) {
		logger.warn("the reading pass produced nothing; polishing on the offline findings alone");
		return undefined;
	}

	return {
		verdict: response.verdict,
		notes: response.notes.map((note) => {
			const beat = note.beat >= 0 ? beats[note.beat] : undefined;
			return {
				what: note.what,
				// A note is attached to a scene only when the reader thinks rewriting the scene
				// would cure it. Attaching the rest would spend a call each on notes about the
				// shape of the map, which no conversation can do anything about.
				...(beat && note.fixable ? { tree: beatNpcId(beat) } : {}),
			};
		}),
	};
}

/**
 * What every signpost in this world says, as the player would read it.
 *
 * Composed through the same function the game composes it with, so the reader is shown the
 * real board rather than a description of one — the directions are derived, and a reader
 * asked "does the player know where to go" needs to see the derivation's output.
 */
function boardsIn(artifact: ScenarioArtifact): string[] {
	const signs = artifact.signs ?? [];
	if (signs.length === 0) return [];
	const sites = sitesInside(artifactWorld(artifact), artifact.bounds);
	return signs
		.map((sign) =>
			signBoard(sign, {
				nameOf: (siteId) => {
					const spec = artifact.sites[String(siteId)];
					return spec?.shortName ?? spec?.name;
				},
				positionOf: (siteId) => sites.get(siteId)?.site,
			}),
		)
		.filter((text) => text.length > 0)
		.map((text) => `  - ${text}`);
}

/**
 * The findings that name a conversation, grouped by which one.
 *
 * Structural, not textual: a finding carries the id because the check that raised it knew
 * it. Anything with no `tree` is something a rewrite cannot reach — a gate that blocks
 * nothing, a town the story never visits — and is reported rather than attempted.
 */
function groupByTree(findings: readonly Finding[]): Map<string, Finding[]> {
	const grouped = new Map<string, Finding[]>();
	for (const finding of findings) {
		if (!finding.tree) continue;
		const already = grouped.get(finding.tree);
		if (already) already.push(finding);
		else grouped.set(finding.tree, [finding]);
	}
	return grouped;
}

/** Who a conversation id belongs to, or nobody if this world has no such person. */
function personFor(
	artifact: ScenarioArtifact,
	id: string,
): { readonly spec: SiteSpec; readonly npc: NpcSpec } | undefined {
	for (const spec of Object.values(artifact.sites)) {
		for (const npc of spec.npcs) {
			if (npcId(spec.siteId, npc.slot) === id) return { spec, npc };
		}
	}
	return undefined;
}

function beatAt(
	artifact: ScenarioArtifact,
	siteId: number,
	slot: number,
): ScenarioBeat | undefined {
	return artifact.arc?.beats.find((beat) => beat.siteId === siteId && beat.npcSlot === slot);
}
