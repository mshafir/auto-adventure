import { getInterior } from "../core/gen/features/interior.js";
import type { AnchorKind, FeaturePatch } from "../core/gen/features/patch.js";
import { generateFeature, invalidateFeature } from "../core/gen/features/registry.js";
import { standingRoom } from "../core/gen/features/residents.js";
import { beatNpcId, orderedBeats, type ScenarioBeat } from "../core/rules/arc.js";
import { asCondition, type Condition, flagsRead } from "../core/rules/condition.js";
import type { QuestObjective } from "../core/rules/state.js";
import { resolveObjectiveTarget } from "../core/rules/surroundings.js";
import type { MacroSite } from "../core/world/macro.js";
import { type NpcSpec, npcId, type SiteSpec } from "../core/world/spec.js";
import { artifactWorld, type ScenarioArtifact } from "./artifact.js";
import { flagsWritten, isEngineFlag } from "./flag-sources.js";
import { type PassabilityGrid, terrainOf } from "./passability.js";
import { verifyArtifact } from "./repo.js";
import {
	buildPassability,
	type Finding,
	siteIndex,
	surroundingsFor,
	validateArtifact,
} from "./validate.js";

/**
 * Fix what can be fixed without asking anybody.
 *
 * The authoring passes come back rough in a small number of recurring ways, and most of
 * them have exactly one right answer: a person assigned to a building the ground would
 * not hold belongs in one it did hold, an errand naming "the mill" when the world spells
 * it "Millgate mill" should say what the world says, a fork with one arm is not a fork.
 * None of those needs a model, and paying for one to say so is both slower and less
 * reliable than saying it here.
 *
 * Two rules run through all of it.
 *
 * **Each repair re-derives its own condition** rather than reading the validator's
 * findings. A finding is a sentence written for a person; parsing it back into a fault
 * would couple every repair to the exact wording of a message, so that improving a
 * message would silently disable a fix. Every function below asks the world the same
 * question the matching check asks and acts on the answer.
 *
 * **A repair may only make the world more playable, never more interesting.** Dropping a
 * dead objective, moving somebody to an anchor that exists, spelling a name the way the
 * world spells it — these are all cases where the alternative is content that does not
 * work at all. Anything that would require inventing prose is left alone and reported,
 * because a validator saying "this errand cannot be finished" is far better than a repair
 * pass quietly writing a different story than the one that was asked for.
 */

export interface RepairResult {
	readonly artifact: ScenarioArtifact;
	/** What was changed, in the words of the fault removed. Empty when nothing was. */
	readonly repairs: readonly string[];
}

/**
 * The world the repairs measure against.
 *
 * Built once and handed round. Generating the bounded world is the most expensive thing
 * in the whole authoring pipeline, and three separate repairs need to ask it questions.
 */
interface Ground {
	readonly grid: PassabilityGrid;
	readonly sites: Map<number, MacroSite>;
	/** What the generator actually built at a site, or undefined where it built nothing. */
	readonly built: (siteId: number) => FeaturePatch | undefined;
}

/**
 * How many times to go round. Two, and the second one almost never earns its keep.
 *
 * Each round generates the bounded world twice — once to repair against and once to
 * validate the result — and that is the most expensive thing in the whole pipeline. The
 * repairs here are near enough independent that a second pass finds anything only when
 * one repair unblocked another, so the cap is set where the returns stop rather than
 * where the loop would converge.
 */
const MAX_ROUNDS = 2;

/**
 * Repair, check, and keep going while it is getting better.
 *
 * The loop rather than the repairs is what makes this trustworthy. Every round is judged
 * on the validator's own output, so a repair cannot claim a success it did not have — and
 * a round that does not improve the score is *thrown away*, which means a repair with an
 * unforeseen consequence costs one wasted world-generation rather than a worse scenario.
 *
 * Errors are worth ten warnings in that score. Trading a step of the story that cannot be
 * taken for a place that came out rougher than intended is a good trade, and counting
 * findings alone would call it a draw and refuse it.
 */
export function repairUntilClean(
	artifact: ScenarioArtifact,
	onProgress: (message: string) => void = () => undefined,
): { artifact: ScenarioArtifact; findings: readonly Finding[]; repairs: readonly string[] } {
	let current = artifact;
	let findings = inspect(current);
	const repairs: string[] = [];

	for (let round = 0; round < MAX_ROUNDS && findings.length > 0; round++) {
		const attempt = repairArtifact(current);
		if (attempt.repairs.length === 0) break;
		const after = inspect(attempt.artifact);
		if (score(after) >= score(findings)) {
			onProgress(`${attempt.repairs.length} repairs made nothing better; kept the world as it was`);
			break;
		}
		current = attempt.artifact;
		findings = after;
		repairs.push(...attempt.repairs);
		onProgress(`repaired ${attempt.repairs.length}, ${describe(after)} left`);
	}
	return { artifact: current, findings, repairs };
}

/**
 * Everything known to be wrong with an artifact, cheap checks and expensive together.
 *
 * Both halves, because a repair pass judged on only one of them can make the other worse
 * and call it an improvement. That is not hypothetical: a rewritten conversation with a
 * `goto` pointing at a node it no longer contains passes every check in `validate.ts` and
 * is refused by `readScenarioFile` — so the world would have been "repaired" into one the
 * launcher will not open.
 */
export function inspect(artifact: ScenarioArtifact): Finding[] {
	return [
		...verifyArtifact(artifact).map((message) => ({ severity: "error" as const, message })),
		...validateArtifact(artifact),
	];
}

export function score(findings: readonly Finding[]): number {
	return findings.reduce((total, finding) => total + (finding.severity === "error" ? 10 : 1), 0);
}

function describe(findings: readonly Finding[]): string {
	const errors = findings.filter((finding) => finding.severity === "error").length;
	const warnings = findings.length - errors;
	if (findings.length === 0) return "nothing";
	return `${errors} error${errors === 1 ? "" : "s"} and ${warnings} warning${warnings === 1 ? "" : "s"}`;
}

export function repairArtifact(artifact: ScenarioArtifact): RepairResult {
	const ground = survey(artifact);
	const repairs: string[] = [];
	let current = artifact;
	for (const repair of REPAIRS) {
		const result = repair(current, ground);
		if (result.artifact !== current) {
			current = result.artifact;
			repairs.push(...result.repairs);
		}
	}
	return { artifact: current, repairs };
}

/**
 * Repairs in the order they must run.
 *
 * Ordering matters in one place: dropping a dead objective comes after respelling one,
 * because a target the world spells differently is not a dead objective — it is a live
 * one written in the wrong words, and dropping it would throw away a step of the story to
 * avoid fixing a typo. Everything else here is independent.
 *
 * Notably absent: trimming a roster that asked for more buildings than fit. The engine
 * already drops the tail, so the finding is a report on the authoring rather than a fault
 * in the world, and editing the roster would change the layout the rest of the artifact —
 * every placement, every anchor, every named building — was written against.
 */
const REPAIRS: readonly ((artifact: ScenarioArtifact, ground: Ground) => RepairResult)[] = [
	standTheCastSomewhereReal,
	hideThingsWhereThereIsSomewhereToHideThem,
	spellObjectivesAsTheWorldDoes,
	dropObjectivesNothingCanTick,
	dropOneArmedForks,
	forgetPeopleWhoAreNotHere,
	gateTheCastOnTheirOwnScene,
];

function survey(artifact: ScenarioArtifact): Ground {
	const sites = siteIndex(artifact);
	const patches = new Map<number, FeaturePatch | undefined>();
	return {
		grid: buildPassability(artifact),
		sites,
		built: (siteId) => {
			if (patches.has(siteId)) return patches.get(siteId);
			const site = sites.get(siteId);
			const spec = artifact.sites[String(siteId)];
			let patch: FeaturePatch | undefined;
			if (site && spec) {
				// The same invalidation `checkPlaces` does, and for the same reason: the cache
				// is keyed by site, so a re-authored roster would otherwise be measured against
				// the layout of the roster before it.
				invalidateFeature(artifactWorld(artifact), site.id);
				patch = generateFeature(artifactWorld(artifact), site, spec.settlement) ?? undefined;
			}
			patches.set(siteId, patch);
			return patch;
		},
	};
}

/**
 * Anchors to fall back to, best first.
 *
 * A doorstep first because every settlement has one and standing at a door is the most
 * neutral thing a person can be doing; the square next because it is where a town's life
 * is. What matters far more than the order is that the result is an anchor the town
 * actually built — `pickAnchor` falls through to any free outdoor anchor anyway, so an
 * unhonoured placement is not a broken scenario, merely a lie in the file that the next
 * pass to read it will believe.
 */
const FALLBACK_ANCHORS: readonly AnchorKind[] = [
	"doorstep",
	"square",
	"well",
	"stall",
	"bench",
	"gate",
	"yard",
];

/** The anchor a placement really resolves to. Mirrors `pickAnchor`, as the validator does. */
function anchorAliasFor(placement: AnchorKind): AnchorKind {
	return placement === "yard" ? "doorstep" : placement;
}

/**
 * Everybody standing at an anchor, or in a room, that exists.
 *
 * Three faults with one shape. Outdoors, an unbuilt anchor is a placement the engine
 * silently ignores, and a `structureName` naming a building that did not fit is a claim
 * nothing supports. Indoors it is worse than either: an unbuilt room leaves the person
 * nowhere at all — not somewhere else, nowhere — so they cannot be walked into, cannot be
 * talked to, and any beat anchored on them is unreachable while every other check passes.
 */
function standTheCastSomewhereReal(artifact: ScenarioArtifact, ground: Ground): RepairResult {
	const repairs: string[] = [];
	const sites: Record<string, SiteSpec> = {};
	let changed = false;

	for (const [key, spec] of Object.entries(artifact.sites)) {
		const patch = ground.built(spec.siteId);
		sites[key] = spec;
		if (!patch || patch.buildings.length + patch.anchors.length === 0) continue;

		const anchors = new Set(patch.anchors.map((anchor) => anchor.kind));
		const names = new Map(
			patch.buildings
				.filter((building) => building.name)
				.map((building) => [building.name?.toLowerCase() as string, building.name as string]),
		);
		// Somewhere with floor to stand on, for anybody who has to be indoors. A building
		// whose interior rolled no standing room is as good as unbuilt for this purpose.
		const rooms = patch.buildings.filter(
			(building) =>
				standingRoom(getInterior(artifact.seed, building.interiorId, building.kind)).length > 0,
		);

		const npcs = spec.npcs.map((npc) => {
			let next = npc;

			if (npc.indoors) {
				const wanted = npc.structureName?.toLowerCase();
				const room = wanted
					? rooms.find((building) => building.name?.toLowerCase() === wanted)
					: rooms[0];
				if (!room) {
					const moved = rooms[0];
					if (moved) {
						next = { ...next, structureName: moved.name ?? moved.kind };
						repairs.push(
							`${spec.name}: ${npc.name} stood inside "${npc.structureName ?? "a building"}", which was not built; moved them into the ${moved.name ?? moved.kind}`,
						);
					} else {
						// Nowhere inside at all. Out into the street, which is a worse scene than
						// the one that was written and an immeasurably better one than not
						// existing.
						const { indoors: _indoors, structureName: _name, ...outdoors } = next;
						next = outdoors as NpcSpec;
						repairs.push(
							`${spec.name}: ${npc.name} stood inside "${npc.structureName ?? "a building"}", and nothing here has a room; put them outdoors`,
						);
					}
				}
				return next;
			}

			if (!anchors.has(anchorAliasFor(npc.placement))) {
				const moved = FALLBACK_ANCHORS.find((kind) => anchors.has(kind)) ?? [...anchors][0];
				if (moved && moved !== npc.placement) {
					next = { ...next, placement: moved };
					repairs.push(
						`${spec.name}: ${npc.name} asked for a "${npc.placement}", which this town does not build; stood them at the ${moved}`,
					);
				}
			}

			if (next.structureName && !names.has(next.structureName.toLowerCase())) {
				const { structureName: _name, ...without } = next;
				next = without as NpcSpec;
				repairs.push(
					`${spec.name}: ${npc.name} belonged to "${npc.structureName}", which was not built; dropped the claim`,
				);
			}
			return next;
		});

		if (npcs.some((npc, index) => npc !== spec.npcs[index])) {
			sites[key] = { ...spec, npcs };
			changed = true;
		}
	}

	return changed ? { artifact: { ...artifact, sites }, repairs } : { artifact, repairs: [] };
}

/**
 * Hidden things, in buildings that were actually built.
 *
 * The arc pass names a *kind* of building to hide something in — "in the shop at
 * Saltgate" — from a roster that is only a request. The ground has the last word, and
 * where it refuses the shop the thing is nowhere: the errand asking the player to fetch
 * it cannot be finished, and the only symptom is a crate that is never there.
 *
 * Retargeted rather than dropped, and the difference matters. The item is usually the
 * point of the beat that hid it, so removing it would take a step out of the story to
 * avoid moving a chest between two rooms. Only a settlement that built nothing at all is
 * beyond helping, and there the placement goes, because there is no room in it to stand.
 */
function hideThingsWhereThereIsSomewhereToHideThem(
	artifact: ScenarioArtifact,
	ground: Ground,
): RepairResult {
	const placements = artifact.placements;
	if (!placements || placements.length === 0) return { artifact, repairs: [] };
	const repairs: string[] = [];

	const kept = placements.flatMap((placement) => {
		const at = placement.at;
		if (at.kind !== "site") return [placement];
		const here = ground.built(at.siteId);
		const name = artifact.sites[String(at.siteId)]?.name ?? `site ${at.siteId}`;

		// The same resolution `resolvePlacements` does: by name, then by kind. Anything it
		// would find, this leaves alone.
		const wanted = at.structure?.toLowerCase();
		const found = here
			? wanted
				? (here.buildings.find((building) => building.name?.toLowerCase() === wanted) ??
					here.buildings.find((building) => building.kind === at.structure))
				: here.buildings[0]
			: undefined;
		if (found) return [placement];

		// Somewhere else in the world, if this settlement has no rooms at all. Moving a
		// hidden thing across a finite world is normal — being sent for one is what a fetch
		// errand *is* — and it is a far smaller loss than dropping it, because the item is
		// usually the point of the beat that hid it and an errand naming an item that
		// exists nowhere can never be finished.
		const roomy = here?.buildings.length ? at.siteId : elsewhere(artifact, ground, at.siteId);
		const patch = roomy === undefined ? undefined : ground.built(roomy);
		const instead = patch?.buildings[0];
		if (!instead || roomy === undefined) {
			repairs.push(
				`nothing in this world has a room to hide "${placement.item.name}" in; dropped that placement`,
			);
			return [];
		}
		const where = artifact.sites[String(roomy)]?.name ?? `site ${roomy}`;
		repairs.push(
			roomy === at.siteId
				? `${name} built no ${at.structure}; hid "${placement.item.name}" in the ${instead.kind} instead`
				: `${name} built nothing to hide "${placement.item.name}" in; hid it in the ${instead.kind} at ${where}`,
		);
		return [
			{
				...placement,
				at: { ...at, siteId: roomy, structure: instead.name ?? instead.kind },
			},
		];
	});

	return kept.length === placements.length &&
		kept.every((entry, index) => entry === placements[index])
		? { artifact, repairs: [] }
		: { artifact: { ...artifact, placements: kept }, repairs };
}

/**
 * The nearest settlement to this one that actually has a room in it.
 *
 * Nearest by macro cell rather than by road, because this is choosing between "somewhere
 * plausible" and "nowhere at all" — a walk of the real distance is `checkPlacements`'
 * business, and it will say so if the answer is across the map.
 */
function elsewhere(artifact: ScenarioArtifact, ground: Ground, from: number): number | undefined {
	const origin = ground.sites.get(from)?.site;
	const candidates = Object.values(artifact.sites)
		.filter((spec) => spec.siteId !== from)
		.filter((spec) => (ground.built(spec.siteId)?.buildings.length ?? 0) > 0);
	if (candidates.length === 0) return undefined;
	if (!origin) return candidates[0]?.siteId;
	return candidates.sort(
		(a, b) => away(ground, a.siteId, origin) - away(ground, b.siteId, origin),
	)[0]?.siteId;
}

function away(ground: Ground, siteId: number, from: { x: number; y: number }): number {
	const at = ground.sites.get(siteId)?.site;
	return at ? Math.hypot(at.x - from.x, at.y - from.y) : Number.POSITIVE_INFINITY;
}

/**
 * Objectives spelled the way the world spells them.
 *
 * `verifyQuests` matches an objective against the real world by significant words, so
 * "the mill" against a building called "Millgate mill" resolves — but the *objective* is
 * what the quest pane shows and what `resolveObjectiveTarget` is asked, and a target the
 * world would resolve differently is one the player reads in one spelling and the game
 * ticks in another. Assembly already canonicalises this; a generated arc has not been
 * through assembly.
 */
function spellObjectivesAsTheWorldDoes(artifact: ScenarioArtifact, ground: Ground): RepairResult {
	const arc = artifact.arc;
	if (!arc) return { artifact, repairs: [] };
	const repairs: string[] = [];
	const terrainAt = (x: number, y: number) => terrainOf(ground.grid, x, y);

	const beats = arc.beats.map((beat) => {
		if (!beat.quest) return beat;
		const surroundings = surroundingsFor(artifact, beat.siteId, ground.sites, terrainAt);
		const objectives = beat.quest.objectives.map((objective) => {
			// A sub-errand names another errand rather than something in the world, so the
			// world has nothing to say about its spelling.
			if (objective.kind === "quest" || objective.kind === "flag") return objective;
			const resolved = resolveObjectiveTarget(objective.kind, objective.target, surroundings);
			if (resolved === undefined || resolved === objective.target) return objective;
			repairs.push(
				`beat ${beat.id}: "${objective.target}" is spelled "${resolved}" here; said it the world's way`,
			);
			return { ...objective, target: resolved };
		});
		return objectives.some((objective, index) => objective !== beat.quest?.objectives[index])
			? { ...beat, quest: { ...beat.quest, objectives } }
			: beat;
	});

	return beats.some((beat, index) => beat !== arc.beats[index])
		? { artifact: { ...artifact, arc: { ...arc, beats } }, repairs }
		: { artifact, repairs: [] };
}

/**
 * Objectives waiting on a flag nothing sets.
 *
 * The errand is handed out, it appears in the log, and it stays there forever — and
 * because `arcOutline` will not call a story finished while an errand it handed out is
 * open, one of these stops the *whole* arc from ever ending. Dropping the objective
 * leaves the errand closable on whatever else it asks for, which is the smaller loss by a
 * long way. An errand left with nothing at all to do is left alone: an errand that closes
 * the moment it is given is a different kind of wrong, and one a person should look at.
 */
function dropObjectivesNothingCanTick(artifact: ScenarioArtifact): RepairResult {
	const arc = artifact.arc;
	if (!arc) return { artifact, repairs: [] };
	const written = flagsWritten(artifact);
	const repairs: string[] = [];

	const beats = arc.beats.map((beat) => {
		if (!beat.quest) return beat;
		const objectives = beat.quest.objectives.filter((objective) => tickable(objective, written));
		if (objectives.length === beat.quest.objectives.length) return beat;
		if (objectives.length === 0) return beat;
		for (const objective of beat.quest.objectives) {
			if (tickable(objective, written)) continue;
			repairs.push(
				`"${beat.quest.name}" waited for "${objective.target}" to be set and nothing sets it; dropped that objective`,
			);
		}
		return { ...beat, quest: { ...beat.quest, objectives } };
	});

	return beats.some((beat, index) => beat !== arc.beats[index])
		? { artifact: { ...artifact, arc: { ...arc, beats } }, repairs }
		: { artifact, repairs: [] };
}

function tickable(objective: QuestObjective, written: ReadonlySet<string>): boolean {
	if (objective.kind !== "flag") return true;
	return written.has(objective.target) || isEngineFlag(objective.target);
}

/**
 * A fork with one arm, which is not a choice.
 *
 * Costly beyond being untidy: an arm records the branch as taken and bars its siblings
 * for good, so a lone arm spends that machinery on nothing while telling every later
 * reader — the ending picker, the outline, this file — that a decision happened. Dropping
 * the branch leaves the beat exactly as it plays.
 */
function dropOneArmedForks(artifact: ScenarioArtifact): RepairResult {
	const arc = artifact.arc;
	if (!arc) return { artifact, repairs: [] };

	const count = new Map<string, number>();
	for (const beat of arc.beats) {
		if (beat.branch === undefined) continue;
		count.set(beat.branch, (count.get(beat.branch) ?? 0) + 1);
	}
	const lonely = new Set([...count].filter(([, n]) => n < 2).map(([group]) => group));
	if (lonely.size === 0) return { artifact, repairs: [] };

	const repairs: string[] = [];
	const beats = arc.beats.map((beat) => {
		if (beat.branch === undefined || !lonely.has(beat.branch)) return beat;
		repairs.push(`fork "${beat.branch}" had only one arm; dropped the branch from ${beat.id}`);
		const { branch: _branch, ...without } = beat;
		return without as ScenarioBeat;
	});
	return { artifact: { ...artifact, arc: { ...arc, beats } }, repairs };
}

/**
 * Conditions asking about somebody the scenario does not contain.
 *
 * A `talked` or `disposition` naming an npcId nothing places can never be true, so the
 * node it gates is a line of dialogue nobody will ever be shown. Dropping the leaf is the
 * only repair available without inventing a person, and it turns dead content into live
 * content — the scene the author wrote gets played, merely without the gate they meant to
 * put on it. That is a real change to what they wrote, and it is why this is the one
 * repair here that makes a scenario *more* permissive rather than less.
 */
function forgetPeopleWhoAreNotHere(artifact: ScenarioArtifact): RepairResult {
	const trees = artifact.trees;
	if (!trees) return { artifact, repairs: [] };
	const people = new Set(
		Object.values(artifact.sites).flatMap((spec) =>
			spec.npcs.map((npc) => npcId(spec.siteId, npc.slot)),
		),
	);
	const repairs: string[] = [];
	const strangers = new Set<string>();

	const next: Record<string, (typeof trees)[string]> = {};
	let changed = false;
	for (const [key, tree] of Object.entries(trees)) {
		const nodes: Record<string, (typeof tree.nodes)[string]> = {};
		let touched = false;
		for (const [id, node] of Object.entries(tree.nodes)) {
			// `asCondition` builds a fresh object for the `string[]` shorthand, so it is
			// called once per condition and the result compared by identity — asking twice
			// would report every list-form condition as rewritten.
			const before = asCondition(node.requires);
			const requires = withoutStrangers(before, people, strangers);
			const choices = node.choices.map((choice) => {
				const was = asCondition(choice.requires);
				const pruned = withoutStrangers(was, people, strangers);
				if (pruned === was) return choice;
				const { requires: _drop, ...rest } = choice;
				return pruned ? { ...rest, requires: pruned } : rest;
			});
			const sameChoices = choices.every((choice, index) => choice === node.choices[index]);
			if (requires === before && sameChoices) {
				nodes[id] = node;
				continue;
			}
			touched = true;
			const { requires: _drop, ...rest } = node;
			nodes[id] = { ...rest, choices, ...(requires ? { requires } : {}) };
		}
		next[key] = touched ? { ...tree, nodes } : tree;
		if (touched) changed = true;
	}

	if (!changed) return { artifact, repairs: [] };
	for (const stranger of strangers) {
		repairs.push(
			`a conversation asked about "${stranger}", who is not in this scenario; dropped the condition so the line can be reached`,
		);
	}
	return { artifact: { ...artifact, trees: next }, repairs };
}

/**
 * A condition with every mention of an absent person taken out of it.
 *
 * Returns the input untouched when there is nothing to take out, so callers can compare
 * by identity and leave the rest of the tree alone.
 */
function withoutStrangers(
	condition: Condition | undefined,
	people: ReadonlySet<string>,
	found: Set<string>,
): Condition | undefined {
	if (condition === undefined) return undefined;
	if ("all" in condition || "any" in condition) {
		const inner = "all" in condition ? condition.all : condition.any;
		const kept = inner
			.map((part) => withoutStrangers(part, people, found))
			.filter((part): part is Condition => part !== undefined);
		if (kept.length === inner.length && kept.every((part, index) => part === inner[index]))
			return condition;
		if (kept.length === 0) return undefined;
		if (kept.length === 1) return kept[0];
		return "all" in condition ? { all: kept } : { any: kept };
	}
	if ("not" in condition) {
		const inner = withoutStrangers(condition.not, people, found);
		if (inner === condition.not) return condition;
		return inner ? { not: inner } : undefined;
	}
	const who =
		"talked" in condition
			? condition.talked
			: "disposition" in condition
				? condition.disposition
				: undefined;
	if (who === undefined || people.has(who)) return condition;
	found.add(who);
	return undefined;
}

/**
 * Somebody who arrives before the scene they are there for.
 *
 * The Green Knight standing at the mound two beats before anybody can speak to him about
 * it: the player walks up, gets the finale delivered at them, and nothing happens. The
 * repair is the one `checkEarlyCast` names first — gate them on the same thing the beat
 * is gated on, so they simply are not there yet.
 *
 * Only for somebody who anchors exactly one beat, and only if they were gated already.
 * Someone with no `requires` is permanent scenery and always has been; someone anchoring
 * two beats has to be present for the earlier one, so there is no condition that is right
 * for both and choosing one would break the story rather than tighten it.
 */
function gateTheCastOnTheirOwnScene(artifact: ScenarioArtifact): RepairResult {
	const arc = artifact.arc;
	if (!arc) return { artifact, repairs: [] };

	const anchored = new Map<string, ScenarioBeat[]>();
	for (const beat of orderedBeats(arc)) {
		const key = `${beat.siteId}:${beat.npcSlot}`;
		const beats = anchored.get(key);
		if (beats) beats.push(beat);
		else anchored.set(key, [beat]);
	}

	const repairs: string[] = [];
	const sites: Record<string, SiteSpec> = { ...artifact.sites };
	let changed = false;

	for (const [key, spec] of Object.entries(artifact.sites)) {
		const npcs = spec.npcs.map((npc) => {
			const beats = anchored.get(`${spec.siteId}:${npc.slot}`);
			if (!npc.requires || !beats || beats.length !== 1) return npc;
			const beat = beats[0] as ScenarioBeat;
			const wanted = asCondition(beat.requires);
			if (!wanted) return npc;

			// The same question `checkEarlyCast` asks, in the same terms: which of the flags
			// the beat waits on does their being here not already wait on.
			const onStage = flagsRead(npc.requires);
			const needed = [...flagsRead(wanted)].filter((flag) => !onStage.has(flag));
			if (needed.length === 0) return npc;

			// An opening written for the wait is the other good answer, and a better one —
			// somebody who is there and says the time has not come is a scene. Leave it be.
			const tree = artifact.trees?.[beatNpcId(beat)];
			const knows = Object.values(tree?.nodes ?? {}).some((node) =>
				[node.requires, ...node.choices.map((choice) => choice.requires)].some((condition) =>
					[...flagsRead(asCondition(condition))].some((flag) => needed.includes(flag)),
				),
			);
			if (knows) return npc;

			const requires: Condition = { all: [npc.requires, wanted] };
			repairs.push(
				`${spec.name}: ${npc.name} was on stage before beat ${beat.id} could open; gated them on the same condition`,
			);
			return { ...npc, requires };
		});
		if (npcs.some((npc, index) => npc !== spec.npcs[index])) {
			sites[key] = { ...spec, npcs };
			changed = true;
		}
	}

	return changed ? { artifact: { ...artifact, sites }, repairs } : { artifact, repairs: [] };
}
