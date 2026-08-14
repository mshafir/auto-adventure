import { generateFeature } from "../core/gen/features/registry.js";
import "../core/gen/features/builders.js";
import type { Anchor, BuildingPlacement } from "../core/gen/features/patch.js";
import { findPath } from "../core/geom/astar.js";
import type { Vec2 } from "../core/geom/vec.js";
import type {
	Scene,
	SceneAction,
	ScenePoint,
	StagedAction,
	StagedScene,
	StagedStep,
} from "../core/rules/scene.js";
import type { WorldBounds } from "../core/world/bounds.js";
import { type MacroSite, sitesInside } from "../core/world/macro.js";
import type { WorldSeed } from "../core/world/recipe.js";
import type { SiteSpec } from "../core/world/spec.js";

/**
 * Look the world up once, so a scene can be played by a pure function.
 *
 * Everything a cutscene needs to know about the world is resolved here and never asked
 * again: where each point is, and the exact tiles each walk will step onto. `advanceScene`
 * then has no probe, no pathfinder and no access to the map — which means a scene cannot
 * play differently on a second run, cannot be affected by what has been generated or
 * evicted since, and can be tested without a world at all.
 *
 * Staging fails whole rather than in part. A scene that plays with one action quietly
 * missing is worse than one that does not play: the story loses a beat and nothing says so,
 * which is precisely the class of fault this format exists to remove.
 */

export interface StageOptions {
	readonly world: WorldSeed;
	/**
	 * The edge of the world.
	 *
	 * Needed for two things: finding a site by id means sweeping the bounded footprint,
	 * because nothing carries its macro cell; and a walk has to be searched inside some
	 * rectangle.
	 */
	readonly bounds: WorldBounds;
	readonly siteSpec: (siteId: number) => SiteSpec | undefined;
	readonly isPassable: (x: number, y: number) => boolean;
	/** Where the player is standing as the scene opens, since `player` is always on stage. */
	readonly player: Vec2;
	/**
	 * Where somebody who lives in this world is standing, by npcId.
	 *
	 * How a cast member gets onto the stage without being spawned. Most of a scene's people
	 * are already *there* — the shrine-keeper is at the well because that is where they stand
	 * all day — and making a scene spawn them would put a second copy beside the first.
	 * `Spawn` is for somebody who is genuinely not in the world yet: a rider off the road, a
	 * body in the square.
	 */
	readonly npcAt?: (npcId: string) => Vec2 | undefined;
}

export interface StagingResult {
	readonly staged?: StagedScene;
	/** Why it could not be staged, in words. Empty when it could. */
	readonly problems: readonly string[];
}

/**
 * How far outside the straight line between two points a walk may be searched.
 *
 * A cutscene's movement is town-scale — across a square, out of a gate, up a street — so the
 * detour needed is at most around a building. Bounding the search keeps a scene that asks
 * for something impossible from sweeping the whole world before saying so.
 */
const DETOUR = 32;

export function stageScene(scene: Scene, options: StageOptions): StagingResult {
	const problems: string[] = [];
	const steps: StagedStep[] = [];
	const world = siteResolver(options);

	// Where each actor stands as the scene reaches each step, so a walk knows where it starts
	// from. Tracked here rather than at play time because that is the whole point of staging.
	const standing = new Map<string, Vec2>([["player", options.player]]);
	// A cast member who already lives in this world starts where they are standing. Anyone the
	// world has never heard of has to be spawned, and `stageAction` says so by name if a scene
	// forgets.
	for (const [alias, npcId] of Object.entries(scene.cast ?? {})) {
		const where = options.npcAt?.(npcId);
		if (where) standing.set(alias, where);
	}

	for (const [index, step] of scene.steps.entries()) {
		const actions: StagedAction[] = [];
		for (const action of step.do) {
			const staged = stageAction(action, { scene, index, standing, world, options, problems });
			if (staged) actions.push(staged);
		}
		steps.push({ do: actions, ...(step.hold !== undefined ? { hold: step.hold } : {}) });
	}

	if (problems.length > 0) return { problems };
	return { staged: { id: scene.id, steps, skippable: scene.skippable ?? true }, problems: [] };
}

interface StageContext {
	readonly scene: Scene;
	readonly index: number;
	readonly standing: Map<string, Vec2>;
	readonly world: SiteResolver;
	readonly options: StageOptions;
	readonly problems: string[];
}

function stageAction(action: SceneAction, ctx: StageContext): StagedAction | undefined {
	const where = `scene ${ctx.scene.id} step ${ctx.index + 1}`;

	switch (action.t) {
		case "Camera": {
			const to = resolve(action.to, ctx, `${where}: camera`);
			return to ? { t: "Camera", to, pan: action.pan ?? "cut" } : undefined;
		}
		case "Spawn": {
			const at = resolve(action.at, ctx, `${where}: ${action.actor} spawns`);
			if (!at) return undefined;
			ctx.standing.set(action.actor, at);
			return { t: "Spawn", actor: action.actor, at };
		}
		case "Despawn":
			ctx.standing.delete(action.actor);
			return { t: "Despawn", actor: action.actor };
		case "Face": {
			if (typeof action.at === "string") return { t: "Face", actor: action.actor, at: action.at };
			const at = resolve(action.at, ctx, `${where}: ${action.actor} faces`);
			return at ? { t: "Face", actor: action.actor, at } : undefined;
		}
		case "Say":
			return { t: "Say", actor: action.actor, text: action.text };
		case "Card":
			return { t: "Card", card: action.card };
		case "Wait":
			return { t: "Wait", ticks: action.ticks };
		case "Effects":
			return { t: "Effects", effects: action.effects };
		case "WalkTo": {
			const from = ctx.standing.get(action.actor);
			if (!from) {
				// An actor with no position has never been spawned and is not the player, so there is
				// nobody to walk. Worth naming rather than skipping: the likeliest cause is a typo in
				// an alias, and the scene would otherwise play with a character simply absent.
				ctx.problems.push(
					`${where}: "${action.actor}" walks, but is not on stage — spawn them first`,
				);
				return undefined;
			}
			const to = resolve(action.to, ctx, `${where}: ${action.actor} walks`);
			if (!to) return undefined;

			const path = route(from, to, ctx.options);
			if (!path) {
				ctx.problems.push(
					`${where}: "${action.actor}" cannot walk from ${from.x},${from.y} to ${to.x},${to.y} — nothing passable connects them`,
				);
				return undefined;
			}
			ctx.standing.set(action.actor, to);
			return { t: "WalkTo", actor: action.actor, path, speed: action.speed ?? "normal" };
		}
	}
}

/**
 * The tiles a walk steps onto, excluding the one it starts on.
 *
 * `findPath` is a deterministic A*, which is what makes this safe to precompute: the same
 * scene against the same world always produces the same route, so a cutscene looks identical
 * every time it is watched.
 */
function route(from: Vec2, to: Vec2, options: StageOptions): Vec2[] | undefined {
	if (from.x === to.x && from.y === to.y) return [];
	const path = findPath(from, to, {
		bounds: {
			x: Math.min(from.x, to.x) - DETOUR,
			y: Math.min(from.y, to.y) - DETOUR,
			w: Math.abs(to.x - from.x) + DETOUR * 2 + 1,
			h: Math.abs(to.y - from.y) + DETOUR * 2 + 1,
		},
		// The destination itself is allowed to be occupied by whatever is standing there —
		// an anchor usually has somebody at it — so only the ground between matters.
		cost: (x, y) =>
			options.isPassable(x, y) || (x === to.x && y === to.y) ? 1 : Number.POSITIVE_INFINITY,
	});
	if (!path) return undefined;
	// `findPath` includes the start; an actor already standing there does not step onto it.
	return path[0]?.x === from.x && path[0]?.y === from.y ? path.slice(1) : path;
}

function resolve(point: ScenePoint, ctx: StageContext, what: string): Vec2 | undefined {
	if (point.kind === "world") return { x: point.x, y: point.y };

	const built = ctx.world(point.siteId);
	if (!built) {
		ctx.problems.push(`${what}: site ${point.siteId} is not a place in this world`);
		return undefined;
	}

	if (point.kind === "door") {
		const wanted = point.structure.toLowerCase();
		// By proper name first, then by kind — the order `resolvePlacements` uses, and for the
		// same reason: a name is how an author thinks about a building and it is exact.
		const building =
			built.buildings.find((b) => b.name?.toLowerCase() === wanted) ??
			built.buildings.find((b) => b.kind === point.structure);
		if (!building) {
			ctx.problems.push(`${what}: there is no ${point.structure} at site ${point.siteId}`);
			return undefined;
		}
		return building.door;
	}

	// Outdoors only. An anchor with a `building` is inside one, and a cutscene played in
	// somebody's front room is not what "at the well" means.
	const anchor = built.anchors.find(
		(candidate) => candidate.kind === point.anchor && candidate.building === undefined,
	);
	if (!anchor) {
		ctx.problems.push(`${what}: site ${point.siteId} has no outdoor ${point.anchor}`);
		return undefined;
	}
	return { x: anchor.x, y: anchor.y };
}

type SiteResolver = (
	siteId: number,
) =>
	| { readonly buildings: readonly BuildingPlacement[]; readonly anchors: readonly Anchor[] }
	| undefined;

/**
 * Look a site's built settlement up, memoised.
 *
 * Both the sweep for a site's macro cell and generating its settlement are expensive enough
 * to be worth doing once — and a scene commonly names the same square three times.
 */
function siteResolver(options: StageOptions): SiteResolver {
	let sites: Map<number, MacroSite> | undefined;
	const built = new Map<number, ReturnType<SiteResolver>>();

	return (siteId) => {
		if (built.has(siteId)) return built.get(siteId);
		sites ??= sitesInside(options.world, options.bounds);
		const site = sites.get(siteId);
		const spec = options.siteSpec(siteId);
		const feature =
			site && spec ? generateFeature(options.world, site, spec.settlement) : undefined;
		const resolved = feature
			? { buildings: feature.buildings, anchors: feature.anchors }
			: undefined;
		built.set(siteId, resolved);
		return resolved;
	};
}
