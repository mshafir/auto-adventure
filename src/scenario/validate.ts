import type { AnchorKind } from "../core/gen/features/patch.js";
import { invalidateFeature } from "../core/gen/features/registry.js";
import { generateSettlement } from "../core/gen/features/settlement.js";
import { generateChunk } from "../core/gen/pipeline.js";
import { findPath } from "../core/geom/astar.js";
import { beatNpcId, orderedBeats, type ScenarioBeat } from "../core/rules/arc.js";
import type { CardSection } from "../core/rules/card.js";
import { asCondition, itemsRead, npcsRead } from "../core/rules/condition.js";
import type { Barrier } from "../core/rules/lock.js";
import { obtainableItems } from "../core/rules/obtainable.js";
import { placementSlot } from "../core/rules/placement.js";
import {
	EMPTY_SURROUNDINGS,
	resolveObjectiveTarget,
	type Surroundings,
} from "../core/rules/surroundings.js";
import { TFlag } from "../core/tiles/flags.js";
import type { TerrainId } from "../core/tiles/terrain.js";
import { isWellInside } from "../core/world/bounds.js";
import { CHUNK, HALO, localIndex, toChunk } from "../core/world/coords.js";
import {
	isSettlement,
	MACRO,
	type MacroSite,
	macroSite,
	maxFeatureRadius,
} from "../core/world/macro.js";
import { type PlaceRecipe, placeKey, type WorldRules } from "../core/world/recipe.js";
import { npcId } from "../core/world/spec.js";
import { resolvePlacements } from "../engine/placements.js";
import { artifactWorld, type ScenarioArtifact } from "./artifact.js";
import { flagsWritten, unsatisfiableFlags } from "./flag-sources.js";
import { planFor } from "./survey.js";

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
}

const error = (message: string): Finding => ({ severity: "error", message });
const warning = (message: string): Finding => ({ severity: "warning", message });

export function hasErrors(findings: readonly Finding[]): boolean {
	return findings.some((finding) => finding.severity === "error");
}

/**
 * Tiles of walking each beat is worth, for the duration estimate.
 *
 * A guess about the player rather than a fact about the world, which is why the
 * check that uses it produces a warning with the real number in it rather than an
 * error. Treat the estimate as an ordering, not a promise.
 */
const TILES_PER_BEAT = 500;

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
function siteIndex(artifact: ScenarioArtifact): Map<number, MacroSite> {
	const { bounds } = artifact;
	const found = new Map<number, MacroSite>();
	const minMx = Math.floor(bounds.minX / MACRO) - 1;
	const maxMx = Math.floor(bounds.maxX / MACRO) + 1;
	const minMy = Math.floor(bounds.minY / MACRO) - 1;
	const maxMy = Math.floor(bounds.maxY / MACRO) + 1;
	for (let my = minMy; my <= maxMy; my++) {
		for (let mx = minMx; mx <= maxMx; mx++) {
			const site = macroSite(artifactWorld(artifact), mx, my);
			if (site.kind !== "none") found.set(site.id, site);
		}
	}
	return found;
}

/**
 * A passability grid for the bounded world.
 *
 * Built once and shared by every path check. At the longest duration this is a
 * 1216-square grid, so rebuilding it per query would dominate the whole pipeline.
 * Generated *with* the authored settlement rosters, so the streets it contains are
 * the streets the player will walk.
 */
export interface PassabilityGrid {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
	readonly passable: Uint8Array;
	/**
	 * Terrain ids, for the forage sources.
	 *
	 * Recorded in the same sweep as passability, because generating the world twice
	 * to answer two questions about it would double the slowest thing here.
	 */
	readonly terrain: Uint8Array;
}

export function buildPassability(artifact: ScenarioArtifact): PassabilityGrid {
	const { bounds } = artifact;
	const min = toChunk(bounds.minX, bounds.minY);
	const max = toChunk(bounds.maxX, bounds.maxY);
	const x = min.cx * CHUNK;
	const y = min.cy * CHUNK;
	const w = (max.cx - min.cx + 1) * CHUNK;
	const h = (max.cy - min.cy + 1) * CHUNK;
	const passable = new Uint8Array(w * h);
	const terrain = new Uint8Array(w * h);

	for (let cy = min.cy; cy <= max.cy; cy++) {
		for (let cx = min.cx; cx <= max.cx; cx++) {
			const { chunk } = generateChunk(
				{
					world: artifactWorld(artifact),
					bounds: artifact.bounds,
					specFor: (site) => artifact.sites[String(site.id)]?.settlement,
				},
				{ cx, cy },
			);
			for (let ly = 0; ly < CHUNK; ly++) {
				for (let lx = 0; lx < CHUNK; lx++) {
					const index = localIndex(lx, ly);
					const flags = chunk.flags[index] ?? 0;
					const at = (cy * CHUNK + ly - y) * w + (cx * CHUNK + lx - x);
					passable[at] = flags & TFlag.Passable ? 1 : 0;
					terrain[at] = chunk.terrain[index] ?? 0;
				}
			}
		}
	}
	return { x, y, w, h, passable, terrain };
}

/** Terrain at a position, or undefined outside the generated block. */
function terrainOf(grid: PassabilityGrid, x: number, y: number): TerrainId | undefined {
	const gx = x - grid.x;
	const gy = y - grid.y;
	if (gx < 0 || gy < 0 || gx >= grid.w || gy >= grid.h) return undefined;
	return grid.terrain[gy * grid.w + gx];
}

function isPassable(grid: PassabilityGrid, x: number, y: number): boolean {
	const gx = x - grid.x;
	const gy = y - grid.y;
	if (gx < 0 || gy < 0 || gx >= grid.w || gy >= grid.h) return false;
	return grid.passable[gy * grid.w + gx] === 1;
}

/** The nearest walkable tile to a point. A town centre may be a building. */
function nearestPassable(
	grid: PassabilityGrid,
	at: { readonly x: number; readonly y: number },
	limit = 24,
): { readonly x: number; readonly y: number } | undefined {
	if (isPassable(grid, at.x, at.y)) return at;
	for (let radius = 1; radius <= limit; radius++) {
		for (let dy = -radius; dy <= radius; dy++) {
			for (let dx = -radius; dx <= radius; dx++) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
				if (isPassable(grid, at.x + dx, at.y + dy)) return { x: at.x + dx, y: at.y + dy };
			}
		}
	}
	return undefined;
}

function pathLength(
	grid: PassabilityGrid,
	from: { readonly x: number; readonly y: number },
	to: { readonly x: number; readonly y: number },
): number | undefined {
	const start = nearestPassable(grid, from);
	const goal = nearestPassable(grid, to);
	if (!start || !goal) return undefined;
	const path = findPath(start, goal, {
		bounds: { x: grid.x, y: grid.y, w: grid.w, h: grid.h },
		cost: (x, y) => (isPassable(grid, x, y) ? 1 : Number.POSITIVE_INFINITY),
		// Slightly greedy. This runs over a million cells, and the question is whether
		// a route exists and roughly how long, not what the optimal one is.
		heuristicWeight: 1.2,
	});
	return path?.length;
}

/**
 * How much walking the story asks for.
 *
 * Spawn to the first beat, then beat to beat in order. Stops at the first leg that
 * cannot be walked at all, which is the finding that matters most: a story with an
 * unreachable beat is a story that cannot be finished.
 */
export function storyWalk(
	artifact: ScenarioArtifact,
	grid: PassabilityGrid,
	sites: Map<number, MacroSite>,
): { readonly tiles: number; readonly unreachable?: string } {
	if (!artifact.arc) return { tiles: 0 };

	let tiles = 0;
	let from: { readonly x: number; readonly y: number } = artifact.spawn;
	for (const beat of orderedBeats(artifact.arc)) {
		const to = sites.get(beat.siteId)?.site;
		if (!to) return { tiles, unreachable: beat.id };
		const length = pathLength(grid, from, to);
		if (length === undefined) return { tiles, unreachable: beat.id };
		tiles += length;
		from = to;
	}
	return { tiles };
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
	findings.push(...checkSettlements(artifact, sites));
	const grid = buildPassability(artifact);
	const terrainAt = (x: number, y: number) => terrainOf(grid, x, y);
	findings.push(...checkSpawn(artifact, grid));
	findings.push(...checkStory(artifact, grid, sites, terrainAt));
	findings.push(...checkTrees(artifact));
	findings.push(...checkGates(artifact, grid));
	findings.push(...checkPlacements(artifact, grid));
	findings.push(...checkConditions(artifact));
	findings.push(...checkFindability(artifact));
	findings.push(...checkBranches(artifact));
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
	}
	if (artifact.arc?.ending) card(artifact.arc.ending);
	for (const ending of artifact.arc?.endings ?? []) card(ending);
	for (const trigger of artifact.triggers ?? []) {
		for (const effect of trigger.effects) {
			if (effect.t === "RecordJournal") parts.push(effect.entry.text);
			if (effect.t === "ShowCard") card(effect.card);
			if (effect.t === "AdvanceQuest") parts.push(effect.note);
			if (effect.t === "CreateQuest") parts.push(effect.name, effect.description);
		}
	}
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
function checkGates(artifact: ScenarioArtifact, grid: PassabilityGrid): Finding[] {
	const findings: Finding[] = [];
	const barriers = artifact.barriers ?? [];
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
function checkPlacements(artifact: ScenarioArtifact, grid: PassabilityGrid): Finding[] {
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
		const slot = placementSlot(entry.interiorId, entry.x, entry.y);
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
		} else if (!isPassable(grid, entry.x, entry.y)) {
			findings.push(
				error(`placement ${entry.id} is on a tile the player cannot stand next to and search`),
			);
		}
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

		for (const taken of arms) {
			// What is written once this arm is chosen: everything except the flags only the
			// arms *not* taken would have set.
			const barred = new Set(arms.filter((arm) => arm.id !== taken.id).map((arm) => arm.setsFlag));
			const available = flagsWritten(artifact);
			for (const flag of barred) available.delete(flag);

			for (const beat of arc.beats) {
				if (beat.optional) continue;
				if (beat.branch !== undefined && beat.id !== taken.id) continue;
				for (const flag of unsatisfiableFlags(beat.requires, available)) {
					findings.push(
						error(
							`if "${taken.id}" is chosen, beat ${beat.id} waits on "${flag}", which only the other arm of "${group}" sets`,
						),
					);
				}
			}
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
 * Run the settlement generator and compare it to what was authored.
 *
 * The roster is advisory: the engine decides how many plots there are and where
 * their doors face, so a spec asking for more than fits silently loses the tail.
 * Here that becomes a number somebody can read.
 */
function checkSettlements(artifact: ScenarioArtifact, sites: Map<number, MacroSite>): Finding[] {
	const findings: Finding[] = [];

	for (const spec of Object.values(artifact.sites)) {
		const site = sites.get(spec.siteId);
		if (!site) {
			findings.push(error(`site ${spec.siteId} is not a site of seed ${artifact.seed}`));
			continue;
		}
		if (!isWellInside(artifact.bounds, site.site.x, site.site.y))
			findings.push(error(`${spec.name} is inside the boundary band`));
		if (!isSettlement(site.kind)) continue;

		// `generateSettlement` memoises by `(seed, siteId)`, which is right for a
		// running game — one town, generated once — but wrong here: validating a
		// re-authored roster for the same site would measure the *previous* layout and
		// report the old town's anchors. Dropping the entry first makes each check
		// describe the spec it was actually handed.
		invalidateFeature(artifactWorld(artifact), site.id);
		const built = generateSettlement(artifactWorld(artifact), site, spec.settlement);
		const names = new Set(
			built.buildings.map((building) => building.name).filter((name): name is string => !!name),
		);
		const anchors = new Set(built.anchors.map((anchor) => anchor.kind));

		if (built.buildings.length < spec.settlement.structures.length)
			findings.push(
				warning(
					`${spec.name}: asked for ${spec.settlement.structures.length} structures, ${built.buildings.length} fitted`,
				),
			);

		for (const npc of spec.npcs) {
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
		const expected = planFor(artifact.brief.duration).beats * TILES_PER_BEAT;
		const ratio = walk.tiles / expected;
		if (ratio < 0.6 || ratio > 1.4)
			findings.push(
				warning(
					`the story is ${walk.tiles} tiles of walking; ${artifact.brief.duration ?? "medium"} expects about ${expected}`,
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

function checkTrees(artifact: ScenarioArtifact): Finding[] {
	const findings: Finding[] = [];
	const people = Object.values(artifact.sites).flatMap((spec) =>
		spec.npcs.map((npc) => npcId(spec.siteId, npc.slot)),
	);
	const trees = artifact.trees ?? {};

	for (const [key, tree] of Object.entries(trees)) {
		if (Object.keys(tree.nodes).length < 2)
			findings.push(warning(`tree ${key} is a single line, not a conversation`));
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
function surroundingsFor(
	artifact: ScenarioArtifact,
	siteId: number,
	sites: Map<number, MacroSite>,
	terrainAt: (x: number, y: number) => TerrainId | undefined,
): Surroundings {
	const site = sites.get(siteId);
	const spec = artifact.sites[String(siteId)];
	if (!site || !spec) return EMPTY_SURROUNDINGS;

	invalidateFeature(artifactWorld(artifact), site.id);
	const built = generateSettlement(artifactWorld(artifact), site, spec.settlement);

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
