import { orderedBeats } from "../core/rules/arc.js";
import { MAX_SIGN_ARMS, type Sign, type SignArm } from "../core/rules/signage.js";
import { hasFlag, TFlag } from "../core/tiles/flags.js";
import { terrainDef } from "../core/tiles/terrain.js";
import { isWellInside } from "../core/world/bounds.js";
import type { MacroSite } from "../core/world/macro.js";
import { roadBetween, roadTiles } from "../core/world/roads.js";
import { artifactWorld, type ScenarioArtifact } from "./artifact.js";
import { isPassable, type PassabilityGrid, terrainOf } from "./passability.js";

/**
 * Put up signposts along the road the story walks.
 *
 * Derived, not written. A model asked for a signpost would give it a direction, and a
 * direction is the one thing here that can be *wrong* — the model has no coordinates and
 * no compass, and a board that says east about somewhere west is worse than no board,
 * because the player believes it and walks for two minutes. So the arc says where the
 * player is sent and this works out where a post goes; `signBoard` computes what it says
 * from where the places really are.
 *
 * It also costs nothing. This is a sweep over an already-generated world, so a world can
 * be given its directions without a single extra model call — which matters because the
 * complaint it answers ("I could not tell where to go next") turned out to be structural
 * rather than a failure of any one pass.
 *
 * What it deliberately does *not* do is mark the map. An open errand already gets a
 * bearing, and only once its site is in `discovered` — see `questMarks` — so the case with
 * no marker at all is precisely the case that needs one: somewhere the player has never
 * been. A board at the edge of town is the answer to that, and it is the answer *at the
 * moment the choice is made*, which no amount of map furniture is.
 *
 * This module only derives the plan; it does not touch the running game itself. The
 * author calls `signpostsFor` after the world is drafted and before it is checked (so the
 * validator judges the world the player will actually walk), and the resulting `Sign[]`
 * rides in `ScenarioArtifact.signs` next to the barriers it already carries. From there
 * the wiring is the same shape as a barrier's: `session.ts` threads the signs from the
 * artifact into `GameState`, `pipeline.ts` stamps a post onto the tile a `Sign` names
 * (`stampSigns`, decor rather than terrain, so it can never wall off the ground it stands
 * on), and `GameEngine.signAt` composes the board's text on demand from the `Sign` and the
 * live positions of the sites it names — the same "derived, not written" discipline as
 * the plan above, so a scenario that moves a town does not also have to go back and edit
 * every board pointing at it. `describeFaced` in `src/ui/app.tsx` is what a player actually
 * sees: it reads a tile's decor, and asks `signAt` for the words only once that decor says
 * a post is standing there.
 */

export interface SignpostPlan {
	readonly signs: readonly Sign[];
	/**
	 * Legs the world had nowhere to stand a post for, in words.
	 *
	 * Reported rather than swallowed. A leg with no board is the story quietly going back
	 * to being hard to follow, and the run that produced it should say so — but it is not
	 * a fault in the scenario, so it is a line of progress rather than a finding.
	 */
	readonly missed: readonly string[];
}

/**
 * How far out of town a board stands, as an offset on the site's own radius.
 *
 * Far enough to be *outside* — a post in the market square is scenery among scenery —
 * and near enough that anybody leaving by the road passes it. Beyond the far end the
 * search gives up rather than planting a board in open country, where nobody would ever
 * face it.
 */
const OUT_OF_TOWN = { from: 2, to: 26 } as const;

/**
 * And how far from the spawn, which is not a town and is measured differently.
 *
 * Close, on purpose. The spawn is the one place in the world where the player has been
 * told nothing at all and has two ends of a road to choose between, so this board wants to
 * be in front of them almost immediately rather than at the edge of wherever they woke up.
 */
const OFF_THE_MAT = { from: 3, to: 14 } as const;

/** How far off a waypoint a verge is looked for before the next waypoint is tried. */
const VERGE_REACH = 2;

export function signpostsFor(
	artifact: ScenarioArtifact,
	grid: PassabilityGrid,
	sites: Map<number, MacroSite>,
): SignpostPlan {
	const arc = artifact.arc;
	if (!arc) return { signs: [], missed: [] };

	/*
	 * Where the story sends the player, in order, as legs between places.
	 *
	 * A *leg* rather than a beat, for the same reason `storyWalk` counts legs: three
	 * consecutive beats in one castle are one journey, and a board pointing at the town
	 * you are standing in is a board that has nothing to say.
	 */
	const legs: { readonly from: number | "spawn"; readonly to: number }[] = [];
	// The player usually wakes up *in* a town, because `findSpawn` prefers a chunk with one
	// in its halo. Treating the spawn as its own origin in that case put the first board
	// three tiles from the player pointing at the town they were standing in, which is the
	// one thing a board must never do — so where the spawn is inside a footprint, the town
	// is the origin and the board goes on the road out of it.
	let at: number | "spawn" = spawnSite(artifact, sites) ?? "spawn";
	for (const beat of orderedBeats(arc)) {
		if (!sites.has(beat.siteId)) continue;
		if (beat.siteId !== at) legs.push({ from: at, to: beat.siteId });
		at = beat.siteId;
	}

	// Grouped by where the player is leaving from, because one post can carry three arms
	// and a settlement two errands lead out of should have one board, not two. Insertion
	// order is story order, so the arm that gets dropped past the third is the furthest
	// off — which is the one the player has the least immediate use for.
	const byOrigin = new Map<number | "spawn", number[]>();
	for (const leg of legs) {
		const wanted = byOrigin.get(leg.from) ?? [];
		if (!wanted.includes(leg.to) && wanted.length < MAX_SIGN_ARMS) wanted.push(leg.to);
		byOrigin.set(leg.from, wanted);
	}

	const world = artifactWorld(artifact);
	const signs: Sign[] = [];
	const missed: string[] = [];
	// Two posts on one tile is one post with the wrong arms on it, so a tile is claimed
	// once. Nothing else writes decor out here, so the sign list is the whole of it.
	const taken = new Set<string>();

	for (const [origin, destinations] of byOrigin) {
		const from = origin === "spawn" ? artifact.spawn : sites.get(origin)?.site;
		if (!from) continue;
		const first = sites.get(destinations[0] as number);
		if (!first) continue;

		const spot = postBetween(
			{ artifact, grid, world, taken },
			origin === "spawn" ? undefined : sites.get(origin),
			from,
			first,
		);
		if (!spot) {
			missed.push(
				`nowhere to stand a signpost on the way out of ${placeName(artifact, origin)} toward ${
					placeName(artifact, destinations[0] as number) ?? "the next place"
				}`,
			);
			continue;
		}
		taken.add(`${spot.x},${spot.y}`);
		const arms: SignArm[] = destinations.map((siteId) => ({ siteId }));
		signs.push({
			id: origin === "spawn" ? "sign:start" : `sign:site-${origin}`,
			x: spot.x,
			y: spot.y,
			arms,
		});
	}

	return { signs, missed };
}

/**
 * The settlement the player wakes up inside, if they wake up inside one.
 *
 * Nearest centre wins where footprints overlap, which they can: a place is a disc and two
 * discs a cell apart touch. Only sites the scenario actually authored count — an
 * unauthored one has no name to paint on a board and no roster the story knows about.
 */
function spawnSite(artifact: ScenarioArtifact, sites: Map<number, MacroSite>): number | undefined {
	let best: { id: number; away: number } | undefined;
	for (const site of sites.values()) {
		if (!artifact.sites[String(site.id)]) continue;
		const away = Math.hypot(site.site.x - artifact.spawn.x, site.site.y - artifact.spawn.y);
		if (away > site.radius) continue;
		if (!best || away < best.away) best = { id: site.id, away };
	}
	return best?.id;
}

function placeName(artifact: ScenarioArtifact, origin: number | "spawn"): string {
	if (origin === "spawn") return "the start";
	return artifact.sites[String(origin)]?.name ?? `site ${origin}`;
}

interface Ground {
	readonly artifact: ScenarioArtifact;
	readonly grid: PassabilityGrid;
	readonly world: ReturnType<typeof artifactWorld>;
	readonly taken: ReadonlySet<string>;
}

/**
 * A tile to stand a post on, between one place and the next.
 *
 * Along the road where there is one, because that is where a signpost belongs and where
 * the player will be walking; along the straight line where there is not, which is the
 * spawn's case and any pair of places the router could not connect.
 *
 * Waypoints are tried in order and the *first* that has a verge wins, so a post ends up as
 * near the origin as the ground allows. Later is worse in a specific way: a board twenty
 * tiles out is a board the player reaches after they have already guessed.
 */
function postBetween(
	ground: Ground,
	origin: MacroSite | undefined,
	from: { readonly x: number; readonly y: number },
	to: MacroSite,
): { readonly x: number; readonly y: number } | undefined {
	const span = origin
		? { from: origin.radius + OUT_OF_TOWN.from, to: origin.radius + OUT_OF_TOWN.to }
		: OFF_THE_MAT;

	for (const waypoint of waypoints(ground, origin, from, to, span)) {
		// Beside the road first, then anywhere suitable. A board on the verge with the
		// track running past it is what a signpost looks like; a board in the middle of a
		// field is a board somebody put down and forgot, and the player has to walk out of
		// their way to read it.
		const beside = verge(ground, waypoint, true);
		if (beside) return beside;
		const anywhere = verge(ground, waypoint, false);
		if (anywhere) return anywhere;
	}
	return undefined;
}

/**
 * Points along the way out, nearest first.
 *
 * The road's own tiles when the two places are connected — walked from whichever end is
 * the origin, since `roadBetween` orders its endpoints by site id and not by who asked.
 */
function waypoints(
	ground: Ground,
	origin: MacroSite | undefined,
	from: { readonly x: number; readonly y: number },
	to: MacroSite,
	span: { readonly from: number; readonly to: number },
): { readonly x: number; readonly y: number }[] {
	const away = (point: { x: number; y: number }) => Math.hypot(point.x - from.x, point.y - from.y);

	if (origin) {
		const road = roadBetween(ground.world, origin, to);
		if (road) {
			const tiles = roadTiles(road)
				.map((tile) => ({ x: tile.x, y: tile.y }))
				.filter((tile) => away(tile) >= span.from && away(tile) <= span.to);
			tiles.sort((a, b) => away(a) - away(b));
			if (tiles.length > 0) return tiles;
		}
	}

	// No road, or none of it passes close enough: march the straight line instead. A tile
	// per step, so the caller's verge search has somewhere to start from at every distance.
	const dx = to.site.x - from.x;
	const dy = to.site.y - from.y;
	const length = Math.hypot(dx, dy);
	if (length < 1) return [];
	const line: { x: number; y: number }[] = [];
	for (let step = span.from; step <= Math.min(span.to, length); step++) {
		line.push({
			x: Math.round(from.x + (dx / length) * step),
			y: Math.round(from.y + (dy / length) * step),
		});
	}
	return line;
}

/**
 * Somewhere beside a waypoint that a board can stand on.
 *
 * Not the road itself when a verge will do: a post is drawn over whatever the tile is, so
 * one planted on a cobbled road reads as a hole in the road. The tile is still walkable
 * either way — decor takes no passability away outdoors — so this is about how it looks,
 * not about whether anything is blocked.
 *
 * Scanned in a fixed order so the answer is the same every time the world is written; the
 * whole artifact has to be reproducible from its seed and its brief.
 */
function verge(
	ground: Ground,
	waypoint: { readonly x: number; readonly y: number },
	besideRoad: boolean,
): { readonly x: number; readonly y: number } | undefined {
	for (let radius = 1; radius <= VERGE_REACH; radius++) {
		for (const [dx, dy] of ring(radius)) {
			const x = waypoint.x + dx;
			const y = waypoint.y + dy;
			if (!suits(ground, x, y)) continue;
			if (besideRoad && !nextToRoad(ground, x, y)) continue;
			return { x, y };
		}
	}
	return undefined;
}

/** The offsets at a given Chebyshev radius, in a fixed order. Orthogonals first. */
function ring(radius: number): readonly (readonly [number, number])[] {
	const offsets: [number, number][] = [];
	for (const [dx, dy] of [
		[0, -1],
		[1, 0],
		[0, 1],
		[-1, 0],
	] as const) {
		offsets.push([dx * radius, dy * radius]);
	}
	for (const [dx, dy] of [
		[1, -1],
		[1, 1],
		[-1, 1],
		[-1, -1],
	] as const) {
		offsets.push([dx * radius, dy * radius]);
	}
	return offsets;
}

/**
 * Whether a board could stand here at all.
 *
 * Open ground, inside the world, off the road, unclaimed, and with room around it. The
 * last of those is what keeps a post out of an alley or a one-tile causeway: three
 * walkable neighbours means the player can get in front of it from more than one side,
 * and a board nobody can face is a board nobody reads.
 */
function suits(ground: Ground, x: number, y: number): boolean {
	if (ground.taken.has(`${x},${y}`)) return false;
	if (!isWellInside(ground.artifact.bounds, x, y)) return false;
	if (!isPassable(ground.grid, x, y)) return false;
	if (isRoad(ground, x, y)) return false;
	if (x === ground.artifact.spawn.x && y === ground.artifact.spawn.y) return false;
	let ways = 0;
	for (const [dx, dy] of ring(1).slice(0, 4)) {
		if (isPassable(ground.grid, x + dx, y + dy)) ways++;
	}
	return ways >= 3;
}

function nextToRoad(ground: Ground, x: number, y: number): boolean {
	return ring(1)
		.slice(0, 4)
		.some(([dx, dy]) => isRoad(ground, x + dx, y + dy));
}

function isRoad(ground: Ground, x: number, y: number): boolean {
	const terrain = terrainOf(ground.grid, x, y);
	if (terrain === undefined) return false;
	return hasFlag(terrainDef(terrain).flags, TFlag.Road);
}
