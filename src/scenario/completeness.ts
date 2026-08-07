import {
	beatEffects,
	orderedBeats,
	type ScenarioArc,
	type ScenarioBeat,
} from "../core/rules/arc.js";
import { cardKey } from "../core/rules/card.js";
import { asCondition, type Condition, flagsRead } from "../core/rules/condition.js";
import type { DomainEffect } from "../core/rules/effects.js";
import type { QuestObjective } from "../core/rules/state.js";
import type { ScenarioArtifact } from "./artifact.js";
import { flagsWritten, isEngineFlag } from "./flag-sources.js";
import type { Finding } from "./validate.js";

/**
 * Whether the story can actually be finished.
 *
 * Everything else in `validate.ts` asks a local question — does this person exist, can
 * this town hold this chapel, is that item obtainable — and a scenario can pass every
 * one of them and still be unfinishable, because being unfinishable is a property of the
 * *graph* rather than of any beat in it. Two beats each waiting on the other's flag are
 * individually impeccable. So is a beat waiting on an errand whose last objective is a
 * flag nobody writes. Both stop the story dead with nothing on screen to say why, which
 * is the specific failure the whole authoring pipeline exists to make impossible.
 *
 * So this plays the story instead of reading it. Beats open, their effects land, triggers
 * fire on what those effects wrote, errands close when their objectives are met, and the
 * whole thing runs to a fixpoint. What has not opened by then cannot ever open.
 *
 * ## Why this does not call `evaluate`
 *
 * `evaluate` answers "is this true *now*", and the question here is "could this ever be
 * true" — so a proof built on it would have to be handed a fabricated game state carrying
 * every item, every acquaintance and every hour at once, and would reject a perfectly good
 * story the moment one of those fabrications did not match. {@link couldHold} answers the
 * second question directly, and is deliberately generous: everything it cannot decide
 * offline — an item, a place stood in, somebody spoken to, the hour — it treats as
 * something the player can go and do. That leaves it deciding exactly one thing, which is
 * the thing it is for: whether the *flags and errands* of the story chain up.
 *
 * Generous in one direction on purpose. A false positive here refuses a world somebody
 * waited several minutes for, so anything ambiguous is treated as reachable, and a fault
 * is only reported when no route through the story reaches it at all.
 */

/** A guard on the fixpoint, in rounds. Each round opens at least one thing or stops. */
const ROUND_LIMIT = 256;

/**
 * How many playthroughs to simulate when the story forks.
 *
 * A fork doubles the number of routes, so a story with four of them has sixteen, and the
 * honest question — "can it be finished whichever way the player chooses" — is asked of
 * every one. Past this the product is walked one arm at a time instead, which is what
 * `checkBranches` does and is enough to have every arm chosen at least once.
 */
const MAX_RUNS = 16;

/** What the player could have reached, at some point in a simulated playthrough. */
interface Reach {
	/** Flags something could have set by now. */
	readonly flags: Set<string>;
	/** Beat ids that opened. */
	readonly opened: Set<string>;
	/** Quest ids handed out. */
	readonly created: Set<string>;
	/** Quest ids that could be finished. */
	readonly done: Set<string>;
}

export function checkCompleteness(artifact: ScenarioArtifact): Finding[] {
	const arc = artifact.arc;
	if (!arc || arc.beats.length === 0) return [];

	const runs = choiceSets(arc).map((choice) => ({
		choice,
		reach: simulate(artifact, arc, choice),
	}));
	/**
	 * The route that best accounts for a beat never opening.
	 *
	 * Only ever used for the *explanation*, but it has to be chosen per beat rather than
	 * once, and the reason is an arm of a fork. Every other run has that arm barred, so
	 * asking one of those what the arm was missing gets the answer "nothing" — it was not
	 * waiting on anything, it was simply not chosen. The run that chose it is the only one
	 * with anything true to say. Among those, the one that got furthest, since a run that
	 * stalled early blames the first missing flag rather than the one that cannot be
	 * written at all.
	 */
	const explain = (beat: ScenarioBeat): Reach => {
		const eligible = runs.filter(
			(run) => beat.branch === undefined || run.choice.get(beat.branch) === beat.id,
		);
		const from = eligible.length > 0 ? eligible : runs;
		return from.reduce((a, b) => (b.reach.opened.size > a.reach.opened.size ? b : a)).reach;
	};
	const findings: Finding[] = [];

	const armFlags = forkFlags(arc);
	for (const beat of orderedBeats(arc)) {
		// Never in any run, so no choice the player makes rescues it. A beat that opens on
		// one arm of a fork and not the other is a different fault and `checkBranches`
		// reports it in the fork's own terms; reporting it twice in different words is
		// how a findings list stops being read.
		if (runs.some((run) => run.reach.opened.has(beat.id))) continue;
		const reach = explain(beat);
		if (forkOwned(beat, reach, armFlags)) continue;
		const because = whyStuck(beat, reach);
		findings.push({
			severity: beat.optional ? "warning" : "error",
			message: `beat ${beat.id} can never open${
				beat.optional ? ", so this side errand is unreachable" : ", so the story cannot be finished"
			}: ${because}`,
		});
	}

	for (const beat of orderedBeats(arc)) {
		const quest = beat.quest;
		if (!quest) continue;
		// Only errands that were actually handed out. A beat that never opens has already
		// been reported above, and its errand is a consequence rather than a second fault.
		if (!runs.some((run) => run.reach.created.has(quest.id))) continue;
		if (runs.some((run) => run.reach.done.has(quest.id))) continue;
		findings.push({
			severity: beat.optional ? "warning" : "error",
			message: `"${quest.name}" (beat ${beat.id}) can never be completed${
				beat.optional ? "" : ", so the story never reaches its ending"
			}: ${whyUnfinished(quest.objectives, explain(beat))}`,
		});
	}

	return findings;
}

/**
 * One simulated playthrough, run to a fixpoint.
 *
 * Everything advances in the same round rather than in passes, because the three move
 * each other: a beat's effects can satisfy a trigger, a trigger's effects can close an
 * errand, and a closed errand can open the beat that was waiting on it. Ordering the
 * passes would make the answer depend on the order.
 */
function simulate(
	artifact: ScenarioArtifact,
	arc: ScenarioArc,
	choice: ReadonlyMap<string, string>,
): Reach {
	const reach: Reach = {
		flags: new Set(sideFlags(artifact, arc)),
		opened: new Set(),
		created: new Set(),
		done: new Set(),
	};
	const errands = new Map<string, readonly QuestObjective[]>();
	for (const beat of arc.beats) {
		if (beat.quest) errands.set(beat.quest.id, beat.quest.objectives);
	}
	const triggers = artifact.triggers ?? [];
	const fired = new Set<string>();

	for (let round = 0; round < ROUND_LIMIT; round++) {
		let moved = false;

		for (const beat of orderedBeats(arc)) {
			if (reach.opened.has(beat.id)) continue;
			// The arm not taken is barred for good, exactly as `requirementsMet` bars it, and
			// before the requirement is looked at — the arms of a fork usually *share* a
			// requirement, so this is the only thing that stops both being walked.
			if (beat.branch !== undefined && choice.get(beat.branch) !== beat.id) continue;
			if (!couldHold(asCondition(beat.requires), reach)) continue;
			if (beat.opensOn !== undefined && !couldHold(beat.opensOn, reach)) continue;
			reach.opened.add(beat.id);
			// The engine's own lowering, so a beat that gains a new way of changing the world
			// is understood here without this file being told about it.
			record(beatEffects(beat), reach);
			moved = true;
		}

		for (const trigger of triggers) {
			if (fired.has(trigger.id)) continue;
			if (!couldHold(asCondition(trigger.when), reach)) continue;
			fired.add(trigger.id);
			record(trigger.effects, reach);
			moved = true;
		}

		for (const [id, objectives] of errands) {
			if (!reach.created.has(id) || reach.done.has(id)) continue;
			if (!objectives.every((objective) => objectiveMet(objective, reach))) continue;
			reach.done.add(id);
			moved = true;
		}

		if (!moved) break;
	}
	return reach;
}

/** What an effect makes true, for the two kinds this proof reasons about. */
function record(effects: readonly DomainEffect[], reach: Reach): void {
	for (const effect of effects) {
		if (effect.t === "SetFlag") reach.flags.add(effect.key);
		if (effect.t === "ShowCard") reach.flags.add(cardKey(effect.card.id));
		if (effect.t === "CreateQuest") reach.created.add(effect.id);
	}
}

/**
 * Flags that are available from the start, because nothing in the arc gates them.
 *
 * Everything `flagsWritten` knows about, less what the beats and the triggers write —
 * those are earned during the simulation, and starting with them already set would make
 * every story trivially finishable. What is left is dialogue and the barriers, which the
 * player can go and do at any time, so they are true from the first round.
 */
function sideFlags(artifact: ScenarioArtifact, arc: ScenarioArc): Set<string> {
	const flags = flagsWritten(artifact);
	const earned = new Set<string>();
	const collect = (effects: readonly DomainEffect[]) => {
		for (const effect of effects) {
			if (effect.t === "SetFlag") earned.add(effect.key);
			if (effect.t === "ShowCard") earned.add(cardKey(effect.card.id));
		}
	};
	for (const beat of arc.beats) collect(beatEffects(beat));
	for (const trigger of artifact.triggers ?? []) collect(trigger.effects);
	for (const flag of earned) flags.delete(flag);
	return flags;
}

/**
 * Whether a condition could hold at some point, given what has been reached.
 *
 * The sibling of `conditionSatisfiable` in `flag-sources.ts`, and the same shape of
 * answer: flags and errands are decided, everything else is treated as something the
 * player can go and do. It differs in taking a *reached* set that grows rather than a
 * fixed list of what could ever be written, which is what makes it a simulation rather
 * than a spell-check — a flag that is written only by a beat that never opens is written,
 * and is still never true.
 *
 * `not` is satisfiable by construction: a condition is being asked whether it could ever
 * hold, and `{ not: X }` holds before X does.
 */
function couldHold(condition: Condition | undefined, reach: Reach): boolean {
	if (condition === undefined) return true;
	if ("all" in condition) return condition.all.every((inner) => couldHold(inner, reach));
	if ("any" in condition) return condition.any.some((inner) => couldHold(inner, reach));
	if ("not" in condition) return true;
	if ("flag" in condition) return reach.flags.has(condition.flag) || isEngineFlag(condition.flag);
	if ("quest" in condition) {
		if (condition.is === "done") return reach.done.has(condition.quest);
		if (condition.is === "open") return reach.created.has(condition.quest);
		return true;
	}
	return true;
}

/**
 * Whether an objective could ever be ticked.
 *
 * Two kinds are decidable here and the rest are not. A sub-errand is decidable because it
 * names another errand this same simulation is tracking, and a flag is decidable because
 * `flagsWritten` knows every writer in the scenario — a `flag` objective naming a flag
 * nothing sets is an errand that stays open forever, which is the fault that leaves a
 * player with a full quest log and a story that has quietly stopped.
 *
 * `have`, `reach` and `talk` are `checkStory`'s, which resolves them against the real
 * world through the same function the running game uses. Asking again here, with less
 * information, could only disagree.
 */
function objectiveMet(objective: QuestObjective, reach: Reach): boolean {
	if (objective.kind === "quest") return reach.done.has(objective.target);
	if (objective.kind === "flag")
		return reach.flags.has(objective.target) || isEngineFlag(objective.target);
	return true;
}

/**
 * Everything a fork writes, which is everything `checkBranches` speaks for.
 *
 * The one overlap between the two checks, and it needs settling in one direction or the
 * other. A beat waiting on a flag only one arm sets is a *fork* fault: it is finishable
 * on one route and not on another, and the fork check says so in those terms — which arm,
 * which flag, which beat is stranded. Saying it again here as "nothing that can happen
 * sets it" would be both a duplicate and, strictly, untrue.
 */
function forkFlags(arc: ScenarioArc): Set<string> {
	const groups = new Map<string, ScenarioBeat[]>();
	for (const beat of arc.beats) {
		if (beat.branch === undefined) continue;
		const arms = groups.get(beat.branch);
		if (arms) arms.push(beat);
		else groups.set(beat.branch, [beat]);
	}
	const flags = new Set<string>();
	for (const arms of groups.values()) {
		// A one-armed fork is not a choice, and `checkBranches` says so and moves on
		// without looking at what it strands — so those stay this check's business.
		if (arms.length < 2) continue;
		for (const arm of arms) {
			for (const effect of beatEffects(arm)) {
				if (effect.t === "SetFlag") flags.add(effect.key);
			}
		}
	}
	return flags;
}

/** Whether the only thing stopping this beat is a fork, which is reported elsewhere. */
function forkOwned(beat: ScenarioBeat, reach: Reach, armFlags: ReadonlySet<string>): boolean {
	const missing = missingFlags(beat, reach);
	return missing.length > 0 && missing.every((flag) => armFlags.has(flag));
}

/** Which arm of each fork this playthrough takes. */
function choiceSets(arc: ScenarioArc): ReadonlyMap<string, string>[] {
	const groups = new Map<string, string[]>();
	for (const beat of orderedBeats(arc)) {
		if (beat.branch === undefined) continue;
		const arms = groups.get(beat.branch);
		if (arms) arms.push(beat.id);
		else groups.set(beat.branch, [beat.id]);
	}
	const entries = [...groups.entries()];
	if (entries.length === 0) return [new Map()];

	const total = entries.reduce((n, [, arms]) => n * arms.length, 1);
	if (total <= MAX_RUNS) {
		let runs: Map<string, string>[] = [new Map()];
		for (const [group, arms] of entries) {
			runs = runs.flatMap((run) =>
				arms.map((arm) => {
					const next = new Map(run);
					next.set(group, arm);
					return next;
				}),
			);
		}
		return runs;
	}

	// Too many routes to walk them all. One arm at a time, holding the rest at their
	// first, which still chooses every arm at least once — and being chosen once is all
	// a beat needs to avoid being reported as unreachable.
	const base = new Map(entries.map(([group, arms]) => [group, arms[0] as string]));
	const runs: Map<string, string>[] = [base];
	for (const [group, arms] of entries) {
		for (const arm of arms.slice(1)) {
			const next = new Map(base);
			next.set(group, arm);
			runs.push(next);
		}
	}
	return runs;
}

/** Flags a beat waits on that no route through the story ever writes. */
function missingFlags(beat: ScenarioBeat, reach: Reach): string[] {
	const wanted = flagsRead(asCondition(beat.requires));
	flagsRead(beat.opensOn, wanted);
	return [...wanted].filter((flag) => !reach.flags.has(flag) && !isEngineFlag(flag));
}

/** Why a beat never opened, in the words an author can act on. */
function whyStuck(beat: ScenarioBeat, reach: Reach): string {
	const missing = missingFlags(beat, reach);
	if (missing.length > 0)
		return `it waits on ${quoted(missing)}, and nothing that can happen sets ${
			missing.length === 1 ? "it" : "them"
		}`;

	const errands = [...questsRead(asCondition(beat.requires)), ...questsRead(beat.opensOn)].filter(
		(id) => !reach.done.has(id),
	);
	if (errands.length > 0) return `it waits on ${quoted(errands)}, which cannot be completed`;
	return "nothing the player can do satisfies what it waits on";
}

/** Why an errand could never be closed. */
function whyUnfinished(objectives: readonly QuestObjective[], reach: Reach): string {
	const open = objectives.filter((objective) => !objectiveMet(objective, reach));
	const flags = open.filter((objective) => objective.kind === "flag").map((o) => o.target);
	const errands = open.filter((objective) => objective.kind === "quest").map((o) => o.target);
	const parts: string[] = [];
	// Both, not the first of the two. An errand held open by two unrelated faults costs
	// two rounds of the repair loop if only one of them is named at a time.
	if (flags.length > 0)
		parts.push(
			`it waits for ${quoted(flags)} to be set, and nothing in this scenario sets ${
				flags.length === 1 ? "it" : "them"
			}`,
		);
	if (errands.length > 0)
		parts.push(`it waits on ${quoted(errands)}, which cannot be completed either`);
	return parts.length > 0 ? parts.join("; ") : "one of its objectives can never be met";
}

/** Every quest id a condition asks about. */
function questsRead(condition: Condition | undefined, into: Set<string> = new Set()): Set<string> {
	if (condition === undefined) return into;
	if ("all" in condition) for (const inner of condition.all) questsRead(inner, into);
	else if ("any" in condition) for (const inner of condition.any) questsRead(inner, into);
	else if ("not" in condition) questsRead(condition.not, into);
	else if ("quest" in condition && condition.is !== "absent") into.add(condition.quest);
	return into;
}

function quoted(names: readonly string[]): string {
	return names.map((name) => `"${name}"`).join(" and ");
}
