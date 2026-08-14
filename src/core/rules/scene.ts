import type { AnchorKind } from "../gen/features/patch.js";
import type { Vec2 } from "../geom/vec.js";
import type { Card } from "./card.js";
import type { DomainEffect } from "./effects.js";
import type { Facing } from "./state.js";

/**
 * A moment the world takes over and the player watches.
 *
 * The vocabulary is deliberately that of a SNES-era cutscene and no larger: a list of
 * steps, each holding actions that run together, and no way to branch. Branching is what
 * triggers and phases are for, and a scene that could test state mid-run would be a small
 * programming language — needing its own interpreter, its own static checks, and a
 * playtest matrix that multiplies with every conditional.
 *
 * What it buys is the thing generated worlds were missing. A story told only through
 * conversations is a story nobody can *see*; a rider arriving at the gate while the player
 * stands still is the same information as a line of dialogue about a rider, and it is the
 * difference between being told a chapter turned and watching it turn.
 */
export interface Scene {
	readonly id: string;
	/**
	 * Stage names for the people involved, mapping an alias to an npcId.
	 *
	 * `"player"` is always available and needs no entry. Aliases exist so a scene reads as
	 * prose — `rider`, not `thornwick-3` — and so that recasting a scene does not mean
	 * rewriting every step in it.
	 */
	readonly cast?: Readonly<Record<string, string>>;
	readonly steps: readonly SceneStep[];
	/** Whether ESC ends it early. Defaults to true. */
	readonly skippable?: boolean;
}

export interface SceneStep {
	/** Actions that run together. The step ends when every one of them has finished. */
	readonly do: readonly SceneAction[];
	/** Frames to hold after they have all finished. */
	readonly hold?: number;
}

/**
 * Where a scene puts something.
 *
 * Deliberately *not* a {@link PlacementSite}, although the two look alike. A placement's
 * site spelling resolves to a tile *inside a building* — that is its whole purpose, since a
 * story hides things in chests — and a cutscene happens outdoors, in the square, at the
 * gate, by the well. Sharing the spelling would have meant a rider walking to the well and
 * arriving in somebody's pantry.
 *
 * What these three name, in descending order of how much the author has to know: an exact
 * tile, an outdoor anchor the generator laid down, and a building's doorstep.
 */
export type ScenePoint =
	| { readonly kind: "world"; readonly x: number; readonly y: number }
	| { readonly kind: "anchor"; readonly siteId: number; readonly anchor: AnchorKind }
	/** The tile outside a building's door, by the building's proper name or its kind. */
	| { readonly kind: "door"; readonly siteId: number; readonly structure: string };

export type PanKind = "cut" | "slow" | "fast";
export type WalkSpeed = "slow" | "normal" | "fast";

export type SceneAction =
	| { readonly t: "Camera"; readonly to: ScenePoint; readonly pan?: PanKind }
	| { readonly t: "Spawn"; readonly actor: string; readonly at: ScenePoint }
	| { readonly t: "Despawn"; readonly actor: string }
	| {
			readonly t: "WalkTo";
			readonly actor: string;
			readonly to: ScenePoint;
			readonly speed?: WalkSpeed;
	  }
	| { readonly t: "Face"; readonly actor: string; readonly at: ScenePoint | Facing }
	| { readonly t: "Say"; readonly actor: string; readonly text: string }
	| { readonly t: "Card"; readonly card: Card }
	| { readonly t: "Wait"; readonly ticks: number }
	| { readonly t: "Effects"; readonly effects: readonly DomainEffect[] };

/**
 * The same actions with the world already looked up.
 *
 * Every {@link ScenePoint} has become a tile and every walk carries the route it will
 * take, computed once by `stageScene`. That is what lets {@link advanceScene} be a pure
 * function of its arguments with no world access at all: the reducer never pathfinds, so a
 * scene cannot walk differently on a second playthrough, and none of this needs a world
 * to be tested against.
 */
export type StagedAction =
	| { readonly t: "Camera"; readonly to: Vec2; readonly pan: PanKind }
	| { readonly t: "Spawn"; readonly actor: string; readonly at: Vec2 }
	| { readonly t: "Despawn"; readonly actor: string }
	| {
			readonly t: "WalkTo";
			readonly actor: string;
			/** The tiles to step onto, in order, excluding the one the actor starts on. */
			readonly path: readonly Vec2[];
			readonly speed: WalkSpeed;
	  }
	| { readonly t: "Face"; readonly actor: string; readonly at: Vec2 | Facing }
	| { readonly t: "Say"; readonly actor: string; readonly text: string }
	| { readonly t: "Card"; readonly card: Card }
	| { readonly t: "Wait"; readonly ticks: number }
	| { readonly t: "Effects"; readonly effects: readonly DomainEffect[] };

export interface StagedStep {
	readonly do: readonly StagedAction[];
	readonly hold?: number;
}

export interface StagedScene {
	readonly id: string;
	readonly steps: readonly StagedStep[];
	readonly skippable: boolean;
}

export interface SceneActor {
	readonly x: number;
	readonly y: number;
	readonly facing: Facing;
	/** Tiles of the current walk still to be stepped onto. */
	readonly path?: readonly Vec2[];
}

/**
 * Where a scene has got to.
 *
 * Lives in `GameState` so that the whole of a scene's presentation is one value the
 * renderer reads, rather than a set of imperative calls into the view — which is the same
 * reason a card is state rather than a screen.
 *
 * Deliberately not persisted. The save is held back while a scene runs, so an interrupted
 * scene replays from its first step rather than resuming from a half-applied middle. That
 * is far cheaper than making every step resumable, and a scene is seconds long.
 */
export interface SceneState {
	readonly id: string;
	readonly step: number;
	/** Frames spent in the current step, counting the one it started on. */
	readonly elapsed: number;
	readonly actors: Readonly<Record<string, SceneActor>>;
	/** Where the camera is aimed. Absent means follow the player as usual. */
	readonly camera?: Vec2;
	/** The line on screen. While this is set, the scene waits for the player. */
	readonly caption?: { readonly speaker: string; readonly text: string };
}

export interface SceneInput {
	/** The player pressed the advance key this frame. */
	readonly advance: boolean;
}

export interface SceneOutcome {
	/** The scene's new state, or absent once it is over. */
	readonly scene?: SceneState;
	/** What the world should do as a result of this frame, in order. */
	readonly effects: readonly DomainEffect[];
}

/**
 * How many frames one tile of walking takes.
 *
 * A walker holds each tile for whole frames rather than covering a fraction of one,
 * because the world is a grid and an actor between two tiles has nowhere to be drawn.
 * One tile a frame is therefore the fastest anything can move, and at the ninety
 * milliseconds a scene frame lasts that is already eleven tiles a second — a gallop.
 * So the three speeds are all divisors of it and none of them takes more than a tile
 * at a time.
 *
 * `fast` used to take *two* tiles a frame, which is twenty-two tiles a second: a rider
 * crossed a village square in under a second and the arrival the scene existed to show
 * was over before it registered. That was half of "the cutscene went by too quickly".
 */
const FRAMES_PER_TILE: Readonly<Record<WalkSpeed, number>> = { slow: 4, normal: 2, fast: 1 };

/**
 * How many tiles a scene's camera pans in one frame.
 *
 * A cut is instant and needs no number. At ninety milliseconds a frame these are about
 * eleven and thirty-three tiles a second — a considered look, and a snap of the head.
 *
 * Kept here rather than in the renderer, and that is the point of it: a pan the *machine*
 * performs is a pan the machine can wait for. While it lived in the view the scene treated
 * every camera move as instantaneous and walked on regardless, so a rider could arrive and
 * speak while the camera was still travelling — or, because the view memoised the pan on a
 * target that never changed, while it had moved a single tile and stopped.
 */
const PAN_TILES_PER_FRAME: Readonly<Record<PanKind, number>> = { cut: 0, slow: 1, fast: 3 };

export function beginScene(staged: StagedScene, player: Vec2, facing: Facing): SceneState {
	return {
		id: staged.id,
		step: 0,
		elapsed: 0,
		actors: { player: { x: player.x, y: player.y, facing } },
		// Aimed at the player from the first frame, so a pan has somewhere to start from and
		// so a scene does not inherit the dead zone the walking camera uses. A scene points at
		// a gate or a well deliberately; drifting toward it would be the wrong shot.
		camera: { x: player.x, y: player.y },
	};
}

/**
 * Run one frame of a scene.
 *
 * Apply whatever the current step's actions do this frame, decide whether they have all
 * finished, and if so move on. A step's instantaneous actions are applied on the frame it
 * *starts*, which is why a spawn and a camera cut are visible immediately rather than a
 * frame late.
 *
 * A step's *completion* is rendered on the frame it completes, and the next step begins on
 * the frame after. That is deliberate and it is the only frame on which an actor is drawn
 * standing at the end of its walk — running the next step in the same frame would compose
 * over the arrival and nobody would ever be seen getting anywhere.
 *
 * The corollary is worth knowing when authoring: the *last* step's completion is not
 * rendered, because the scene is over and control goes back to the player. A scene whose
 * final action must be seen finishing needs a `hold` on that step, which keeps the frame on
 * screen for as long as it asks.
 */
export function advanceScene(
	staged: StagedScene,
	state: SceneState,
	input: SceneInput,
): SceneOutcome {
	const step = staged.steps[state.step];
	if (!step) return { effects: [] };

	// A line on screen is the one thing in a scene that waits for a person. Nothing else
	// progresses while it is up, so a scene cannot walk somebody off stage underneath a
	// caption the player has not read yet.
	if (state.caption) {
		if (!input.advance) return { scene: state, effects: [] };
		return advanceScene(staged, dropCaption(state), { advance: false });
	}

	const first = state.elapsed === 0;
	let actors = state.actors;
	let camera = state.camera;
	let caption: SceneState["caption"];
	const effects: DomainEffect[] = [];

	for (const action of step.do) {
		switch (action.t) {
			case "Spawn":
				if (first) {
					actors = {
						...actors,
						[action.actor]: { x: action.at.x, y: action.at.y, facing: "down" },
					};
				}
				break;
			case "Despawn":
				if (first) actors = without(actors, action.actor);
				break;
			case "Camera":
				// A cut lands at once; a pan slides a fixed number of tiles a frame until it
				// arrives, and the step below will not finish while it is still travelling.
				camera = panned(camera, action.to, PAN_TILES_PER_FRAME[action.pan]);
				break;
			case "Face": {
				if (!first) break;
				const actor = actors[action.actor];
				if (!actor) break;
				const facing = typeof action.at === "string" ? action.at : towards(actor, action.at);
				actors = { ...actors, [action.actor]: { ...actor, facing } };
				break;
			}
			case "Say":
				if (first) caption = { speaker: action.actor, text: action.text };
				break;
			case "Card":
				if (first) effects.push({ t: "ShowCard", card: action.card });
				break;
			case "Effects":
				if (first) effects.push(...action.effects);
				break;
			case "Wait":
				break;
			case "WalkTo": {
				const actor = actors[action.actor];
				if (!actor) break;
				const remaining = first ? action.path : (actor.path ?? []);
				if (remaining.length === 0) {
					if (actor.path) actors = { ...actors, [action.actor]: standing(actor) };
					break;
				}
				const hold = FRAMES_PER_TILE[action.speed];
				if (state.elapsed % hold !== 0) {
					actors = { ...actors, [action.actor]: { ...actor, path: remaining } };
					break;
				}
				const landing = remaining[0] as Vec2;
				const rest = remaining.slice(1);
				actors = {
					...actors,
					[action.actor]: {
						x: landing.x,
						y: landing.y,
						facing: towards(actor, landing),
						...(rest.length > 0 ? { path: rest } : {}),
					},
				};
				break;
			}
		}
	}

	const elapsed = state.elapsed + 1;
	const busy = step.do.some((action) => unfinished(action, actors, camera, elapsed));
	// `hold` counts frames *after* the actions are done, so a step that is still busy has
	// not started holding yet.
	const holding = !busy && elapsed <= (step.hold ?? 0);

	if (caption) return { scene: { ...state, actors, ...aimed(camera), caption, elapsed }, effects };
	if (busy || holding) return { scene: { ...state, actors, ...aimed(camera), elapsed }, effects };

	const next = state.step + 1;
	if (next >= staged.steps.length) return { effects };
	return { scene: { ...state, step: next, elapsed: 0, actors, ...aimed(camera) }, effects };
}

/** Whether this action still has work left after the frame just applied. */
function unfinished(
	action: StagedAction,
	actors: Readonly<Record<string, SceneActor>>,
	camera: Vec2 | undefined,
	elapsed: number,
): boolean {
	if (action.t === "WalkTo") return (actors[action.actor]?.path?.length ?? 0) > 0;
	if (action.t === "Wait") return elapsed < action.ticks;
	if (action.t === "Camera") {
		if (action.pan === "cut") return false;
		return !camera || camera.x !== action.to.x || camera.y !== action.to.y;
	}
	return false;
}

/**
 * Slide the camera toward where it is being aimed, one frame's worth.
 *
 * Lands exactly on the target rather than oscillating past it, so "has it arrived" is an
 * equality test and a pan of any length terminates.
 */
function panned(from: Vec2 | undefined, to: Vec2, tilesPerFrame: number): Vec2 {
	if (!from || tilesPerFrame <= 0) return to;
	return { x: toward(from.x, to.x, tilesPerFrame), y: toward(from.y, to.y, tilesPerFrame) };
}

function toward(from: number, to: number, rate: number): number {
	const delta = to - from;
	if (Math.abs(delta) <= rate) return to;
	return from + Math.sign(delta) * rate;
}

/** Which way one point is from another, by the larger of the two offsets. */
function towards(from: Vec2, to: Vec2): Facing {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
	return dy >= 0 ? "down" : "up";
}

/*
 * The three helpers below exist because `exactOptionalPropertyTypes` forbids assigning
 * `undefined` to an optional property, so "this actor has stopped walking" and "there is
 * no caption any more" have to be spelled as a key that is absent rather than a key set to
 * nothing.
 */

function aimed(camera: Vec2 | undefined): { camera?: Vec2 } {
	return camera ? { camera } : {};
}

function standing(actor: SceneActor): SceneActor {
	const { path: arrived, ...rest } = actor;
	void arrived;
	return rest;
}

function dropCaption(state: SceneState): SceneState {
	const { caption: read, ...rest } = state;
	void read;
	return rest;
}

function without(
	actors: Readonly<Record<string, SceneActor>>,
	actor: string,
): Readonly<Record<string, SceneActor>> {
	const { [actor]: gone, ...rest } = actors;
	void gone;
	return rest;
}
