import { resolveOverride } from "../content/load.js";
import { DEFAULT_PACK } from "../core/content/default.js";
import type { GoodsTables } from "../core/content/goods.js";
import { mergeOverride, mergePack, type PackOverride } from "../core/content/pack.js";
import { getInterior } from "../core/gen/features/interior.js";
import type { AnchorKind } from "../core/gen/features/patch.js";
import { generateFeature, invalidateFeature } from "../core/gen/features/registry.js";
import { standingRoom } from "../core/gen/features/residents.js";
import { findPath } from "../core/geom/astar.js";
import { beatNpcId, orderedBeats, type ScenarioBeat } from "../core/rules/arc.js";
import type { CardSection } from "../core/rules/card.js";
import { asCondition, flagsRead, itemsRead, npcsRead } from "../core/rules/condition.js";
import type { DomainEffect } from "../core/rules/effects.js";
import type { Barrier } from "../core/rules/lock.js";
import { obtainableItems } from "../core/rules/obtainable.js";
import { placementSlot } from "../core/rules/placement.js";
import {
	EMPTY_SURROUNDINGS,
	resolveObjectiveTarget,
	type Surroundings,
} from "../core/rules/surroundings.js";
import type { TerrainId } from "../core/tiles/terrain.js";
import { isWellInside } from "../core/world/bounds.js";
import { HALO } from "../core/world/coords.js";
import { MACRO, type MacroSite, maxFeatureRadius, sitesInside } from "../core/world/macro.js";
import { type PlaceRecipe, placeKey, type WorldRules } from "../core/world/recipe.js";
import { npcId } from "../core/world/spec.js";
import { resolveBarriers } from "../engine/barriers.js";
import { resolvePlacements } from "../engine/placements.js";
import { artifactWorld, type ScenarioArtifact } from "./artifact.js";
import { checkCompleteness } from "./completeness.js";
import { conditionSatisfiable, flagsWritten, unsatisfiableFlags } from "./flag-sources.js";
import { gridFor, isPassable, type PassabilityGrid, pathLength, terrainOf } from "./passability.js";
import { journeys, toldWhereToGo } from "./wayfinding.js";

/**
 * The goods this scenario is written against.
 *
 * Resolved exactly the way `repo.ts` resolves a scenario's pack when it is read off
 * disk — the named pack first, the scenario's own tables over it — because the whole
 * value of `obtainableItems` living in `core` is that the validator and the running
 * engine ask one question rather than two similar ones. Two resolutions here would be
 * two answers, and the symptom is a scenario that validates carrying a fetch quest the
 * game refuses.
 *
 * Both shapes are handled deliberately. An artifact loaded from disk has already had its
 * `pack` folded into `content`; one straight out of the authoring passes — which is what
 * the repair loop validates, several times — still carries only the name.
 *
 * Memoised per artifact, because this runs once per site and the alternative is reading
 * and parsing the same pack file forty times.
 */
const goodsCache = new WeakMap<ScenarioArtifact, GoodsTables>();

export function goodsFor(artifact: ScenarioArtifact): GoodsTables {
	const cached = goodsCache.get(artifact);
	if (cached) return cached;
	const named: PackOverride | undefined = artifact.pack
		? resolveOverride(artifact.pack)
		: undefined;
	const goods = mergePack(DEFAULT_PACK, mergeOverride(named, artifact.content)).goods;
	goodsCache.set(artifact, goods);
	return goods;
}

/**
 * Check authored content against the world it claims to describe.
 *
 * This is the strongest argument for pre-generating a scenario at all. The
 * generator is pure and runs offline, so the tool can execute the real thing over
 * its own output and check what live generation structurally cannot: that the
 * person the story hangs on is standing at an anchor that exists, that the building
 * they were assigned got built, that the road between two beats can actually be
 * walked. A live director cannot ask any of these, because by the time it could the
 * player would already be standing there.
 *
 * `verifyArtifact` in `repo.ts` is the cheap half and runs on every load. This is
 * the expensive half and runs once, at authoring time.
 *
 * Everything about *names* defers to `core/rules/surroundings.ts`, and everything
 * about *obtainability* to `core/rules/obtainable.ts` — the same functions the
 * running game uses. That is not tidiness. While this file had its own answers, it
 * matched place names by substring and guessed obtainability from a pattern over
 * roles, so it accepted quests the game would refuse and refused none it accepted.
 * A validator that disagrees with the thing it validates is worse than no validator,
 * because it is believed.
 */

export type Severity = "error" | "warning";

export interface Finding {
	readonly severity: Severity;
	readonly message: string;
	/**
	 * The conversation this is about, by `npcId`, where it is about one.
	 *
	 * Carried structurally so that a pass which *fixes* faults can find the ones it is able
	 * to fix without reading the message. Every repair in `repair.ts` re-derives its own
	 * condition for exactly that reason — parsing a sentence written for a person couples
	 * the fix to the wording, so improving a message would silently disable it — and this is
	 * the same rule kept while making the findings addressable.
	 *
	 * What the message is still for: telling a model what went wrong. A rewrite briefed with
	 * "this scene opens while the player is carrying the thing and then takes it, so every
	 * later hello asks for it again" produces a better second attempt than one asked to try
	 * again, and that sentence already exists here.
	 */
	readonly tree?: string;
}

const error = (message: string, tree?: string): Finding => ({
	severity: "error",
	message,
	...(tree ? { tree } : {}),
});
const warning = (message: string, tree?: string): Finding => ({
	severity: "warning",
	message,
	...(tree ? { tree } : {}),
});

export function hasErrors(findings: readonly Finding[]): boolean {
	return findings.some((finding) => finding.severity === "error");
}

/**
 * The two pacing shapes worth remarking on.
 *
 * Guesses about the player rather than facts about the world, which is why both
 * produce a warning with the real number in it. A very long single leg is the one
 * that actually spoils a session — the player walks for four minutes and begins to
 * suspect the game has lost the thread — and a story that never leaves one place is
 * the other. Everything between those is a pace, not a mistake.
 */
export const LONG_MARCH = 320;
export const SHORT_STORY = 60;

/**
 * The anchor a placement really resolves to.
 *
 * Mirrors `pickAnchor`: a `yard` is served by a `doorstep`. Kept in step with it by
 * hand, which is a small risk, but the alternative is reaching into the engine from
 * a validation pass to ask one question.
 */
function anchorAliasFor(placement: AnchorKind): AnchorKind {
	return placement === "yard" ? "doorstep" : placement;
}

/**
 * Where every site of this seed is.
 *
 * `macroSite` is the only authority on a site's position — the spec does not carry
 * it — so the footprint is swept once and the answers kept, rather than each check
 * searching for itself.
 */
export function siteIndex(artifact: ScenarioArtifact): Map<number, MacroSite> {
	return sitesInside(artifactWorld(artifact), artifact.bounds);
}

/**
 * A passability grid for a written world.
 *
 * The artifact's own rosters go in, so the streets it contains are the streets the
 * player will walk. Built once per validation run and shared by every path check: at the
 * longest duration this is a 1216-square grid, and rebuilding it per query would
 * dominate the whole pipeline.
 */
export function buildPassability(artifact: ScenarioArtifact): PassabilityGrid {
	return gridFor(artifactWorld(artifact), artifact.bounds, (site) => {
		return artifact.sites[String(site.id)]?.settlement;
	});
}

/**
 * How much walking the story asks for, leg by leg.
 *
 * Spawn to the first beat, then beat to beat in order. Stops at the first leg that
 * cannot be walked at all, which is the finding that matters most: a story with an
 * unreachable beat is a story that cannot be finished.
 *
 * A *leg* is a journey between two places, which is what a player experiences —
 * consecutive beats at the same site are one scene, not two walks. Counting beats
 * instead made a story with four scenes in one castle look like four journeys.
 */
export function storyWalk(
	artifact: ScenarioArtifact,
	grid: PassabilityGrid,
	sites: Map<number, MacroSite>,
): {
	readonly tiles: number;
	readonly legs: readonly { readonly to: string; readonly tiles: number }[];
	readonly unreachable?: string;
} {
	const legs: { to: string; tiles: number }[] = [];
	if (!artifact.arc) return { tiles: 0, legs };

	let tiles = 0;
	let at: number | undefined;
	let from: { readonly x: number; readonly y: number } = artifact.spawn;
	for (const beat of orderedBeats(artifact.arc)) {
		const to = sites.get(beat.siteId)?.site;
		if (!to) return { tiles, legs, unreachable: beat.id };
		if (beat.siteId === at) continue;
		const length = pathLength(grid, from, to);
		if (length === undefined) return { tiles, legs, unreachable: beat.id };
		tiles += length;
		legs.push({ to: artifact.sites[String(beat.siteId)]?.name ?? beat.id, tiles: length });
		from = to;
		at = beat.siteId;
	}
	return { tiles, legs };
}

/**
 * Everything the offline pass can check.
 *
 * Errors are content that will not work. Warnings are content that will work but
 * is probably not what was meant — a duration that does not match the walking, a
 * town the story never visits.
 */
export function validateArtifact(artifact: ScenarioArtifact): Finding[] {
	const findings: Finding[] = [];
	// Before anything else, because a recipe that reaches past the halo produces a
	// world the rest of these checks would measure and find nothing wrong with — the
	// disagreement is between chunks, not between the content and the world.
	const sites = siteIndex(artifact);
	findings.push(...checkRecipe(artifact, sites));

	// Settlements first: it drops the patch cache per site, and the passability grid
	// stamps those same patches, so building the grid first would measure a layout
	// that is about to be invalidated.
	findings.push(...checkPlaces(artifact, sites));
	const grid = buildPassability(artifact);
	const terrainAt = (x: number, y: number) => terrainOf(grid, x, y);
	findings.push(...checkSpawn(artifact, grid));
	findings.push(...checkStory(artifact, grid, sites, terrainAt));
	findings.push(...checkTrees(artifact));
	findings.push(...checkGates(artifact, grid, sites));
	findings.push(...checkPlacements(artifact, grid, sites));
	findings.push(...checkSigns(artifact, grid, sites));
	findings.push(...checkWayfinding(artifact, sites));
	findings.push(...checkConditions(artifact));
	findings.push(...checkFindability(artifact));
	findings.push(...checkBranches(artifact));
	// After the branch check, which speaks about forks in the fork's own terms. This one
	// asks the larger question — whether any route through the story reaches the end —
	// and stays quiet about anything the check above has already explained.
	findings.push(...checkCompleteness(artifact));
	findings.push(...checkEarlyCast(artifact));
	findings.push(...checkHandovers(artifact));
	return findings;
}

/**
 * Whether the recipe describes a world the generator can actually hold.
 *
 * A recipe reaches deeper than anything else a scenario can write. Bad content makes a
 * story that does not work; a bad recipe makes a *world* that does not work, and it
 * does so silently — nothing throws, chunks simply stop agreeing with each other, and
 * the symptom is a town whose outskirts vanish when you walk far enough away. The
 * schema catches values out of range. These are the things that are individually in
 * range and wrong together.
 */
function checkRecipe(artifact: ScenarioArtifact, sites: Map<number, MacroSite>): Finding[] {
	const findings: Finding[] = [];
	const recipe = artifact.recipe;
	if (!recipe) return findings;

	const { rules } = artifactWorld(artifact);

	// The one that breaks the seam contract. Every chunk consults `HALO` macro cells
	// around itself for features; anything reaching further exists in the chunks near
	// it and not in the chunks beyond, and no amount of blending can reconcile that.
	const reach = maxFeatureRadius(rules);
	if (reach > HALO * MACRO) {
		findings.push(
			error(
				`the recipe allows a feature of radius ${reach}, but a chunk only looks ${HALO * MACRO} tiles for one; a place that big would exist in some chunks and not others`,
			),
		);
	}

	// Two places in one macro cell is not two places: the map is keyed by cell, so the
	// later one silently replaces the earlier, and the author gets one town where they
	// wrote two with no complaint from anywhere.
	const byCell = new Map<string, PlaceRecipe>();
	for (const place of recipe.places ?? []) {
		const key = placeKey(Math.floor(place.at.x / MACRO), Math.floor(place.at.y / MACRO));
		const already = byCell.get(key);
		if (already) {
			findings.push(
				error(
					`two places share the macro cell at ${key}: ${describePlace(already)} and ${describePlace(place)}; only the second one exists`,
				),
			);
		}
		byCell.set(key, place);

		if (!isWellInside(artifact.bounds, place.at.x, place.at.y)) {
			findings.push(
				error(`${describePlace(place)} is outside the world, or inside its boundary band`),
			);
		}
	}

	// A place that overlaps something the world already rolled is the same complaint
	// and much easier to make by accident: the author can see their own coordinates and
	// cannot see the town two cells over until they generate the map.
	for (const place of byCell.values()) {
		const reach = radiusOf(place, rules);
		for (const site of sites.values()) {
			if (site.authored) continue;
			const gap = Math.hypot(site.site.x - place.at.x, site.site.y - place.at.y);
			if (gap >= reach + site.radius) continue;
			const name = artifact.sites[String(site.id)]?.name ?? site.kind;
			findings.push(
				warning(
					`${describePlace(place)} overlaps ${name} by ${Math.round(reach + site.radius - gap)} tiles`,
				),
			);
		}
	}

	// Overlapping footprints are legal — the clip-into-chunks model copes — but they
	// read as one sprawling place rather than as two, which is almost never what
	// somebody who wrote down two coordinates meant.
	const placed = [...byCell.values()];
	for (let i = 0; i < placed.length; i++) {
		for (let j = i + 1; j < placed.length; j++) {
			const a = placed[i] as PlaceRecipe;
			const b = placed[j] as PlaceRecipe;
			const gap = Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y);
			const together = radiusOf(a, rules) + radiusOf(b, rules);
			if (gap < together) {
				findings.push(
					warning(
						`${describePlace(a)} and ${describePlace(b)} overlap by ${Math.round(together - gap)} tiles; they will read as one place`,
					),
				);
			}
		}
	}

	// A zone nowhere near the playable world costs nothing and does nothing, which is
	// the signature of a coordinate typed wrong.
	for (const zone of recipe.zones ?? []) {
		const { minX, minY, maxX, maxY } = artifact.bounds;
		const nearestX = Math.max(minX, Math.min(maxX, zone.at.x));
		const nearestY = Math.max(minY, Math.min(maxY, zone.at.y));
		if (Math.hypot(zone.at.x - nearestX, zone.at.y - nearestY) > zone.radius) {
			findings.push(
				warning(
					`zone ${zone.id ?? `at ${zone.at.x},${zone.at.y}`} does not reach the playable world`,
				),
			);
		}
	}

	return findings;
}

function describePlace(place: PlaceRecipe): string {
	return `the ${place.kind} at ${place.at.x},${place.at.y}`;
}

function radiusOf(place: PlaceRecipe, rules: WorldRules): number {
	if (place.radius !== undefined) return place.radius;
	const rule = rules.sites.radius[place.kind];
	return rule.base + (rule.perImportance ?? 0) * (place.importance ?? 3);
}

/**
 * Whether the player can find out that a gated item exists.
 *
 * The check this file was missing, and the one that cost a playthrough. A condition on
 * `{ item: X }` passes every other test here as long as X is obtainable — but
 * obtainable is not the same as *findable*. A story can gate its whole third act on a
 * disc in a locked tower and never once mention the disc, at which point the player
 * finishes the second act, watches the errand log go empty, and has nothing to read and
 * nowhere to go. Every other check in this file is about whether the world agrees with
 * the story; this one is about whether the story ever told the player.
 *
 * Satisfied by any of three things, because authors legitimately vary in how blunt they
 * are: an errand that asks for the item outright, a conversation that hands it over, or
 * the name appearing in prose the player will actually read. The third is a
 * substring match on authored text, which is loose — but the failure being caught is
 * "the name appears nowhere at all", and for that a loose test is the right one.
 */
function checkFindability(artifact: ScenarioArtifact): Finding[] {
	const gated = new Set<string>();
	const collect = (condition: Parameters<typeof asCondition>[0]) => {
		for (const item of itemsRead(asCondition(condition))) gated.add(item);
	};
	for (const trigger of artifact.triggers ?? []) collect(trigger.when);
	for (const barrier of artifact.barriers ?? []) collect(barrier.opensWhen);
	for (const beat of artifact.arc?.beats ?? []) {
		collect(beat.requires);
		collect(beat.opensOn);
	}
	for (const ending of artifact.arc?.endings ?? []) collect(ending.when);
	for (const placement of artifact.placements ?? []) collect(placement.requires);
	for (const spec of Object.values(artifact.sites)) {
		for (const npc of spec.npcs) collect(npc.requires);
		for (const structure of spec.settlement.structures) collect(structure.lock?.opensWhen);
	}
	for (const tree of Object.values(artifact.trees ?? {})) {
		for (const node of Object.values(tree.nodes)) {
			collect(node.requires);
			for (const choice of node.choices) collect(choice.requires);
		}
	}
	if (gated.size === 0) return [];

	// Errands that ask for something by name, and conversations that hand one over.
	const asked = new Set<string>();
	for (const beat of artifact.arc?.beats ?? []) {
		for (const objective of beat.quest?.objectives ?? []) {
			if (objective.kind === "have") asked.add(objective.target.toLowerCase());
		}
	}
	for (const tree of Object.values(artifact.trees ?? {})) {
		for (const node of Object.values(tree.nodes)) {
			for (const action of node.actions ?? []) {
				if ((action.kind === "giveItem" || action.kind === "sell") && action.item) {
					asked.add(action.item.toLowerCase());
				}
				for (const objective of action.objectives ?? []) {
					if (objective.kind === "have") asked.add(objective.target.toLowerCase());
				}
			}
		}
	}

	const prose = authoredProse(artifact).toLowerCase();

	const findings: Finding[] = [];
	for (const item of gated) {
		const lower = item.toLowerCase();
		if (asked.has(lower) || prose.includes(lower)) continue;
		findings.push(
			error(
				`something is gated on carrying "${item}", but no errand asks for it and nothing the player reads mentions it; there is no way to learn it exists`,
			),
		);
	}
	return findings;
}

/**
 * Everything in the scenario the player will actually read.
 *
 * Descriptions, journal lines, cards and speech — not ids, not flag keys, not the
 * `knows` list's own framing. One string, because the question asked of it is only ever
 * "does this name appear anywhere".
 */
function authoredProse(artifact: ScenarioArtifact): string {
	const parts: string[] = [];
	const card = (body: { title: string; subtitle?: string; sections: readonly CardSection[] }) => {
		parts.push(
			body.title,
			body.subtitle ?? "",
			...body.sections.flatMap((s) => [s.heading, s.body]),
		);
	};

	/** The words inside a list of effects, wherever the list came from. */
	const proseIn = (effects: readonly DomainEffect[] | undefined): string[] => {
		const said: string[] = [];
		for (const effect of effects ?? []) {
			if (effect.t === "RecordJournal") said.push(effect.entry.text);
			if (effect.t === "ShowCard") card(effect.card);
			if (effect.t === "AdvanceQuest") said.push(effect.note);
			if (effect.t === "CreateQuest") said.push(effect.name, effect.description);
		}
		return said;
	};

	for (const spec of Object.values(artifact.sites)) {
		parts.push(spec.description, ...spec.hooks);
		for (const npc of spec.npcs) parts.push(...npc.knows, npc.persona, npc.appearance);
		for (const structure of spec.settlement.structures) {
			parts.push(structure.signText ?? "", structure.lock?.lockedText ?? "");
		}
	}
	for (const beat of artifact.arc?.beats ?? []) {
		parts.push(beat.journal ?? "", beat.quest?.name ?? "", beat.quest?.description ?? "");
		if (beat.card) card(beat.card);
		parts.push(...proseIn(beat.effects));
	}
	if (artifact.arc?.ending) card(artifact.arc.ending);
	for (const ending of artifact.arc?.endings ?? []) card(ending);
	for (const trigger of artifact.triggers ?? []) parts.push(...proseIn(trigger.effects));
	for (const barrier of artifact.barriers ?? []) {
		parts.push(barrier.lockedText, barrier.opensText ?? "");
	}
	for (const tree of Object.values(artifact.trees ?? {})) {
		for (const node of Object.values(tree.nodes)) {
			parts.push(node.speech, ...node.choices.map((choice) => choice.text));
		}
	}
	return parts.join("\n");
}

/**
 * Every gate the scenario puts across the world.
 *
 * A barrier is the one authored thing that writes into the map, so getting it wrong is
 * visible in a way the rest is not: a gate on ground nobody walks is scenery, and a
 * gate with open ground on only one side is a wall with a door in it that leads nowhere.
 *
 * Checked against a grid built *without* the gates stamped, deliberately — the question
 * is what the tile would be if the gate were not there, which is exactly what tells a
 * gate across a road from a gate embedded in a cliff.
 */
function checkGates(
	artifact: ScenarioArtifact,
	grid: PassabilityGrid,
	sites: Map<number, MacroSite>,
): Finding[] {
	const findings: Finding[] = [];
	if (!artifact.barriers?.length) return findings;

	// Resolved through the same function the session resolves them with, so a gate this
	// accepts is one that will really be stamped. A span naming a castle's gate is the
	// spelling most worth checking here, because it is the one that can go stale
	// silently: the recipe moves the castle and the gate follows, or it does not exist.
	const { resolved: barriers, unresolved } = resolveBarriers(artifact.barriers, {
		world: artifactWorld(artifact),
		bounds: artifact.bounds,
	});
	for (const problem of unresolved) {
		findings.push(error(`barrier ${problem.id}: ${problem.reason}`));
	}
	if (barriers.length === 0) return findings;

	const seen = new Set<string>();
	/** Every gate tile in the scenario, so a bypass test can shut them all at once. */
	const shut = new Set<string>();
	for (const barrier of barriers) {
		for (const tile of barrier.tiles) shut.add(`${tile.x},${tile.y}`);
	}

	for (const barrier of barriers) {
		if (seen.has(barrier.id)) findings.push(error(`barrier ${barrier.id} is defined twice`));
		seen.add(barrier.id);

		for (const tile of barrier.tiles) {
			if (!isWellInside(artifact.bounds, tile.x, tile.y)) {
				findings.push(
					error(`barrier ${barrier.id} has a tile at ${tile.x},${tile.y} inside the boundary band`),
				);
			} else if (!isPassable(grid, tile.x, tile.y)) {
				findings.push(
					error(
						`barrier ${barrier.id} has a tile at ${tile.x},${tile.y} on ground the player could not walk anyway; it will read as scenery`,
					),
				);
			}
		}

		findings.push(...checkGateBlocks(barrier, grid, shut));
	}

	findings.push(...checkNobodyStandsOnAGate(artifact, sites, shut));
	return findings;
}

/**
 * Whether anybody is standing in the gateway.
 *
 * A gate opens when the player *walks into it*, and walking into a person opens a
 * conversation before anything else is considered. So somebody standing on a gate tile
 * makes that tile unbumpable, and if they are on the only tile the road leads to, the
 * gate can never be opened at all. The symptom is the worst kind: the player talks to
 * the gatekeeper, the flag is set, the errand advances, and the gate stays shut — so it
 * reads as "I must be missing a step" rather than as a fault.
 *
 * Shipped once, in this scenario: the castle generator put its `gate` anchor on the
 * middle tile of its own arch, the porter took it, and the road led straight to him.
 */
function checkNobodyStandsOnAGate(
	artifact: ScenarioArtifact,
	sites: Map<number, MacroSite>,
	shut: ReadonlySet<string>,
): Finding[] {
	const findings: Finding[] = [];
	for (const spec of Object.values(artifact.sites)) {
		const site = sites.get(spec.siteId);
		if (!site) continue;
		const built = generateFeature(artifactWorld(artifact), site, spec.settlement);
		if (!built) continue;
		for (const anchor of built.anchors) {
			if (!shut.has(`${anchor.x},${anchor.y}`)) continue;
			findings.push(
				error(
					`${spec.name} has a "${anchor.kind}" anchor at ${anchor.x},${anchor.y}, which is a gate tile; anybody standing there is spoken to instead of the gate being opened, and the gate can never be bumped`,
				),
			);
		}
	}
	return findings;
}

/**
 * Whether a gate actually stops anybody.
 *
 * The check that matters, and the one a look at the tile cannot make: a gate on the
 * middle tile of a three-wide cobbled road is not a gate. The player walks round it,
 * arrives where they were not supposed to be yet, and nothing in the game has gone
 * wrong from its own point of view — the story simply lost the shape it was gated into
 * having. That is invisible from inside a running game and obvious from out here, which
 * is the whole argument for the offline pass.
 *
 * Asked as reachability with *every* gate in the scenario shut, not just this one, so
 * two gates covering one road between them are judged as the pair they are.
 */
function checkGateBlocks(
	barrier: Barrier,
	grid: PassabilityGrid,
	shut: ReadonlySet<string>,
): Finding[] {
	const open = (x: number, y: number) => isPassable(grid, x, y) && !shut.has(`${x},${y}`);

	/*
	 * The two sides of the span, taken perpendicular to how the span is laid.
	 *
	 * Which is the whole subtlety: collecting every open neighbour of every gate tile
	 * gathers tiles on the *same* side as well, and two tiles on the same side are of
	 * course connected — so a check that compared arbitrary pairs reported a two-tile
	 * "way round" for every gate in the world, including ones that block perfectly.
	 * A span laid along x has a north side and a south side, and those are the only two
	 * the question is about.
	 */
	const alongX = barrier.tiles.every((tile) => tile.y === barrier.tiles[0]?.y);
	const alongY = barrier.tiles.every((tile) => tile.x === barrier.tiles[0]?.x);
	if (!alongX && !alongY) {
		return [
			warning(
				`barrier ${barrier.id} is not laid along a single row or column, so whether it blocks anything cannot be checked`,
			),
		];
	}
	const [ax, ay] = alongX ? ([0, 1] as const) : ([1, 0] as const);

	const near: { x: number; y: number }[] = [];
	const far: { x: number; y: number }[] = [];
	for (const tile of barrier.tiles) {
		if (open(tile.x - ax, tile.y - ay)) near.push({ x: tile.x - ax, y: tile.y - ay });
		if (open(tile.x + ax, tile.y + ay)) far.push({ x: tile.x + ax, y: tile.y + ay });
	}
	if (near.length === 0 || far.length === 0) {
		return [
			warning(
				`barrier ${barrier.id} has open ground on only one side; it may not be on a route at all`,
			),
		];
	}

	// The shortest way from one side to the other with every gate shut. Absent means the
	// land does the rest of the blocking, which is the ideal a gate wants to stand in.
	//
	// Four-connected, because the player is: `facingDelta` gives four directions, so a
	// route that slips diagonally past the end of a span is not a route anybody can walk.
	const bounds = { x: grid.x, y: grid.y, w: grid.w, h: grid.h };
	let shortest: number | undefined;
	for (const from of near) {
		for (const to of far) {
			const route = findPath(from, to, {
				bounds,
				cost: (x, y) => (open(x, y) ? 1 : Number.POSITIVE_INFINITY),
				diagonal: false,
				heuristicWeight: 1.2,
			});
			if (route && (shortest === undefined || route.length < shortest)) shortest = route.length;
		}
	}

	if (shortest === undefined) return [];
	// Graded by how far round, because that is the difference between a gate and a
	// stile. A handful of tiles means the span does not cross the way through at all —
	// the player steps onto the verge and back on, and the gate has done nothing. A long
	// detour through cliffs and forest is a real gate even though a determined player
	// could technically walk it, so that is the author's call and this only says how far.
	if (shortest <= TRIVIAL_DETOUR) {
		return [
			error(
				`barrier ${barrier.id} can be stepped around in ${shortest} tiles; widen its span across the whole way through`,
			),
		];
	}
	return [
		warning(
			`barrier ${barrier.id} can be walked around, but only by ${shortest} tiles of detour; that may be the point`,
		),
	];
}

/**
 * How short a way round makes a gate decorative rather than merely leaky.
 *
 * Thirty tiles is under half a screen at any zoom: a player who bumps into the gate
 * sees the way round without looking for it, so the gate reads as broken rather than as
 * an obstacle. Past that the detour is something they have to decide to do.
 */
const TRIVIAL_DETOUR = 30;

/**
 * Every item the scenario puts somewhere.
 *
 * Resolved through the same function the engine resolves them with, so a placement this
 * accepts is one that will actually be findable. That matters more than the duplication
 * it saves: an item that is quietly nowhere makes a `have` objective naming it
 * impossible to finish, and nothing on screen says why.
 */
/**
 * How far a placement is from anywhere the story sends the player.
 *
 * Beyond this it is not hidden, it is lost: the search gesture works one tile at a
 * time, so an item nobody is within sight of is an item found by sweeping the map.
 */
const FAR_TO_FETCH = 40;

function checkPlacements(
	artifact: ScenarioArtifact,
	grid: PassabilityGrid,
	sites: Map<number, MacroSite>,
): Finding[] {
	const findings: Finding[] = [];
	const placements = artifact.placements ?? [];
	if (placements.length === 0) return findings;

	const ids = new Set<string>();
	for (const placement of placements) {
		if (ids.has(placement.id)) findings.push(error(`placement ${placement.id} is defined twice`));
		ids.add(placement.id);
	}

	const { resolved, unresolved } = resolvePlacements(placements, {
		world: artifactWorld(artifact),
		siteSpec: (siteId) => artifact.sites[String(siteId)],
		bounds: artifact.bounds,
	});
	for (const problem of unresolved) {
		findings.push(error(`placement ${problem.id}: ${problem.reason}`));
	}

	const slots = new Map<string, string>();
	for (const entry of resolved) {
		// Two items on one tile is not a crash — the later wins, deterministically — but
		// one of them is unreachable, which is the same silent failure as being nowhere.
		const slot = placementSlot(entry.interiorId, entry.x, entry.y, entry.level);
		const other = slots.get(slot);
		if (other) {
			findings.push(
				error(`placements ${other} and ${entry.id} land on the same tile; only one can be found`),
			);
		}
		slots.set(slot, entry.id);

		// Only world placements can be checked against the map: an interior position is
		// in its own coordinate space and the grid knows nothing about it.
		if (entry.interiorId !== undefined) continue;
		if (!isWellInside(artifact.bounds, entry.x, entry.y)) {
			findings.push(error(`placement ${entry.id} is inside the boundary band`));
			continue;
		}
		if (!isPassable(grid, entry.x, entry.y)) {
			findings.push(
				error(`placement ${entry.id} is on a tile the player cannot stand next to and search`),
			);
			continue;
		}

		// Passable is not the same as reachable. An item on a marsh island across an
		// inlet passes every other test here and is found by nobody; the first version of
		// the shipped scenario had one sixty-two tiles round the water from the person
		// who asks for it, and nothing said so.
		const walk = nearestStop(artifact, sites, entry);
		if (!walk) continue;
		const distance = pathLength(grid, walk.at, entry);
		if (distance === undefined) {
			findings.push(
				error(
					`placement ${entry.id} cannot be walked to from ${walk.name}; it is on ground cut off from the rest of the world`,
				),
			);
		} else if (distance > FAR_TO_FETCH) {
			findings.push(
				warning(
					`placement ${entry.id} is ${distance} tiles from ${walk.name}, the nearest place the story sends anybody; that is a sweep of the map rather than a search`,
				),
			);
		}
	}
	return findings;
}

/**
 * The nearest place the story actually sends the player, for a world placement.
 *
 * Beats first, then the spawn, because a beat is somewhere the player is *told* to
 * stand and the spawn is only where they start. A scenario with no arc still gets the
 * spawn, which is the only place it can promise anybody will be.
 */
function nearestStop(
	artifact: ScenarioArtifact,
	sites: Map<number, MacroSite>,
	at: { readonly x: number; readonly y: number },
): { readonly at: { readonly x: number; readonly y: number }; readonly name: string } | undefined {
	let best: { at: { x: number; y: number }; name: string; gap: number } | undefined;
	for (const beat of artifact.arc?.beats ?? []) {
		const site = sites.get(beat.siteId);
		if (!site) continue;
		const gap = Math.hypot(site.site.x - at.x, site.site.y - at.y);
		if (best && gap >= best.gap) continue;
		best = {
			at: { x: site.site.x, y: site.site.y },
			name: artifact.sites[String(beat.siteId)]?.name ?? `site ${beat.siteId}`,
			gap,
		};
	}
	if (best) return { at: best.at, name: best.name };
	return { at: artifact.spawn, name: "the spawn" };
}

/**
 * Every signpost, and whether anybody can read it.
 *
 * A board fails in exactly two ways and both are silent. It can stand somewhere nobody can
 * get in front of — in the water, in the cliffs closing the world, walled into a plot —
 * in which case the generator declines to put a post up at all and the tile is bare
 * ground with a promise attached to it. Or an arm can name a site this world does not
 * have, in which case the arm is dropped at read time and the board says less than it
 * claims to.
 *
 * Warnings throughout, deliberately. A missing signpost is a world that is harder to
 * follow, never a world that cannot be finished, and refusing a scenario over one would
 * be refusing it over a convenience.
 */
function checkSigns(
	artifact: ScenarioArtifact,
	grid: PassabilityGrid,
	sites: Map<number, MacroSite>,
): Finding[] {
	const findings: Finding[] = [];
	const signs = artifact.signs ?? [];
	if (signs.length === 0) return findings;

	const seen = new Map<string, string>();
	for (const sign of signs) {
		if (seen.has(sign.id)) findings.push(warning(`signpost ${sign.id} is defined twice`));
		seen.set(sign.id, sign.id);

		const tile = `${sign.x},${sign.y}`;
		const other = [...signs].find((each) => each !== sign && `${each.x},${each.y}` === tile);
		if (other) {
			findings.push(
				warning(
					`signposts ${sign.id} and ${other.id} stand on the same tile at ${tile}; only one board is there`,
				),
			);
		}

		if (!isWellInside(artifact.bounds, sign.x, sign.y)) {
			findings.push(
				warning(`signpost ${sign.id} is outside the world, or inside its boundary band`),
			);
		} else if (!isPassable(grid, sign.x, sign.y)) {
			findings.push(
				warning(
					`signpost ${sign.id} is on ground nobody can stand on, so no post goes up there and nothing can be read`,
				),
			);
		}

		for (const arm of sign.arms) {
			if (sites.has(arm.siteId) && artifact.sites[String(arm.siteId)]) continue;
			findings.push(
				warning(
					`signpost ${sign.id} has an arm pointing at site ${arm.siteId}, which is not in this scenario; that arm is left off the board`,
				),
			);
		}
	}
	return findings;
}

/**
 * Whether the story ever says where to go next.
 *
 * The fault a playthrough found and no check could see. Every beat opened, every errand
 * landed in the log, every flag was written and read — and the player finished a scene,
 * looked at an errand that said "find out what happened to the tallies", and had no idea
 * which of six towns to walk to. The next beat was forty minutes' walk away in a place
 * nothing had named.
 *
 * What counts as having been told lives in `wayfinding.ts`, because the repair that appends
 * a direction has to ask the identical question — a check and its fix that disagree are
 * worse than either alone.
 */
function checkWayfinding(artifact: ScenarioArtifact, sites: Map<number, MacroSite>): Finding[] {
	const findings: Finding[] = [];
	for (const journey of journeys(artifact, sites)) {
		if (toldWhereToGo(artifact, journey)) continue;
		findings.push(
			warning(
				`after beat ${journey.from.id} the player is expected at ${journey.destination.name}, and nothing tells them so — no journal line, errand or conversation up to that point names it, and no signpost points there. A player who has not been there has no bearing on the map either`,
				beatNpcId(journey.from),
			),
		);
	}
	return findings;
}

/**
 * Conditions that can never come true.
 *
 * The single most valuable check on the whole new surface, because the runtime symptom
 * is *nothing*: a gate whose flag nobody sets is simply barred forever, an NPC whose
 * flag nobody sets is simply absent, and both look exactly like content the player has
 * not reached yet. There is no error to see and no way to tell from inside the game.
 *
 * Generous about what counts as a writer — beats, triggers, written dialogue, cards,
 * barriers and the engine's own `visited:`/`card:`/`arc:` prefixes — because a false
 * positive here refuses a scenario that would have played.
 */
function checkConditions(artifact: ScenarioArtifact): Finding[] {
	const findings: Finding[] = [];
	const written = flagsWritten(artifact);
	const people = new Set(
		Object.values(artifact.sites).flatMap((spec) =>
			spec.npcs.map((npc) => npcId(spec.siteId, npc.slot)),
		),
	);

	const check = (where: string, requires: Parameters<typeof unsatisfiableFlags>[0]) => {
		for (const flag of unsatisfiableFlags(requires, written)) {
			findings.push(error(`${where} waits on "${flag}", which nothing sets`));
		}
		for (const id of npcsRead(asCondition(requires))) {
			if (!people.has(id)) {
				findings.push(warning(`${where} asks about "${id}", who is not in this scenario`));
			}
		}
	};

	for (const trigger of artifact.triggers ?? []) check(`trigger ${trigger.id}`, trigger.when);
	for (const barrier of artifact.barriers ?? []) check(`barrier ${barrier.id}`, barrier.opensWhen);
	for (const placement of artifact.placements ?? []) {
		if (placement.requires) check(`placement ${placement.id}`, placement.requires);
	}
	for (const beat of artifact.arc?.beats ?? []) {
		if (beat.opensOn) check(`beat ${beat.id}`, beat.opensOn);
	}
	for (const ending of artifact.arc?.endings ?? []) {
		if (ending.when) check(`ending ${ending.id}`, ending.when);
	}
	for (const spec of Object.values(artifact.sites)) {
		for (const npc of spec.npcs) {
			if (npc.requires) check(`${spec.name}: ${npc.name}`, npc.requires);
		}
		for (const structure of spec.settlement.structures) {
			if (structure.lock) {
				check(
					`${spec.name}: the ${structure.name ?? structure.kind}'s lock`,
					structure.lock.opensWhen,
				);
			}
		}
	}
	for (const [key, tree] of Object.entries(artifact.trees ?? {})) {
		for (const node of Object.values(tree.nodes)) {
			if (node.requires) check(`tree ${key} node ${node.id}`, node.requires);
			for (const choice of node.choices) {
				if (choice.requires) check(`tree ${key} node ${node.id}`, choice.requires);
			}
		}
	}
	return findings;
}

/**
 * Forks, and whether the story survives either answer.
 *
 * The failure worth catching is precise: a beat on the main line gated on a flag that
 * only *one* arm of a fork sets. The player takes the other arm, that beat can never
 * open, and the story stops with `remaining` stuck above zero and nothing to explain it.
 * `arcOutline` already excludes the arm not taken, so the arm itself is fine — it is
 * everything *downstream* that breaks.
 *
 * Checked on flags alone. A beat gated on an item or a quest cannot be decided offline
 * without simulating a playthrough, and guessing would produce exactly the false
 * positives that make a validator stop being believed.
 */
function checkBranches(artifact: ScenarioArtifact): Finding[] {
	const arc = artifact.arc;
	if (!arc) return [];
	const findings: Finding[] = [];

	const groups = new Map<string, ScenarioBeat[]>();
	for (const beat of arc.beats) {
		if (beat.branch === undefined) continue;
		const arms = groups.get(beat.branch);
		if (arms) arms.push(beat);
		else groups.set(beat.branch, [beat]);
	}

	for (const [group, arms] of groups) {
		if (arms.length < 2) {
			findings.push(
				warning(
					`fork "${group}" has only one arm, so it is not a choice; drop the branch or add the alternative`,
				),
			);
			continue;
		}

		findings.push(...checkForkIsSpoken(artifact, group, arms));

		for (const taken of arms) {
			// What is written once this arm is chosen: everything except the flags only the
			// arms *not* taken would have set.
			const barred = new Set(arms.filter((arm) => arm.id !== taken.id).map((arm) => arm.setsFlag));
			const available = flagsWritten(artifact);
			for (const flag of barred) available.delete(flag);

			for (const beat of arc.beats) {
				if (beat.optional) continue;
				if (beat.branch !== undefined && beat.id !== taken.id) continue;
				// Asked as "could this ever open", not "does it mention a barred flag".
				// `{ any: [armA, armB] }` mentions both and is satisfied by either, and it
				// is the only correct way to put a beat downstream of a fork.
				if (conditionSatisfiable(beat.requires, available)) continue;
				const blocking = unsatisfiableFlags(beat.requires, available);
				findings.push(
					error(
						`if "${taken.id}" is chosen, beat ${beat.id} can never open: it waits on ${blocking
							.map((flag) => `"${flag}"`)
							.join(" and ")}, which only the other arm of "${group}" sets`,
					),
				);
			}
		}
	}
	return findings;
}

/**
 * Whether taking one arm of a fork changes anything anybody says.
 *
 * The scenario that prompted this had a real fork — hand the girdle over or keep it
 * back — with an ending card for each arm, and every route through the finale ran into
 * one speech written for the arm that kept it. A player who gave it up was told to his
 * face that he had failed the third test, and *then* shown a card congratulating him.
 * Arthur said the same thing a minute later.
 *
 * A card is an epilogue. The scene is what the player is actually in, and a fork the
 * scene does not know about is a fork the player experiences as being ignored. Nothing
 * else catches it: both arms open, both endings pick correctly, the flags are all
 * written and all read, and the story is wrong anyway.
 *
 * A warning rather than an error. A fork whose consequence is genuinely only in the
 * epilogue is a legitimate, if thin, thing to write.
 */
function checkForkIsSpoken(
	artifact: ScenarioArtifact,
	group: string,
	arms: readonly ScenarioBeat[],
): Finding[] {
	// What choosing an arm marks: its own flag, and anything its effects set. Either is
	// a fair thing for a line of dialogue to be conditioned on.
	const marks = new Set<string>();
	for (const arm of arms) {
		marks.add(arm.setsFlag);
		for (const effect of arm.effects ?? []) {
			if (effect.t === "SetFlag") marks.add(effect.key);
		}
	}

	for (const tree of Object.values(artifact.trees ?? {})) {
		for (const node of Object.values(tree.nodes)) {
			const conditions = [node.requires, ...node.choices.map((choice) => choice.requires)];
			for (const condition of conditions) {
				for (const flag of flagsRead(asCondition(condition))) {
					if (marks.has(flag)) return [];
				}
			}
		}
	}

	return [
		warning(
			`fork "${group}" changes the ending but nothing anybody says: no dialogue node or choice is conditioned on ${[
				...marks,
			]
				.map((flag) => `"${flag}"`)
				.join(" or ")}, so both arms play the same scene`,
		),
	];
}

/**
 * Somebody who comes on stage before the beat they anchor can open.
 *
 * The Green Knight appeared the moment the covenant was sworn and anchored a beat two
 * beats further on. A player who rode straight for the mound found him waiting, walked
 * up, and got the entire finale delivered at them — after which nothing had happened,
 * no flag had moved, and the game offered no hint that anything was missing. It reads
 * exactly like a broken quest, and it is invisible from every other check: the beat is
 * reachable, the flags are all written, the conditions all hold eventually.
 *
 * Only for a cast the author *gated*. Somebody with no `requires` is permanent scenery
 * and is present before every beat by construction — warning about those would fire on
 * every NPC in every scenario and teach the author to ignore the validator. A `requires`
 * is a deliberate statement about when somebody should be on stage, and being on stage
 * earlier than the beat they carry is almost always an oversight in it.
 *
 * Satisfied two ways, because both are real fixes: gate them on the beat's own
 * condition so they simply are not there yet, or give their tree an opening that knows
 * the beat has not happened and says so — which is the better answer when the scene of
 * arriving early is worth writing.
 */
function checkEarlyCast(artifact: ScenarioArtifact): Finding[] {
	const findings: Finding[] = [];
	const arc = artifact.arc;
	if (!arc) return findings;

	for (const beat of arc.beats) {
		const spec = artifact.sites[String(beat.siteId)];
		const npc = spec?.npcs.find((person) => person.slot === beat.npcSlot);
		if (!spec || !npc?.requires) continue;

		const onStage = flagsRead(asCondition(npc.requires));
		const needed = [...flagsRead(asCondition(beat.requires))].filter((flag) => !onStage.has(flag));
		if (needed.length === 0) continue;

		// An opening written for the wait. Any node conditioned on one of the flags the
		// beat is waiting for can tell the difference between "not yet" and "now", which
		// is the whole of what the player needs.
		const tree = artifact.trees?.[beatNpcId(beat)];
		const knows = Object.values(tree?.nodes ?? {}).some((node) =>
			[node.requires, ...node.choices.map((choice) => choice.requires)].some((condition) =>
				[...flagsRead(asCondition(condition))].some((flag) => needed.includes(flag)),
			),
		);
		if (knows) continue;

		findings.push(
			warning(
				`${spec.name}: ${npc.name} is on stage before beat ${beat.id} can open — it waits on ${needed
					.map((flag) => `"${flag}"`)
					.join(
						" and ",
					)}, which nothing about their presence requires. A player who reaches them early gets the scene with nothing behind it; gate them on the same condition, or give their tree an opening that says the time has not come`,
				beatNpcId(beat),
			),
		);
	}
	return findings;
}

/**
 * A hand-over that erases the reason it happened.
 *
 * Write the obvious thing — an opening offered when the player is carrying the thing
 * they were sent for, which takes it and thanks them — and it works exactly once. The
 * item is gone, so next time the condition is false, and the conversation falls back to
 * the greeting it was written to replace: the ferryman asks for the mooring iron again,
 * a minute after taking it out of your hands.
 *
 * Nothing else notices. Both nodes are reachable, the item is obtainable, the errand
 * completes, the flags are all sound. It is only wrong from the player's side, and it
 * makes the character look like they have forgotten a scene the player just played.
 *
 * Openings only, because that is where the damage is: a node reached mid-conversation
 * is entered once by construction. An opening is re-chosen at every hello.
 *
 * Satisfied by the fix: set a flag when the hand-over happens and give the revisit an
 * opening that reads it. The character then remembers, which is all the player wanted.
 */
function checkHandovers(artifact: ScenarioArtifact): Finding[] {
	const findings: Finding[] = [];

	for (const [key, tree] of Object.entries(artifact.trees ?? {})) {
		const openings = new Set([...tree.entry, ...(tree.revisit ?? [])]);
		// Flags any node in this tree is conditioned on, which is what a remembered
		// hand-over would be recorded as.
		const remembered = new Set(
			Object.values(tree.nodes).flatMap((node) =>
				[node.requires, ...node.choices.map((choice) => choice.requires)].flatMap((condition) => [
					...flagsRead(asCondition(condition)),
				]),
			),
		);

		for (const id of openings) {
			const node = tree.nodes[id];
			if (!node?.requires) continue;
			const wanted = itemsRead(asCondition(node.requires));
			if (wanted.size === 0) continue;

			const taken = (node.actions ?? []).filter(
				(action) => action.kind === "takeItem" && action.item && wanted.has(action.item),
			);
			if (taken.length === 0) continue;

			// Already fixed: this node records the hand-over and something reads it.
			const records = (node.actions ?? []).some(
				(action) => action.kind === "setFlag" && action.key && remembered.has(action.key),
			);
			if (records) continue;

			findings.push(
				warning(
					`tree ${key} opens on "${id}" while the player carries ${taken
						.map((action) => `"${action.item}"`)
						.join(
							" and ",
						)}, and then takes it — so the scene plays once and every later hello falls back to asking for it again. Set a flag here and give the revisit an opening that reads it`,
					key,
				),
			);
		}
	}
	return findings;
}

function checkSpawn(artifact: ScenarioArtifact, grid: PassabilityGrid): Finding[] {
	const findings: Finding[] = [];
	if (!isPassable(grid, artifact.spawn.x, artifact.spawn.y))
		findings.push(error("the spawn is not standable"));
	if (!isWellInside(artifact.bounds, artifact.spawn.x, artifact.spawn.y))
		findings.push(error("the spawn is inside the boundary band"));
	return findings;
}

/**
 * Run the generator over every authored place and compare it to what was written.
 *
 * The roster is advisory: the engine decides how many plots there are and where
 * their doors face, so a spec asking for more than fits silently loses the tail.
 * Here that becomes a number somebody can read.
 *
 * This used to run only over *settlements* — `hamlet`, `village`, `town`, `fort` —
 * which quietly exempted the three kinds a recipe exists to place. A castle whose ward
 * could not hold its chapel, with a named character assigned to that chapel, passed
 * validation in silence; the only way to find out was to generate the patch by hand.
 * So it asks the registry instead, and every place kind is measured the same way.
 */
function checkPlaces(artifact: ScenarioArtifact, sites: Map<number, MacroSite>): Finding[] {
	const findings: Finding[] = [];

	for (const spec of Object.values(artifact.sites)) {
		const site = sites.get(spec.siteId);
		if (!site) {
			findings.push(error(`site ${spec.siteId} is not a site of seed ${artifact.seed}`));
			continue;
		}
		if (!isWellInside(artifact.bounds, site.site.x, site.site.y))
			findings.push(error(`${spec.name} is inside the boundary band`));

		// `generateFeature` memoises by `(world, kind, siteId)`, which is right for a
		// running game — one place, generated once — but wrong here: validating a
		// re-authored roster for the same site would measure the *previous* layout and
		// report the old town's anchors. Dropping the entry first makes each check
		// describe the spec it was actually handed.
		invalidateFeature(artifactWorld(artifact), site.id);
		const built = generateFeature(artifactWorld(artifact), site, spec.settlement);
		if (!built) continue;
		const names = new Set(
			built.buildings.map((building) => building.name).filter((name): name is string => !!name),
		);
		const anchors = new Set(built.anchors.map((anchor) => anchor.kind));

		// A place that built nothing at all is its own, much louder finding: the three
		// recipe-placed kinds decline rather than compromise, so an empty patch is a
		// castle that found no level ground, a dock with no shoreline or a cave with no
		// hillside — and every person and errand hung off it is hanging off nothing.
		if (built.buildings.length === 0 && built.anchors.length === 0) {
			findings.push(
				error(
					`${spec.name} is a ${site.kind} that built nothing; the ground at ${site.site.x},${site.site.y} does not suit one, so move it or change its kind`,
				),
			);
			continue;
		}

		// Beyond here the findings are about *choices*, and only an authored roster has
		// any. A place nobody wrote is filled from the deterministic roster, and telling
		// its author that a camp asked for two shacks and fitted one is noise they can do
		// nothing with — it drowns the four sites the story actually turns on.
		//
		// "Somebody named a building here" is the test, because `fallbackSettlementSpec`
		// never names one and an author almost always does. It is a heuristic, and the
		// cost of it being wrong is a missing warning about a place whose buildings are
		// all anonymous — which is a place nothing in the story can refer to anyway.
		if (!spec.settlement.structures.some((structure) => structure.name)) continue;

		if (built.buildings.length < spec.settlement.structures.length)
			findings.push(
				warning(
					`${spec.name}: asked for ${spec.settlement.structures.length} structures, ${built.buildings.length} fitted`,
				),
			);

		for (const npc of spec.npcs) {
			// Somebody in a room is a different question: they need a building that was
			// built, and floor inside it to stand on. Both can fail silently — an unbuilt
			// bower leaves the person nowhere at all rather than somewhere else — so this
			// one is an error where the outdoor case is a warning.
			if (npc.indoors) {
				const room = npc.structureName
					? built.buildings.find(
							(building) => building.name?.toLowerCase() === npc.structureName?.toLowerCase(),
						)
					: built.buildings[0];
				if (!room) {
					findings.push(
						error(
							`${spec.name}: ${npc.name} stands inside "${npc.structureName ?? "a building"}", which was not built; they are nowhere`,
						),
					);
				} else if (
					standingRoom(getInterior(artifact.seed, room.interiorId, room.kind)).length === 0
				) {
					findings.push(
						error(`${spec.name}: the ${room.kind} ${npc.name} stands in has no floor to stand on`),
					);
				}
				continue;
			}
			// Placement is advisory and the engine says so: `pickAnchor` treats `yard` as
			// a `doorstep`, and anything it cannot match falls through to any free
			// outdoor anchor. So an unbuilt anchor is a placement that will not be
			// honoured, not a person standing nowhere — a warning, and never a reason to
			// refuse a scenario that plays perfectly well.
			if (!anchors.has(anchorAliasFor(npc.placement)))
				findings.push(
					warning(
						`${spec.name}: ${npc.name} asked for a "${npc.placement}", which this town does not build; they will stand at another anchor`,
					),
				);
			if (npc.structureName && !names.has(npc.structureName))
				findings.push(
					warning(
						`${spec.name}: ${npc.name} belongs to "${npc.structureName}", which was not built`,
					),
				);
		}
	}
	return findings;
}

function checkStory(
	artifact: ScenarioArtifact,
	grid: PassabilityGrid,
	sites: Map<number, MacroSite>,
	terrainAt: (x: number, y: number) => TerrainId | undefined,
): Finding[] {
	const arc = artifact.arc;
	if (!arc) return [];
	const findings: Finding[] = [];

	// Every errand the story hands out, so a sub-errand objective can be checked against
	// the real set rather than against prose.
	const questIds = new Set(
		arc.beats.map((beat) => beat.quest?.id).filter((id): id is string => id !== undefined),
	);

	for (const beat of orderedBeats(arc)) {
		const spec = artifact.sites[String(beat.siteId)];
		const anchor = beatNpcId(beat);
		const present = spec?.npcs.some((npc) => npcId(spec.siteId, npc.slot) === anchor);
		if (!present) {
			findings.push(error(`beat ${beat.id} has no anchor to open it`));
			continue;
		}
		// Resolved through the same function the dialogue boundary uses, so a target
		// this accepts is one `verifyQuests` will actually match at runtime.
		const surroundings = surroundingsFor(artifact, beat.siteId, sites, terrainAt);
		for (const objective of beat.quest?.objectives ?? []) {
			// A `quest` objective names another errand rather than something in the world,
			// so `surroundings` has nothing to say about it — asking would report every
			// sub-errand as unresolvable. Its own check is stricter than the others,
			// because a quest id is a slug rather than prose: it must name a quest some
			// beat actually creates, matched exactly, the way `verifyQuests` matches it.
			if (objective.kind === "quest") {
				if (!questIds.has(objective.target)) {
					findings.push(
						error(`beat ${beat.id} waits on errand "${objective.target}", which no beat hands out`),
					);
				} else if (objective.target === beat.quest?.id) {
					findings.push(error(`beat ${beat.id}'s errand waits on itself`));
				}
				continue;
			}
			const resolved = resolveObjectiveTarget(objective.kind, objective.target, surroundings);
			if (resolved === undefined) {
				findings.push(
					warning(
						`beat ${beat.id}: nothing here answers to "${objective.target}" as a ${objective.kind} target`,
					),
				);
				continue;
			}
			// The world spells it differently, so the objective as written would never
			// match. Assembly canonicalises this, so seeing it here means the draft was
			// edited after assembly or written by hand.
			if (resolved !== objective.target)
				findings.push(
					warning(
						`beat ${beat.id}: "${objective.target}" is spelled "${resolved}" here; the objective will not match until it agrees`,
					),
				);
		}
	}

	const walk = storyWalk(artifact, grid, sites);
	if (walk.unreachable) {
		findings.push(error(`beat ${walk.unreachable} cannot be walked to inside the boundary`));
	} else {
		// Judged on the *legs*, not against a budget derived from the duration. Duration
		// sets two things at once — how long the story is and how big the world is — so
		// an author writing a tight tale in a roomy map was warned every single time and
		// could do nothing about it. What is actually worth saying is the two shapes that
		// play badly: one march so long the player stops believing in it, and a story
		// that never leaves the room it started in.
		const longest = walk.legs.reduce((worst, leg) => (leg.tiles > worst.tiles ? leg : worst), {
			to: "",
			tiles: 0,
		});
		if (longest.tiles > LONG_MARCH)
			findings.push(
				warning(
					`${longest.tiles} tiles of walking in one stretch, to ${longest.to}; that is a long way with nothing happening`,
				),
			);
		else if (walk.tiles < SHORT_STORY && walk.legs.length > 0)
			findings.push(
				warning(
					`the whole story is ${walk.tiles} tiles of walking across ${walk.legs.length} journey(s); it may read as one scene rather than as a road`,
				),
			);
	}

	const visited = new Set(arc.beats.map((beat) => beat.siteId));
	const ignored = Object.values(artifact.sites).filter(
		(spec) => !visited.has(spec.siteId) && spec.settlement.structures.length > 2,
	);
	if (ignored.length > 0)
		findings.push(
			warning(
				`the story never visits ${ignored.length} settlement(s): ${ignored
					.slice(0, 4)
					.map((spec) => spec.name)
					.join(", ")}`,
			),
		);

	return findings;
}

/**
 * The beat anchors nobody wrote a conversation for.
 *
 * Exported and shared rather than asked twice. `checkTrees` turns these into warnings an
 * author reads; `checkScenesWritten` turns them into a counted invariant violation. The
 * rule `wayfinding.ts` was split out for, and for the same reason: two passes asking the
 * identical question must not be able to answer it differently.
 */
export function beatsWithoutTrees(
	artifact: ScenarioArtifact,
): { readonly beat: ScenarioBeat; readonly npcId: string }[] {
	const trees = artifact.trees ?? {};
	return (artifact.arc?.beats ?? [])
		.map((beat) => ({ beat, npcId: beatNpcId(beat) }))
		.filter(({ npcId: id }) => !trees[id]);
}

function checkTrees(artifact: ScenarioArtifact): Finding[] {
	const findings: Finding[] = [];
	const people = Object.values(artifact.sites).flatMap((spec) =>
		spec.npcs.map((npc) => npcId(spec.siteId, npc.slot)),
	);
	const trees = artifact.trees ?? {};

	for (const [key, tree] of Object.entries(trees)) {
		if (Object.keys(tree.nodes).length < 2)
			findings.push(warning(`tree ${key} is a single line, not a conversation`, key));

		/*
		 * A line that hands something over must not be reachable twice.
		 *
		 * Actions fire every time their node is entered, and a conversation can be had as
		 * often as the player likes — so a gift on an ungated node behind an ungated
		 * choice is a gift the player can collect all afternoon. The shipped scenario did
		 * exactly this: Arthur handed out a second shield on the second visit.
		 *
		 * The fix an author reaches for is a condition, on the node or on the choice that
		 * leads to it — `{ not: { item: "..." } }` is the usual one, since "not already
		 * carrying it" is not a flag anybody sets.
		 */
		for (const node of Object.values(tree.nodes)) {
			const gives = (node.actions ?? []).some(
				(action) => action.kind === "giveItem" || action.kind === "adjustGold",
			);
			if (!gives || node.requires !== undefined) continue;
			const ways = Object.values(tree.nodes).flatMap((other) =>
				other.choices.filter((choice) => choice.goto === node.id),
			);
			if (ways.length > 0 && ways.every((choice) => choice.requires !== undefined)) continue;
			findings.push(
				warning(
					`tree ${key} node ${node.id} hands something over and nothing stops it happening twice; gate the node or the choice that leads to it, e.g. { "not": { "item": "..." } }`,
					key,
				),
			);
		}
	}

	/*
	 * The people the story hangs on, who are a different case entirely.
	 *
	 * Anyone else with no tree falls back to a deterministic conversation built from
	 * what they know, and that is a real conversation — a warning at most. A *beat*
	 * anchor with no tree is a hole in the story: walking into them opens the beat, so
	 * the errand lands in the journal and the card goes up, and the scene that was
	 * supposed to be the reason for all of it is a menu of "ask about their work".
	 *
	 * This is what a run whose dialogue pass failed outright looks like, and it used to
	 * report *nothing at all*: the count below was suppressed when there were no trees,
	 * which is precisely the case where every one of them is missing. The screen said
	 * "wrote 0 conversations" in passing and the world was pronounced fine.
	 *
	 * A warning rather than an error, because the canned menu really does carry a beat
	 * and a hand-written scenario is allowed to lean on it — `thornwick-road` ships five
	 * anchors this way on purpose. What is not allowed is for it to happen *silently*,
	 * which is the whole of what this fixes.
	 */
	for (const { beat, npcId: id } of beatsWithoutTrees(artifact)) {
		const spec = artifact.sites[String(beat.siteId)];
		const npc = spec?.npcs.find((person) => person.slot === beat.npcSlot);
		findings.push(
			warning(
				`beat ${beat.id} opens at ${npc?.name ?? id}${
					spec ? ` in ${spec.name}` : ""
				}, who has no written conversation — the errand lands in the journal with only the deterministic menu to account for it`,
				id,
			),
		);
	}

	const without = people.filter((id) => !trees[id]);
	if (without.length > 0 && Object.keys(trees).length > 0)
		findings.push(
			warning(
				`${without.length} of ${people.length} people have no written dialogue and will fall back to the deterministic tree`,
			),
		);
	return findings;
}

/**
 * What a conversation at this site can truthfully promise.
 *
 * Assembled exactly as `GameEngine.surroundingsFor` assembles it, so the validator
 * and the running game resolve an objective name identically. Before this, the
 * validator matched places by substring and guessed at obtainability from a
 * regular expression over roles — so a `reach: "mill"` objective passed authoring
 * against a town called "Millgate Barracks" and could never be completed, because
 * `verifyQuests` matches by significant words and would never agree.
 *
 * More generous than the live engine in one respect, deliberately: the whole bounded
 * world is generated here, so ground the player has not walked to yet still counts.
 * An authored errand is judged against the world as a whole, which is the right
 * scope for content that ships complete.
 */
export function surroundingsFor(
	artifact: ScenarioArtifact,
	siteId: number,
	sites: Map<number, MacroSite>,
	terrainAt: (x: number, y: number) => TerrainId | undefined,
): Surroundings {
	const site = sites.get(siteId);
	const spec = artifact.sites[String(siteId)];
	if (!site || !spec) return EMPTY_SURROUNDINGS;

	// Through the registry, not `generateSettlement`: a castle asked for its settlement
	// layout would answer with a town that is not there, and every building name in it
	// would be a name the player can never walk into.
	invalidateFeature(artifactWorld(artifact), site.id);
	const built = generateFeature(artifactWorld(artifact), site, spec.settlement);
	if (!built) return EMPTY_SURROUNDINGS;

	// Every other authored place, so a `reach` objective may point out of town. The
	// engine looks two macro cells out; here the bound is the world, since a scenario
	// is finite and every place in it is somewhere the player can be sent.
	const places = Object.values(artifact.sites)
		.filter((other) => other.siteId !== siteId)
		.map((other) => other.name);

	return {
		place: spec.name,
		buildings: built.buildings.map((building) => ({
			name: building.name ?? building.kind,
			kind: building.kind,
		})),
		people: spec.npcs.map((npc) => ({ name: npc.name, role: npc.role })),
		places,
		items: [
			...obtainableItems({
				seed: artifact.seed,
				siteId,
				goods: goodsFor(artifact),
				people: spec.npcs.map((npc) => ({ role: npc.role, slot: npc.slot })),
				buildings: built.buildings.map((building) => ({
					interiorId: building.interiorId,
					kind: building.kind,
				})),
				ground: { centre: site.site, radius: site.radius, terrainAt },
				// Everything the scenario put somewhere by hand. Not scoped to this site,
				// for the same reason the gifts below are not: a placement is a definite
				// thing in a definite place, and being sent across a finite world for one
				// is exactly what an authored errand is for.
				placed: (artifact.placements ?? []).map((placement) => placement.item.name),
			}),
			// Anything written dialogue hands over, anywhere in the scenario. A fetch
			// quest is satisfiable if *some* authored conversation gives the item, even
			// when that conversation happens in another town.
			...authoredGifts(artifact),
		],
	};
}

/** Item names some authored conversation gives or sells. */
function authoredGifts(artifact: ScenarioArtifact): string[] {
	const names: string[] = [];
	for (const tree of Object.values(artifact.trees ?? {})) {
		for (const node of Object.values(tree.nodes)) {
			for (const action of node.actions ?? []) {
				if ((action.kind === "giveItem" || action.kind === "sell") && action.item) {
					names.push(action.item);
				}
			}
		}
	}
	return names;
}
