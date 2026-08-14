import type { DialogueTree } from "../ai/dialogue/tree.js";
import type { ScenarioArc, ScenarioBeat } from "../core/rules/arc.js";
import { type Condition, evaluate } from "../core/rules/condition.js";
import type { AuthoredBarrier } from "../core/rules/lock.js";
import type { Placement } from "../core/rules/placement.js";
import type { Scene } from "../core/rules/scene.js";
import type { Sign } from "../core/rules/signage.js";
import type { GameState } from "../core/rules/state.js";
import type { Trigger } from "../core/rules/trigger.js";
import type { SiteSpec } from "../core/world/spec.js";
import type { TerraformEdit } from "./terraform.js";

/**
 * What changes between one part of a story and the next.
 *
 * A diff rather than a snapshot, and the reason is a failure mode rather than a preference.
 * With snapshots, a correction made to the first chapter silently fails to reach the second
 * and third — which is exactly the drift between what a story says and what the world holds
 * that this whole format exists to remove. The cost is composition rules, and they are the
 * forty lines below.
 */
export interface Diff<T> {
	readonly add?: readonly T[];
	/** By id. Removing something nothing adds is an error — see {@link phaseProblems}. */
	readonly remove?: readonly string[];
	/** By id: same id, new content, same position in the list. */
	readonly replace?: readonly T[];
}

/**
 * A chapter of a world, as the difference it makes.
 *
 * Entered when {@link when} holds, and never left. The base phase has no condition, which is
 * how "the world as the player finds it" is spelled.
 */
export interface Phase {
	readonly id: string;
	readonly name: string;
	/** Absent means always in force, which is what the first phase is. */
	readonly when?: Condition;
	readonly sites?: Diff<SiteSpec>;
	readonly placements?: Diff<Placement>;
	readonly signs?: Diff<Sign>;
	readonly barriers?: Diff<AuthoredBarrier>;
	readonly triggers?: Diff<Trigger>;
	readonly terraform?: Diff<TerraformEdit>;
	/**
	 * Replaces a conversation wholesale. `null` takes it away.
	 *
	 * Wholesale rather than as a diff over nodes, because a conversation after a turning
	 * point is a different conversation, not the old one with two lines changed — and a node
	 * diff over a dialogue tree is where dangling `goto`s come from.
	 */
	readonly trees?: Readonly<Record<string, DialogueTree | null>>;
	/** Cutscenes that only exist once this phase is in force. */
	readonly scenes?: Readonly<Record<string, Scene | null>>;
	/** Beats appended to the arc once this phase is in force. */
	readonly beats?: readonly ScenarioBeat[];
}

/** Everything a phase can change, resolved for a given state. */
export interface ScenarioContent {
	readonly sites: Readonly<Record<string, SiteSpec>>;
	readonly placements: readonly Placement[];
	readonly signs: readonly Sign[];
	readonly barriers: readonly AuthoredBarrier[];
	readonly triggers: readonly Trigger[];
	readonly terraform: readonly TerraformEdit[];
	readonly trees: Readonly<Record<string, DialogueTree>>;
	readonly scenes: Readonly<Record<string, Scene>>;
	readonly arc?: ScenarioArc;
}

/**
 * Which phases are in force, in file order.
 *
 * Derived from state and never stored. That is what makes a phase file something you can
 * correct while a save is in flight: nothing on disk remembers which chapter a player is
 * in, only the flags that put them there.
 */
export function enteredPhaseIds(phases: readonly Phase[], state: GameState): string[] {
	return phases.filter((phase) => !phase.when || evaluate(phase.when, state)).map((p) => p.id);
}

/**
 * Fold the entered phases over the base content.
 *
 * Pure, and cheap enough to be called after every command — but the caller should still
 * memoise on the entered set, because the result is compared by identity to decide whether
 * anything has to be rebuilt.
 */
export function composeScenario(
	base: ScenarioContent,
	phases: readonly Phase[],
	state: GameState,
): ScenarioContent {
	const entered = new Set(enteredPhaseIds(phases, state));
	let content = base;
	for (const phase of phases) {
		if (!entered.has(phase.id)) continue;
		content = {
			sites: applyRecord(content.sites, phase.sites, (spec) => String(spec.siteId)),
			placements: applyList(content.placements, phase.placements),
			signs: applyList(content.signs, phase.signs),
			barriers: applyList(content.barriers, phase.barriers),
			triggers: applyList(content.triggers, phase.triggers),
			terraform: applyList(content.terraform, phase.terraform),
			trees: applyKeyed(content.trees, phase.trees),
			scenes: applyKeyed(content.scenes, phase.scenes),
			...withBeats(content.arc, phase.beats),
		};
	}
	return content;
}

function applyList<T extends { readonly id: string }>(
	current: readonly T[],
	diff: Diff<T> | undefined,
): readonly T[] {
	if (!diff) return current;
	const gone = new Set(diff.remove ?? []);
	const swapped = new Map((diff.replace ?? []).map((item) => [item.id, item]));
	// A replacement keeps its position rather than moving to the end, so that two placements
	// which collide resolve the same way before and after a phase — the resolver's tie-break
	// is list order, and a chapter turning must not quietly move an item to a different crate.
	const kept = current
		.filter((item) => !gone.has(item.id))
		.map((item) => swapped.get(item.id) ?? item);
	return diff.add ? [...kept, ...diff.add] : kept;
}

function applyRecord<T>(
	current: Readonly<Record<string, T>>,
	diff: Diff<T> | undefined,
	keyOf: (item: T) => string,
): Readonly<Record<string, T>> {
	if (!diff) return current;
	const next: Record<string, T> = { ...current };
	for (const id of diff.remove ?? []) delete next[id];
	for (const item of [...(diff.replace ?? []), ...(diff.add ?? [])]) next[keyOf(item)] = item;
	return next;
}

/** A record whose diff is written as `{ key: value | null }` rather than add/remove/replace. */
function applyKeyed<T>(
	current: Readonly<Record<string, T>>,
	diff: Readonly<Record<string, T | null>> | undefined,
): Readonly<Record<string, T>> {
	if (!diff) return current;
	const next: Record<string, T> = { ...current };
	for (const [key, value] of Object.entries(diff)) {
		if (value === null) delete next[key];
		else next[key] = value;
	}
	return next;
}

/**
 * The arc with a phase's beats appended.
 *
 * A phase cannot introduce an arc where there was none: the title and premise belong to the
 * story as a whole, and a world with no arc is a place with no plot in it — which is a
 * legitimate thing to author, but not something a later chapter can retrofit.
 */
function withBeats(
	arc: ScenarioArc | undefined,
	beats: readonly ScenarioBeat[] | undefined,
): { arc?: ScenarioArc } {
	if (!arc) return {};
	if (!beats || beats.length === 0) return { arc };
	return { arc: { ...arc, beats: [...arc.beats, ...beats] } };
}

/**
 * Whether every diff has something to act on.
 *
 * A diff that quietly does nothing because the base was rewritten underneath it is the
 * silent failure snapshots would have produced, arriving by another door: the chapter loads,
 * the door that was meant to open stays shut, and nothing anywhere reports it.
 *
 * Checked against the *union* of the base and everything earlier phases add, because a phase
 * removing what the phase before it introduced is perfectly ordinary — the body in the
 * millrace is gone once it has been carried away.
 */
export function phaseProblems(base: ScenarioContent, phases: readonly Phase[]): string[] {
	const problems: string[] = [];
	const known: Record<Kind, Set<string>> = {
		site: new Set(Object.keys(base.sites)),
		placement: new Set(base.placements.map((p) => p.id)),
		sign: new Set(base.signs.map((s) => s.id)),
		barrier: new Set(base.barriers.map((b) => b.id)),
		trigger: new Set(base.triggers.map((t) => t.id)),
		terraform: new Set(base.terraform.map((t) => t.id)),
	};

	const check = <T extends { readonly id: string }>(
		phase: Phase,
		kind: Kind,
		diff: Diff<T> | undefined,
	) => {
		if (!diff) return;
		for (const id of diff.remove ?? []) {
			if (!known[kind].has(id)) problems.push(missing(phase, "removes", kind, id));
			known[kind].delete(id);
		}
		for (const item of diff.replace ?? []) {
			if (!known[kind].has(item.id)) problems.push(missing(phase, "replaces", kind, item.id));
		}
		for (const item of diff.add ?? []) known[kind].add(item.id);
	};

	for (const phase of phases) {
		check(phase, "placement", phase.placements);
		check(phase, "sign", phase.signs);
		check(phase, "barrier", phase.barriers);
		check(phase, "trigger", phase.triggers);
		check(phase, "terraform", phase.terraform);
		// Sites are keyed by id rather than carrying it as a field, so they cannot go through
		// the same helper.
		if (phase.sites) {
			for (const id of phase.sites.remove ?? []) {
				if (!known.site.has(id)) problems.push(missing(phase, "removes", "site", id));
				known.site.delete(id);
			}
			for (const spec of phase.sites.replace ?? []) {
				if (!known.site.has(String(spec.siteId)))
					problems.push(missing(phase, "replaces", "site", String(spec.siteId)));
			}
			for (const spec of phase.sites.add ?? []) known.site.add(String(spec.siteId));
		}
	}

	return problems;
}

type Kind = "site" | "placement" | "sign" | "barrier" | "trigger" | "terraform";

function missing(phase: Phase, verb: string, kind: Kind, id: string): string {
	return `phase ${phase.id} ${verb} ${kind} "${id}", which nothing adds`;
}
