import { asCondition, flagsRead } from "../../core/rules/condition.js";
import { type NpcSpec, npcId, type SiteSpec } from "../../core/world/spec.js";
import type { ScenarioArtifact } from "../../scenario/artifact.js";
import type { DialogueTree } from "../dialogue/tree.js";
import type { WriteTreeInput } from "./author.js";

/**
 * The two faults that genuinely need somebody to write something.
 *
 * Everything the repair pass in `scenario/repair.ts` can fix, it fixes by rearranging what
 * is already there — moving a person to an anchor that exists, spelling a name the way the
 * world spells it. These two cannot be fixed that way, because what is missing is *prose*:
 *
 * - Somebody with no conversation at all. Their tree pass failed, so they fall back to the
 *   deterministic menu — which works, and which says nothing about this world.
 * - A fork nobody speaks about. Both arms open, both endings pick correctly, every flag is
 *   written and read, and the story is still wrong: the player makes the one decision the
 *   story asked of them and everybody says the same thing either way. That is worse than
 *   having no fork, because it reads as the choice not having mattered.
 *
 * Bounded on purpose. A repair pass that can spend an unbounded number of calls on a bad
 * run is a bill nobody agreed to, so it gets a budget, spends it worst-first, and stops.
 * What it cannot afford is still reported — a short list of real faults is worth far more
 * than a long one nobody reads.
 */

/** How many calls a mend may spend before it stops, however much is left wrong. */
export const DEFAULT_MEND_BUDGET = 6;

export interface MendInput {
	readonly artifact: ScenarioArtifact;
	/** Injected so the pass can be tested without a key and several minutes. */
	readonly writeTree: (input: WriteTreeInput) => Promise<DialogueTree | undefined>;
	readonly onProgress?: (message: string) => void;
	readonly signal?: AbortSignal;
	readonly budget?: number;
}

export interface MendResult {
	readonly artifact: ScenarioArtifact;
	readonly calls: number;
	readonly repairs: readonly string[];
}

export async function mendArtifact(input: MendInput): Promise<MendResult> {
	const { artifact } = input;
	const say = input.onProgress ?? (() => undefined);
	let budget = input.budget ?? DEFAULT_MEND_BUDGET;
	const trees: Record<string, DialogueTree> = { ...(artifact.trees ?? {}) };
	const repairs: string[] = [];
	let calls = 0;

	// Nothing to mend in a world where nobody was written for in the first place: a
	// scenario with no trees at all is a legitimate shape, and the fallback menu is a
	// designed floor rather than a failure.
	if (Object.keys(trees).length === 0) return { artifact, calls: 0, repairs: [] };

	const arms = unspokenForkArms(artifact);
	// Forks first. A person with no conversation is a thinner world; a fork nobody speaks
	// about is a story that lies to the player about what their decision did.
	for (const arm of arms) {
		if (budget <= 0 || input.signal?.aborted) break;
		const id = npcId(arm.spec.siteId, arm.npc.slot);
		budget--;
		calls++;
		const tree = await input.writeTree({
			lore: artifact.lore,
			site: arm.spec,
			npc: arm.npc,
			id,
			beat: { summary: arm.summary, setsFlag: arm.flag },
			availableFlags: arm.flags,
			insist: [arm.flag],
			...(input.signal ? { signal: input.signal } : {}),
		});
		// Only if the second attempt actually did the thing the first one did not. A
		// replacement that is merely different is a conversation thrown away for nothing.
		if (!tree || !readsAnyOf(tree, arm.flags)) continue;
		trees[id] = tree;
		repairs.push(
			`${arm.spec.name}: ${arm.npc.name} now says something different depending on the choice at "${arm.group}"`,
		);
		say(`rewrote ${arm.npc.name} so the fork is spoken about`);
	}

	for (const person of silentPeople(artifact)) {
		if (budget <= 0 || input.signal?.aborted) break;
		const id = npcId(person.spec.siteId, person.npc.slot);
		budget--;
		calls++;
		const tree = await input.writeTree({
			lore: artifact.lore,
			site: person.spec,
			npc: person.npc,
			id,
			availableFlags: (artifact.arc?.beats ?? []).map((beat) => beat.setsFlag),
			...(input.signal ? { signal: input.signal } : {}),
		});
		if (!tree) continue;
		trees[id] = tree;
		repairs.push(`${person.spec.name}: ${person.npc.name} had nothing written for them; wrote it`);
		say(`wrote a conversation for ${person.npc.name}`);
	}

	if (repairs.length === 0) return { artifact, calls, repairs: [] };
	return { artifact: { ...artifact, trees }, calls, repairs };
}

interface ForkArm {
	readonly group: string;
	readonly flag: string;
	/** Every mark this fork makes, so a reply gated on any of them counts. */
	readonly flags: readonly string[];
	readonly summary: string;
	readonly spec: SiteSpec;
	readonly npc: NpcSpec;
}

/**
 * Arms of a fork that no conversation anywhere is conditioned on.
 *
 * The same question `checkForkIsSpoken` asks, re-derived rather than read out of its
 * findings — a repair that parsed a message would stop working the moment somebody
 * improved the wording.
 *
 * The arm's *own* anchor is the person to ask, because the flag is set by opening the
 * beat they carry, so "the next time you speak to them" is exactly when it is true. A
 * character reacting to what the player just decided in front of them is also the most
 * natural line in the world to write.
 */
function unspokenForkArms(artifact: ScenarioArtifact): ForkArm[] {
	const arc = artifact.arc;
	if (!arc) return [];

	const groups = new Map<string, typeof arc.beats>();
	for (const beat of arc.beats) {
		if (beat.branch === undefined) continue;
		const arms = groups.get(beat.branch);
		if (arms) (arms as (typeof arc.beats)[number][]).push(beat);
		else groups.set(beat.branch, [beat]);
	}

	const found: ForkArm[] = [];
	for (const [group, arms] of groups) {
		if (arms.length < 2) continue;
		const marks = arms.flatMap((arm) => [
			arm.setsFlag,
			...(arm.effects ?? []).flatMap((effect) => (effect.t === "SetFlag" ? [effect.key] : [])),
		]);
		if (Object.values(artifact.trees ?? {}).some((tree) => readsAnyOf(tree, marks))) continue;
		for (const arm of arms) {
			const spec = artifact.sites[String(arm.siteId)];
			const npc = spec?.npcs.find((person) => person.slot === arm.npcSlot);
			if (!spec || !npc) continue;
			found.push({
				group,
				flag: arm.setsFlag,
				flags: marks,
				summary: arm.journal ?? arm.quest?.description ?? arm.quest?.name ?? arm.id,
				spec,
				npc,
			});
		}
	}
	return found;
}

/** Whether any node or choice in this tree is conditioned on one of these flags. */
function readsAnyOf(tree: DialogueTree, flags: readonly string[]): boolean {
	const wanted = new Set(flags);
	for (const node of Object.values(tree.nodes)) {
		for (const condition of [node.requires, ...node.choices.map((choice) => choice.requires)]) {
			for (const flag of flagsRead(asCondition(condition))) {
				if (wanted.has(flag)) return true;
			}
		}
	}
	return false;
}

/**
 * People nobody wrote a word for, the ones who carry the story first.
 *
 * Ordered rather than swept, because the budget will usually run out: somebody who opens
 * a beat and falls back to the canned menu is a scene the story depends on being played
 * by a stranger, and everybody else is texture.
 */
function silentPeople(
	artifact: ScenarioArtifact,
): { readonly spec: SiteSpec; readonly npc: NpcSpec }[] {
	const trees = artifact.trees ?? {};
	const anchors = new Set(
		(artifact.arc?.beats ?? []).map((beat) => npcId(beat.siteId, beat.npcSlot)),
	);
	const missing = Object.values(artifact.sites).flatMap((spec) =>
		spec.npcs
			.filter((npc) => !trees[npcId(spec.siteId, npc.slot)])
			.map((npc) => ({ spec, npc, carries: anchors.has(npcId(spec.siteId, npc.slot)) })),
	);
	return missing
		.sort((a, b) => Number(b.carries) - Number(a.carries))
		.map(({ spec, npc }) => ({ spec, npc }));
}
