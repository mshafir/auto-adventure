import { generateSettlement, invalidateSettlement } from "../core/gen/features/settlement.js";
import { generateChunk } from "../core/gen/pipeline.js";
import { findPath } from "../core/geom/astar.js";
import { beatNpcId, orderedBeats } from "../core/rules/arc.js";
import { TFlag } from "../core/tiles/flags.js";
import { isWellInside } from "../core/world/bounds.js";
import { CHUNK, localIndex, toChunk } from "../core/world/coords.js";
import { isSettlement, MACRO, type MacroSite, macroSite } from "../core/world/macro.js";
import { npcId } from "../core/world/spec.js";
import type { ScenarioArtifact } from "./artifact.js";
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
			const site = macroSite(artifact.seed, mx, my);
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

	for (let cy = min.cy; cy <= max.cy; cy++) {
		for (let cx = min.cx; cx <= max.cx; cx++) {
			const { chunk } = generateChunk(
				{
					seed: artifact.seed,
					bounds: artifact.bounds,
					specFor: (site) => artifact.sites[String(site.id)]?.settlement,
				},
				{ cx, cy },
			);
			for (let ly = 0; ly < CHUNK; ly++) {
				for (let lx = 0; lx < CHUNK; lx++) {
					const flags = chunk.flags[localIndex(lx, ly)] ?? 0;
					passable[(cy * CHUNK + ly - y) * w + (cx * CHUNK + lx - x)] =
						flags & TFlag.Passable ? 1 : 0;
				}
			}
		}
	}
	return { x, y, w, h, passable };
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
	const sites = siteIndex(artifact);

	// Settlements first: it drops the patch cache per site, and the passability grid
	// stamps those same patches, so building the grid first would measure a layout
	// that is about to be invalidated.
	findings.push(...checkSettlements(artifact, sites));
	const grid = buildPassability(artifact);
	findings.push(...checkSpawn(artifact, grid));
	findings.push(...checkStory(artifact, grid, sites));
	findings.push(...checkTrees(artifact));
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
		invalidateSettlement(artifact.seed, site.id);
		const built = generateSettlement(artifact.seed, site, spec.settlement);
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
			if (!anchors.has(npc.placement))
				findings.push(
					error(`${spec.name}: ${npc.name} stands at a "${npc.placement}" that was not built`),
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
): Finding[] {
	const arc = artifact.arc;
	if (!arc) return [];
	const findings: Finding[] = [];

	for (const beat of orderedBeats(arc)) {
		const spec = artifact.sites[String(beat.siteId)];
		const anchor = beatNpcId(beat);
		const present = spec?.npcs.some((npc) => npcId(spec.siteId, npc.slot) === anchor);
		if (!present) {
			findings.push(error(`beat ${beat.id} has no anchor to open it`));
			continue;
		}
		for (const objective of beat.quest?.objectives ?? []) {
			if (objective.kind === "reach" && !namedPlace(artifact, objective.target))
				findings.push(warning(`beat ${beat.id}: nowhere here is called "${objective.target}"`));
			if (objective.kind === "have" && !obtainable(artifact, objective.target))
				findings.push(warning(`beat ${beat.id}: nothing here gives "${objective.target}"`));
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

/** Whether any authored place answers to this name, the way `placeNameAt` does. */
function namedPlace(artifact: ScenarioArtifact, target: string): boolean {
	const wanted = target.trim().toLowerCase();
	if (!wanted) return false;
	return Object.values(artifact.sites).some((spec) => {
		const name = spec.name.toLowerCase();
		return (
			name.includes(wanted) || wanted.includes(name) || spec.shortName.toLowerCase() === wanted
		);
	});
}

/**
 * Whether anything in the world hands this item over.
 *
 * Written dialogue is checked exactly. Shops are treated as a possible source
 * without enumerating them, because stock is derived from role and slot at runtime
 * and reproducing that here would trade a rare false negative for a warning on
 * almost every fetch quest.
 */
function obtainable(artifact: ScenarioArtifact, target: string): boolean {
	const wanted = target.trim().toLowerCase();
	if (!wanted) return false;
	const given = Object.values(artifact.trees ?? {}).some((tree) =>
		Object.values(tree.nodes).some((node) =>
			(node.actions ?? []).some(
				(action) =>
					(action.kind === "giveItem" || action.kind === "sell") &&
					(action.item ?? "").trim().toLowerCase() === wanted,
			),
		),
	);
	if (given) return true;
	return Object.values(artifact.sites).some((spec) =>
		spec.npcs.some((npc) => /merchant|trader|shop|smith|apothecary|innkeep/i.test(npc.role)),
	);
}
