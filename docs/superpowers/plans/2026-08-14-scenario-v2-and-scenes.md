# Scenario v2, Phases and Scenes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-file scenario artifact with a scenario *directory* that
carries phase diffs, authored terraform and playable cutscenes, and delete the
model-authoring pipeline it replaces.

**Architecture:** Three additions around an unchanged engine. A directory loader produces
the same in-memory artifact shape the engine already consumes. A pure `composeScenario`
folds phase diffs over base content according to game state. A scene player is a state
machine in `GameState`, staged once against the world when it starts (so it holds only
plain coordinates) and then advanced by a pure reducer step.

**Tech Stack:** TypeScript ESM (explicit `.js` import specifiers), Zod 4 for file schemas,
Vitest, Biome, Ink/React for the terminal UI.

## Global Constraints

- `exactOptionalPropertyTypes: true`. Never assign `undefined` to an optional property —
  use a conditional spread: `...(value ? { key: value } : {})`.
- Every relative import ends in `.js`, even for `.ts` sources. ESM requires it.
- `npm run check` = `typecheck && lint && test`. It must pass at the end of every task.
- Run tests in the background or with a generous timeout. A killed run strands vitest
  workers; `npm run test:reap` clears them.
- `artifactVersion` becomes `2`. There is **no** migration from version 1 — every v1
  scenario file is deleted by Task 1.
- Comments explain *why*, in prose, matching the density of the surrounding file. This
  codebase documents reasoning, not mechanics. Do not write comments that restate code.
- `tick` is an action counter (one per player command, sixty to the game hour). Scenes
  must never advance it.
- New public types get a doc comment saying what they are for and what they deliberately
  do not do.

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/core/rules/scene.ts` | `Scene`, `SceneStep`, `SceneAction`, `ScenePoint`, `StagedScene`, `SceneState`, and the pure `advanceScene` machine |
| `src/core/rules/scene-check.ts` | `sceneEffectProblems` — the non-idempotent-effect rule |
| `src/scenario/phase.ts` | `Phase`, `Diff`, `ScenarioContent`, `enteredPhaseIds`, `composeScenario` |
| `src/scenario/terraform.ts` | `TerraformEdit` and its bounding rectangle |
| `src/core/gen/features/authored.ts` | `authoredPatch` — terraform edits rasterised into a `FeaturePatch` |
| `src/engine/scene-staging.ts` | `stageScene` — resolve points, precompute walk paths |
| `src/scenario/dir.ts` | `readScenarioDir`, `writeScenarioDir`, `listScenarioDirs` |
| `src/ui/panels/scene-caption.tsx` | The caption banner drawn over the world during a scene |
| `test/fixtures/scenarios/two-phase/` | A real scenario directory: two towns, one cutscene, two phases, one terraform path |

**Modified**

| File | Change |
|---|---|
| `src/core/rules/commands.ts` | add `SceneFrame`, `SkipScene` |
| `src/core/rules/effects.ts` | add `PlayScene` |
| `src/core/rules/state.ts` | add `scene`, `scenes`, `phases`, `terraform` |
| `src/core/rules/trigger.ts` | defer the fired flag when a trigger plays a scene |
| `src/core/rules/reduce.ts` | input lock, `SceneFrame`/`SkipScene`, `PlayScene`, `WorldProbe.stagedScene` |
| `src/core/gen/pipeline.ts` | `terraform` in `GenContext`, stamped as a patch |
| `src/engine/chunk-manager.ts` | pass `terraform` through to `generateChunk` |
| `src/engine/engine.ts` | compose content on phase change, stage scenes, invalidate on terraform change |
| `src/scenario/artifact.ts` | version 2; `phases`, `scenes`, `terraform` |
| `src/scenario/schema.ts` | schemas for the above |
| `src/scenario/repo.ts` | read/write/list directories instead of files |
| `src/session.ts` | seed state with scenes, phases and terraform |
| `src/ui/app.tsx` | scene frame driver, camera override, actor sprites, caption |

**Deleted (Task 1)** — `src/ai/author/` entirely; `src/scenario/{draft,settle,fit,repair,generate}.ts` and their tests; `src/scenario/{arc,green-chapel,thornwick,trees}-live.test.ts`; `src/tools/{author,assemble}.ts`; `src/ui/launcher/{generate-config,generate-progress,pick-premise,new-world}.tsx` and their tests; every `.scenarios/*.json`.

---

### Task 1: Delete the authoring pipeline

Nothing new is built here. The point is to get to a green tree with no model-authoring
code in it, so that later tasks are not maintaining two artifact formats.

**Files:**
- Delete: `src/ai/author/` (whole directory)
- Delete: `src/scenario/draft.ts`, `draft.test.ts`, `settle.ts`, `settle.test.ts`, `fit.ts`, `fit.test.ts`, `repair.ts`, `repair.test.ts`, `generate.ts`, `generate.test.ts`
- Delete: `src/scenario/arc-live.test.ts`, `green-chapel-live.test.ts`, `thornwick-live.test.ts`, `trees-live.test.ts`
- Delete: `src/tools/author.ts`, `src/tools/assemble.ts`
- Delete: `src/ui/launcher/generate-config.tsx`, `generate-config.test.tsx`, `generate-progress.tsx`, `generate-progress.test.tsx`, `pick-premise.tsx`, `pick-premise.test.tsx`, `new-world.tsx`
- Delete: `.scenarios/*.json`
- Modify: `src/ui/launcher/pick-launch.tsx`, `src/ui/launcher/launcher.tsx`, `src/ui/launcher/chooser.tsx`, `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: a tree where `src/scenario/scenario.ts` still exports `LaunchChoice`,
  `Flavour` and `usesLiveModel`, and `src/scenario/repo.ts` still exports
  `listScenarios`, `loadScenario`, `writeScenario`, `verifyArtifact`.

- [ ] **Step 1: Record what currently passes, so the end state can be compared**

```bash
npx vitest run --reporter=dot 2>&1 | tail -5 > /tmp/before.txt; cat /tmp/before.txt
```

- [ ] **Step 2: Delete the authoring modules and the shipped scenarios**

```bash
git rm -r src/ai/author
git rm src/scenario/{draft,settle,fit,repair,generate}.ts \
       src/scenario/{draft,settle,fit,repair,generate}.test.ts
git rm src/scenario/{arc,green-chapel,thornwick,trees}-live.test.ts
git rm src/tools/author.ts src/tools/assemble.ts
git rm src/ui/launcher/{generate-config,generate-progress,pick-premise}.tsx \
       src/ui/launcher/{generate-config,generate-progress,pick-premise}.test.tsx \
       src/ui/launcher/new-world.tsx
git rm .scenarios/*.json
```

- [ ] **Step 3: Remove the generation route from the launcher**

`pick-launch.tsx` currently owns the attempt loop that calls `generateScenario`. The
launcher keeps exactly three ways in: continue a save, play a shipped scenario, start a
live procedural world. Open `src/ui/launcher/launcher.tsx` and `chooser.tsx`, remove the
menu entry that led to generation and the state it needed, and delete `pick-launch.tsx`
if nothing else routes through it.

Read each file before editing — the launcher is a small state machine and the entry is
named `"new"` or similar in a union of screens. Removing the union member will make
TypeScript point at every place that has to change, which is the intended way to do
this.

- [ ] **Step 4: Remove the dead npm scripts**

In `package.json`, delete the `author` and `assemble` script entries. Leave `survey`,
`validate` and `invariants` — sub-project 2 turns those into `craft` subcommands.

- [ ] **Step 5: Typecheck and let the compiler find the rest**

```bash
npm run typecheck
```

Expected: errors naming files that imported the deleted modules. Fix each by deleting the
import and the code that used it. Do not add stubs to keep something compiling — if a
function's only purpose was to feed the authoring pipeline, it goes too.

- [ ] **Step 6: Full check**

```bash
npm run check
```

Expected: PASS. Test count is lower than `/tmp/before.txt` because whole suites were
deleted; no test should *fail*.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Delete the pipeline that argued prose into agreement with the world"
```

---

### Task 2: Scene types and the pure step machine

The heart of the feature, and deliberately the part with no engine, no world and no
React in it.

**Files:**
- Create: `src/core/rules/scene.ts`
- Test: `src/core/rules/scene.test.ts`

**Interfaces:**
- Consumes: `Facing`, `Point` from `./state.js`; `Card` from `./card.js`; `DomainEffect`
  from `./effects.js`; `PlacementSite` from `./placement.js`.
- Produces:
  - `interface Scene { id, cast?, steps, skippable? }`
  - `type ScenePoint = PlacementSite`
  - `type SceneAction` — the authored union, carrying `ScenePoint`s
  - `type StagedAction` — the same union with every point resolved to `Point` and every
    walk carrying `path: readonly Point[]`
  - `interface StagedScene { id, steps: readonly StagedStep[], skippable: boolean }`
  - `interface SceneState { id, step, elapsed, actors, camera?, caption? }`
  - `interface SceneActor { x, y, facing, path? }`
  - `function beginScene(staged: StagedScene, player: Point, facing: Facing): SceneState`
  - `function advanceScene(staged: StagedScene, state: SceneState, input: SceneInput): SceneOutcome`
  - `interface SceneInput { readonly advance: boolean }`
  - `interface SceneOutcome { readonly scene?: SceneState; readonly effects: readonly DomainEffect[] }`
  - `function endScene(staged: StagedScene): readonly DomainEffect[]`

- [ ] **Step 1: Write the failing test file**

Create `src/core/rules/scene.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { advanceScene, beginScene, type StagedScene } from "./scene.js";

/** A scene with one actor walking three tiles, then speaking. */
function walkThenSpeak(): StagedScene {
	return {
		id: "the-messenger-arrives",
		skippable: true,
		steps: [
			{
				do: [
					{ t: "Spawn", actor: "rider", at: { x: 10, y: 10 } },
					{ t: "Camera", to: { x: 10, y: 10 }, pan: "cut" },
				],
			},
			{
				do: [
					{
						t: "WalkTo",
						actor: "rider",
						path: [
							{ x: 11, y: 10 },
							{ x: 12, y: 10 },
							{ x: 13, y: 10 },
						],
						speed: "normal",
					},
				],
			},
			{ do: [{ t: "Say", actor: "rider", text: "The abbey has fallen." }] },
			{ do: [{ t: "Effects", effects: [{ t: "SetFlag", key: "phase", value: 2 }] }] },
		],
	};
}

const idle = { advance: false } as const;
const pressed = { advance: true } as const;

describe("advanceScene", () => {
	it("puts an actor on stage and aims the camera in the first frame", () => {
		const staged = walkThenSpeak();
		const opened = beginScene(staged, { x: 4, y: 4 }, "down");
		const first = advanceScene(staged, opened, idle);

		expect(first.scene?.actors.rider).toMatchObject({ x: 10, y: 10 });
		expect(first.scene?.camera).toEqual({ x: 10, y: 10 });
	});

	it("consumes one tile of a walk per frame and moves on when the path runs out", () => {
		const staged = walkThenSpeak();
		let scene = advanceScene(staged, beginScene(staged, { x: 4, y: 4 }, "down"), idle).scene;

		const seen: number[] = [];
		for (let frame = 0; frame < 4; frame++) {
			scene = advanceScene(staged, scene as NonNullable<typeof scene>, idle).scene;
			seen.push(scene?.actors.rider?.x as number);
		}

		// Three tiles of path, one per frame, and the fourth frame has nothing left to
		// walk — so the step is finished and the scene has moved on to the line.
		expect(seen).toEqual([11, 12, 13, 13]);
		expect(scene?.caption?.text).toBe("The abbey has fallen.");
	});

	it("faces a walking actor along the direction it is travelling", () => {
		const staged = walkThenSpeak();
		let scene = advanceScene(staged, beginScene(staged, { x: 4, y: 4 }, "down"), idle).scene;
		scene = advanceScene(staged, scene as NonNullable<typeof scene>, idle).scene;
		expect(scene?.actors.rider?.facing).toBe("right");
	});

	it("holds a line on screen until the player advances", () => {
		const staged = walkThenSpeak();
		let scene = beginScene(staged, { x: 4, y: 4 }, "down");
		// Frames enough to finish the spawn and the whole walk.
		for (let frame = 0; frame < 6; frame++) {
			scene = advanceScene(staged, scene, idle).scene as NonNullable<typeof scene>;
		}
		expect(scene.caption?.text).toBe("The abbey has fallen.");

		// Idle frames do not get past it.
		scene = advanceScene(staged, scene, idle).scene as NonNullable<typeof scene>;
		expect(scene.caption?.text).toBe("The abbey has fallen.");

		// A keypress does.
		const answered = advanceScene(staged, scene, pressed);
		expect(answered.scene?.caption).toBeUndefined();
	});

	it("emits a step's effects when that step runs, not when the scene ends", () => {
		const staged = walkThenSpeak();
		let scene: ReturnType<typeof beginScene> | undefined = beginScene(staged, { x: 4, y: 4 }, "down");
		const effects = [];
		for (let frame = 0; frame < 12 && scene; frame++) {
			const outcome = advanceScene(staged, scene, pressed);
			effects.push(...outcome.effects);
			scene = outcome.scene;
		}
		expect(effects).toContainEqual({ t: "SetFlag", key: "phase", value: 2 });
	});

	it("reports the scene over by returning no scene", () => {
		const staged = walkThenSpeak();
		let scene: ReturnType<typeof beginScene> | undefined = beginScene(staged, { x: 4, y: 4 }, "down");
		for (let frame = 0; frame < 12 && scene; frame++) {
			scene = advanceScene(staged, scene, pressed).scene;
		}
		expect(scene).toBeUndefined();
	});

	it("holds a step for its stated number of frames after its actions finish", () => {
		const staged: StagedScene = {
			id: "a-pause",
			skippable: true,
			steps: [{ do: [{ t: "Wait", ticks: 3 }] }, { do: [{ t: "Say", actor: "player", text: "Oh." }] }],
		};
		let scene: ReturnType<typeof beginScene> | undefined = beginScene(staged, { x: 0, y: 0 }, "down");
		for (let frame = 0; frame < 3; frame++) {
			scene = advanceScene(staged, scene as NonNullable<typeof scene>, idle).scene;
			expect(scene?.caption).toBeUndefined();
		}
		scene = advanceScene(staged, scene as NonNullable<typeof scene>, idle).scene;
		expect(scene?.caption?.text).toBe("Oh.");
	});

	it("ends when the slower of two parallel actions finishes, not the faster", () => {
		const staged: StagedScene = {
			id: "together",
			skippable: true,
			steps: [
				{
					do: [
						{ t: "WalkTo", actor: "a", path: [{ x: 1, y: 0 }], speed: "normal" },
						{
							t: "WalkTo",
							actor: "b",
							path: [
								{ x: 5, y: 0 },
								{ x: 6, y: 0 },
								{ x: 7, y: 0 },
							],
							speed: "normal",
						},
					],
				},
				{ do: [{ t: "Say", actor: "a", text: "There." }] },
			],
		};
		let scene: ReturnType<typeof beginScene> | undefined = beginScene(staged, { x: 0, y: 0 }, "down");
		for (let frame = 0; frame < 3; frame++) {
			scene = advanceScene(staged, scene as NonNullable<typeof scene>, idle).scene;
		}
		// `a` arrived after one frame; the step is still running because `b` had three tiles.
		expect(scene?.actors.a).toMatchObject({ x: 1, y: 0 });
		expect(scene?.actors.b).toMatchObject({ x: 7, y: 0 });
		expect(scene?.caption).toBeUndefined();

		scene = advanceScene(staged, scene as NonNullable<typeof scene>, idle).scene;
		expect(scene?.caption?.text).toBe("There.");
	});
});
```

- [ ] **Step 2: Run it and watch it fail to import**

```bash
npx vitest run src/core/rules/scene.test.ts
```

Expected: FAIL — `Failed to resolve import "./scene.js"`.

- [ ] **Step 3: Write `src/core/rules/scene.ts`**

```ts
import type { Card } from "./card.js";
import type { DomainEffect } from "./effects.js";
import type { PlacementSite } from "./placement.js";
import type { Facing } from "./state.js";

/**
 * A moment the world takes over and the player watches.
 *
 * The vocabulary is deliberately that of a SNES-era cutscene and no larger: a list of
 * steps, each holding actions that run together, and no way to branch. Branching is
 * what triggers and phases are for, and a scene that could test state mid-run would be
 * a small programming language — with its own interpreter, its own static checks, and a
 * playtest matrix that multiplies with every conditional.
 */
export interface Scene {
	readonly id: string;
	/**
	 * Stage names for the people involved, mapping an alias to an npcId.
	 *
	 * `"player"` is always available and needs no entry. Aliases exist so a scene reads
	 * as prose — `rider`, not `thornwick-3` — and so the same scene can be re-cast
	 * without rewriting every step in it.
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

/** Where a scene puts something. The same spellings a {@link PlacementSite} has. */
export type ScenePoint = PlacementSite;

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

export interface Point {
	readonly x: number;
	readonly y: number;
}

/**
 * A scene with the world already looked up.
 *
 * Every {@link ScenePoint} has become a tile and every walk carries the route it will
 * take, computed once by `stageScene`. That is what lets {@link advanceScene} be a pure
 * function of its arguments with no world access at all: the reducer never pathfinds, so
 * a scene cannot walk differently on a second playthrough, and none of this has to be
 * mocked to test it.
 */
export type StagedAction =
	| { readonly t: "Camera"; readonly to: Point; readonly pan: PanKind }
	| { readonly t: "Spawn"; readonly actor: string; readonly at: Point }
	| { readonly t: "Despawn"; readonly actor: string }
	| {
			readonly t: "WalkTo";
			readonly actor: string;
			/** The tiles to step onto, in order, excluding where the actor already stands. */
			readonly path: readonly Point[];
			readonly speed: WalkSpeed;
	  }
	| { readonly t: "Face"; readonly actor: string; readonly at: Point | Facing }
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
	readonly path?: readonly Point[];
}

/**
 * Where a scene has got to.
 *
 * Lives in `GameState` so that the whole of a scene's presentation is one value the
 * renderer reads, rather than a set of imperative calls into the view. Not persisted: a
 * save is never written mid-scene, and an interrupted scene replays from its first step.
 */
export interface SceneState {
	readonly id: string;
	readonly step: number;
	/** Frames spent in the current step, counting the frame it started on. */
	readonly elapsed: number;
	readonly actors: Readonly<Record<string, SceneActor>>;
	/** Where the camera is aimed. Absent means follow the player as usual. */
	readonly camera?: Point;
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

/** How many frames one tile of walking takes, by speed. */
const FRAMES_PER_TILE: Readonly<Record<WalkSpeed, number>> = { slow: 3, normal: 1, fast: 1 };

/**
 * How many tiles a walk covers per frame.
 *
 * `fast` moves two tiles a frame rather than shortening the frame, because the frame
 * interval is the UI's to choose and a scene must not depend on it.
 */
const TILES_PER_FRAME: Readonly<Record<WalkSpeed, number>> = { slow: 1, normal: 1, fast: 2 };

export function beginScene(staged: StagedScene, player: Point, facing: Facing): SceneState {
	return {
		id: staged.id,
		step: 0,
		elapsed: 0,
		actors: { player: { x: player.x, y: player.y, facing } },
	};
}

/**
 * Run one frame of a scene.
 *
 * The shape is: apply whatever the current step's actions do this frame, decide whether
 * they have all finished, and if so move to the next step. A step's actions are applied
 * on the frame it *starts*, which is why a spawn and a camera cut are visible
 * immediately rather than a frame late.
 */
export function advanceScene(
	staged: StagedScene,
	state: SceneState,
	input: SceneInput,
): SceneOutcome {
	const step = staged.steps[state.step];
	if (!step) return { effects: [] };

	// A line on screen is the one thing that waits for a person. Nothing else in the
	// step progresses while it is up, so that a scene cannot walk somebody off stage
	// under a caption the player has not read yet.
	if (state.caption) {
		if (!input.advance) return { scene: state, effects: [] };
		return advanceScene(staged, { ...state, caption: undefined }, { advance: false });
	}

	const first = state.elapsed === 0;
	let actors = state.actors;
	let camera = state.camera;
	let caption = state.caption;
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
				if (first) {
					const { [action.actor]: gone, ...rest } = actors;
					void gone;
					actors = rest;
				}
				break;
			case "Camera":
				// A cut lands at once. A pan is interpolated by the renderer between the
				// camera it had and this target, so the state only has to carry the target.
				if (first) camera = action.to;
				break;
			case "Face":
				if (first) {
					const actor = actors[action.actor];
					if (actor) {
						actors = {
							...actors,
							[action.actor]: {
								...actor,
								facing: typeof action.at === "string" ? action.at : towards(actor, action.at),
							},
						};
					}
				}
				break;
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
					if (actor.path) {
						const { path: done, ...standing } = actor;
						void done;
						actors = { ...actors, [action.actor]: standing };
					}
					break;
				}
				// Slower speeds hold each tile for several frames rather than stepping a
				// fraction of a tile: the world is a grid and an actor between two tiles has
				// nowhere to be drawn.
				const hold = FRAMES_PER_TILE[action.speed];
				if (hold > 1 && state.elapsed % hold !== 0 && !first) {
					actors = { ...actors, [action.actor]: { ...actor, path: remaining } };
					break;
				}
				const stride = Math.min(TILES_PER_FRAME[action.speed], remaining.length);
				const landing = remaining[stride - 1] as Point;
				const rest = remaining.slice(stride);
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
	const busy = step.do.some((action) => unfinished(action, actors, elapsed));
	const holding = elapsed <= (step.hold ?? 0);

	if (caption) {
		return { scene: { ...state, actors, ...spread(camera), caption, elapsed }, effects };
	}
	if (busy || holding) {
		return { scene: { ...state, actors, ...spread(camera), elapsed }, effects };
	}

	const next = state.step + 1;
	if (next >= staged.steps.length) return { effects };
	return {
		scene: { ...state, step: next, elapsed: 0, actors, ...spread(camera) },
		effects,
	};
}

/** Whether this action still has work left after the frame just applied. */
function unfinished(
	action: StagedAction,
	actors: Readonly<Record<string, SceneActor>>,
	elapsed: number,
): boolean {
	if (action.t === "WalkTo") return (actors[action.actor]?.path?.length ?? 0) > 0;
	if (action.t === "Wait") return elapsed < action.ticks;
	return false;
}

/** Which way one point is from another, by the larger of the two offsets. */
function towards(from: Point, to: Point): Facing {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
	return dy >= 0 ? "down" : "up";
}

/** `exactOptionalPropertyTypes` forbids writing `camera: undefined`. */
function spread(camera: Point | undefined): { camera?: Point } {
	return camera ? { camera } : {};
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run src/core/rules/scene.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/rules/scene.ts src/core/rules/scene.test.ts
git commit -m "A scene player that knows nothing about the world it plays in"
```

---

### Task 3: The scene effect idempotency rule

An interrupted scene replays from its first step, so an effect in a middle step can
happen twice. This is the check that makes that safe, written here as a pure function
and merely *called* by the CLI in sub-project 2.

**Files:**
- Create: `src/core/rules/scene-check.ts`
- Test: `src/core/rules/scene-check.test.ts`

**Interfaces:**
- Consumes: `Scene` from `./scene.js`.
- Produces: `function sceneEffectProblems(scene: Scene): string[]`, and
  `const REPEATABLE_EFFECTS: ReadonlySet<string>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import type { Scene } from "./scene.js";
import { sceneEffectProblems } from "./scene-check.js";

function sceneWith(steps: Scene["steps"]): Scene {
	return { id: "a-scene", steps };
}

describe("sceneEffectProblems", () => {
	it("passes a scene whose only effects are flags", () => {
		const scene = sceneWith([
			{ do: [{ t: "Effects", effects: [{ t: "SetFlag", key: "met", value: true }] }] },
			{ do: [{ t: "Say", actor: "player", text: "Done." }] },
		]);
		expect(sceneEffectProblems(scene)).toEqual([]);
	});

	it("refuses an item granted anywhere but the last step", () => {
		const scene = sceneWith([
			{
				do: [
					{
						t: "Effects",
						effects: [{ t: "GrantItem", name: "Ledger", description: "Damp.", quantity: 1 }],
					},
				],
			},
			{ do: [{ t: "Say", actor: "player", text: "Heavy." }] },
		]);
		expect(sceneEffectProblems(scene)).toEqual([
			'scene a-scene grants "Ledger" in step 1 of 2; an interrupted scene replays, so GrantItem may only appear in the last step',
		]);
	});

	it("allows the same grant in the last step", () => {
		const scene = sceneWith([
			{ do: [{ t: "Say", actor: "player", text: "Heavy." }] },
			{
				do: [
					{
						t: "Effects",
						effects: [{ t: "GrantItem", name: "Ledger", description: "Damp.", quantity: 1 }],
					},
				],
			},
		]);
		expect(sceneEffectProblems(scene)).toEqual([]);
	});

	it("names every offending effect rather than only the first", () => {
		const scene = sceneWith([
			{ do: [{ t: "Effects", effects: [{ t: "AdjustGold", amount: -5 }] }] },
			{ do: [{ t: "Effects", effects: [{ t: "Damage", amount: 3 }] }] },
			{ do: [{ t: "Say", actor: "player", text: "Ouch." }] },
		]);
		expect(sceneEffectProblems(scene)).toHaveLength(2);
	});

	it("says nothing about a scene with a single step", () => {
		const scene = sceneWith([
			{
				do: [
					{
						t: "Effects",
						effects: [{ t: "GrantItem", name: "Ledger", description: "Damp.", quantity: 1 }],
					},
				],
			},
		]);
		expect(sceneEffectProblems(scene)).toEqual([]);
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/core/rules/scene-check.test.ts
```

Expected: FAIL — cannot resolve `./scene-check.js`.

- [ ] **Step 3: Write the implementation**

```ts
import type { DomainEffect } from "./effects.js";
import type { Scene } from "./scene.js";

/**
 * Effects that must not happen twice.
 *
 * A save is never written mid-scene, so an interrupted scene replays from its first
 * step — which means every effect before the last step may be applied more than once
 * over the life of a save. Most of `DomainEffect` is idempotent by construction:
 * `SetFlag` writes a value, `ShowCard` is ignored once read, `OpenBarrier` checks the
 * flag first. These are the ones that accumulate, and a scene that grants a ledger in
 * its third step of five hands out a second one to any player who quits at the wrong
 * moment.
 *
 * The last step is exempt because reaching it is what writes the trigger's fired flag,
 * so a scene that got that far never runs again.
 */
export const REPEATABLE_EFFECTS: ReadonlySet<DomainEffect["t"]> = new Set([
	"GrantItem",
	"TakeItem",
	"AdjustGold",
	"Damage",
	"Heal",
	"AdjustDisposition",
	"AdjustReputation",
]);

/** How an effect should be named in a complaint about it. */
function subject(effect: DomainEffect): string {
	if (effect.t === "GrantItem" || effect.t === "TakeItem") return `"${effect.name}"`;
	if (effect.t === "AdjustDisposition") return `"${effect.npcId}"`;
	if (effect.t === "AdjustReputation") return `"${effect.faction}"`;
	return `${effect.t}`;
}

const VERBS: Readonly<Record<string, string>> = {
	GrantItem: "grants",
	TakeItem: "takes",
	AdjustGold: "adjusts gold in",
	Damage: "damages the player in",
	Heal: "heals the player in",
	AdjustDisposition: "adjusts disposition toward",
	AdjustReputation: "adjusts reputation with",
};

export function sceneEffectProblems(scene: Scene): string[] {
	const problems: string[] = [];
	const last = scene.steps.length - 1;

	scene.steps.forEach((step, index) => {
		if (index === last) return;
		for (const action of step.do) {
			if (action.t !== "Effects") continue;
			for (const effect of action.effects) {
				if (!REPEATABLE_EFFECTS.has(effect.t)) continue;
				const verb = VERBS[effect.t] ?? "applies";
				problems.push(
					`scene ${scene.id} ${verb} ${subject(effect)} in step ${index + 1} of ${scene.steps.length}; ` +
						`an interrupted scene replays, so ${effect.t} may only appear in the last step`,
				);
			}
		}
	});

	return problems;
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run src/core/rules/scene-check.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/rules/scene-check.ts src/core/rules/scene-check.test.ts
git commit -m "Refuse a scene that hands out the ledger twice"
```

---

### Task 4: Wire scenes into the reducer

**Files:**
- Modify: `src/core/rules/commands.ts`, `src/core/rules/effects.ts`,
  `src/core/rules/state.ts`, `src/core/rules/trigger.ts`, `src/core/rules/reduce.ts`
- Test: `src/core/rules/scene-reduce.test.ts`, `src/core/rules/trigger.test.ts` (extend)

**Interfaces:**
- Consumes: `advanceScene`, `beginScene`, `SceneState`, `StagedScene` from `./scene.js`.
- Produces:
  - `Command` gains `{ t: "SceneFrame" }` and `{ t: "SkipScene" }`
  - `DomainEffect` gains `{ t: "PlayScene"; id: string }`
  - `GameState` gains `readonly scene?: SceneState` and
    `readonly scenes?: Readonly<Record<string, Scene>>`
  - `WorldProbe` gains `stagedScene?(id: string): StagedScene | undefined`
  - `function playsAScene(effects: readonly DomainEffect[]): boolean` exported from
    `./trigger.js`

- [ ] **Step 1: Write the failing test**

Create `src/core/rules/scene-reduce.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { reduce } from "./reduce.js";
import type { StagedScene } from "./scene.js";
import { createInitialState, type GameState } from "./state.js";
import { triggerKey } from "./trigger.js";

const OPEN: StagedScene = {
	id: "the-messenger-arrives",
	skippable: true,
	steps: [
		{ do: [{ t: "Camera", to: { x: 9, y: 9 }, pan: "cut" }] },
		{ do: [{ t: "Say", actor: "player", text: "The abbey has fallen." }] },
		{ do: [{ t: "Effects", effects: [{ t: "SetFlag", key: "chapter", value: 2 }] }] },
	],
};

/** A probe that lets the player walk anywhere and knows one scene. */
const world = {
	isPassable: () => true,
	isLoaded: () => true,
	npcAt: () => undefined,
	stagedScene: (id: string) => (id === OPEN.id ? OPEN : undefined),
};

function start(): GameState {
	const base = createInitialState(
		{ id: "w", name: "W", seed: 1, createdAt: "" },
		{ x: 5, y: 5 },
	);
	return {
		...base,
		triggers: [
			{
				id: "arrive",
				when: { flag: "ready" },
				effects: [{ t: "PlayScene", id: OPEN.id }],
			},
		],
		flags: { ready: true },
	};
}

describe("scenes in the reducer", () => {
	it("opens the scene the trigger asked for", () => {
		const { state } = reduce(start(), { t: "SceneFrame" }, world);
		expect(state.scene?.id).toBe(OPEN.id);
	});

	it("swallows movement while a scene is playing", () => {
		const opened = reduce(start(), { t: "SceneFrame" }, world).state;
		const moved = reduce(opened, { t: "Move", facing: "right" }, world).state;
		expect(moved.player.x).toBe(opened.player.x);
	});

	it("leaves the trigger unfired until the scene finishes", () => {
		let state = reduce(start(), { t: "SceneFrame" }, world).state;
		expect(state.flags[triggerKey("arrive")]).toBeUndefined();

		for (let frame = 0; frame < 8 && state.scene; frame++) {
			state = reduce(state, { t: "Advance" }, world).state;
			if (state.scene) state = reduce(state, { t: "SceneFrame" }, world).state;
		}

		expect(state.scene).toBeUndefined();
		expect(state.flags[triggerKey("arrive")]).toBe(true);
		expect(state.flags.chapter).toBe(2);
	});

	it("does not replay a scene whose trigger has fired", () => {
		let state = reduce(start(), { t: "SceneFrame" }, world).state;
		for (let frame = 0; frame < 8 && state.scene; frame++) {
			state = reduce(state, { t: "Advance" }, world).state;
			if (state.scene) state = reduce(state, { t: "SceneFrame" }, world).state;
		}
		const after = reduce(state, { t: "SceneFrame" }, world).state;
		expect(after.scene).toBeUndefined();
	});

	it("marks the trigger fired when the player skips", () => {
		const opened = reduce(start(), { t: "SceneFrame" }, world).state;
		const skipped = reduce(opened, { t: "SkipScene" }, world).state;
		expect(skipped.scene).toBeUndefined();
		expect(skipped.flags[triggerKey("arrive")]).toBe(true);
	});

	it("still applies a skipped scene's effects, so skipping cannot break the story", () => {
		const opened = reduce(start(), { t: "SceneFrame" }, world).state;
		const skipped = reduce(opened, { t: "SkipScene" }, world).state;
		expect(skipped.flags.chapter).toBe(2);
	});

	it("holds the save back while a scene is playing", () => {
		const opened = reduce(start(), { t: "SceneFrame" }, world);
		expect(opened.effects.some((effect) => effect.t === "Save")).toBe(false);
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/core/rules/scene-reduce.test.ts
```

Expected: FAIL — `SceneFrame` is not assignable to `Command`.

- [ ] **Step 3: Extend the alphabets**

In `src/core/rules/commands.ts`, add to the `Command` union:

```ts
	/**
	 * One frame of a playing scene.
	 *
	 * Its own command rather than `Tick` because `tick` is an action counter that drives
	 * the hour, the weather and every NPC's schedule — a three-second cutscene run off it
	 * would burn an hour of daylight. Dispatched by the UI on an interval for as long as
	 * `state.scene` is set, and ignored when it is not.
	 */
	| { readonly t: "SceneFrame" }
	/** End a playing scene early. Its effects still apply — see `reduce`. */
	| { readonly t: "SkipScene" }
```

In `src/core/rules/effects.ts`, add to `DomainEffect`:

```ts
	/**
	 * Take the world over and play something.
	 *
	 * Ignored when a scene is already playing, and when this one has already been played:
	 * a scene is identified by the trigger that opened it, and that trigger's flag is
	 * written when the scene *finishes*. See `sceneEffectProblems` for why that matters.
	 */
	| { readonly t: "PlayScene"; readonly id: string }
```

In `src/core/rules/state.ts`, add to `GameState`:

```ts
	/**
	 * The scene playing right now, if any.
	 *
	 * Deliberately not persisted. The save is held back while a scene runs, so an
	 * interrupted scene replays from its first step rather than resuming from a
	 * half-applied middle — which is far cheaper than making every step resumable, and a
	 * scene is seconds long.
	 */
	readonly scene?: SceneState;
	/**
	 * The scenes this world can play, by id.
	 *
	 * Persisted, like the arc and the triggers and for the same reason: a world whose
	 * scenes went missing stops telling its story silently, with nothing on screen to say
	 * why.
	 */
	readonly scenes?: Readonly<Record<string, Scene>>;
```

- [ ] **Step 4: Defer the trigger's flag**

In `src/core/rules/trigger.ts`, export the test and use it in `pendingTriggers`:

```ts
/**
 * Whether these effects hand the world over to a scene.
 *
 * A trigger that plays a scene must not be marked fired when it fires, only when the
 * scene it started has finished — otherwise a player who quits halfway through has a
 * world that believes the scene has happened and will never play it again. The scene
 * player writes the flag instead; see `reduce`.
 */
export function playsAScene(effects: readonly DomainEffect[]): boolean {
	return effects.some((effect) => effect.t === "PlayScene");
}
```

and in `pendingTriggers`, replace the flag push with:

```ts
		// Set last, so a partially-applied trigger is retried rather than skipped —
		// the rule `beatEffects` follows, and for the same failure.
		if (once && !playsAScene(trigger.effects))
			effects.push({ t: "SetFlag", key: triggerKey(trigger.id), value: true });
```

- [ ] **Step 5: Handle the scene in the reducer**

In `src/core/rules/reduce.ts`:

Add to `WorldProbe`:

```ts
	/**
	 * A scene with its points resolved and its walks pathfound.
	 *
	 * Staged by the engine, which has the world; the reducer only ever plays what it is
	 * handed. That is what keeps the scene machine pure and its tests free of a world.
	 */
	stagedScene?(id: string): StagedScene | undefined;
```

Add the input lock and the frame handling at the top of `reduce`, before `step` is
called:

```ts
export function reduce(state: GameState, command: Command, world: WorldProbe): Reduction {
	// A scene has the world. Everything the player could otherwise do is swallowed here
	// rather than guarded in each handler, because the list of things that must not happen
	// mid-cutscene is "all of them" and a new command should join that list by default.
	if (state.scene) return duringScene(state, command, world);

	// A notice reports what just happened, so whatever happens next clears it —
	// otherwise "You find 3 Timber." sits under the map for the rest of the game.
	const result = step(withoutNotice(state), command, world);
	...
```

Then add, near `settle`:

```ts
/**
 * What a command means while a scene is playing.
 *
 * Three things get through: a frame advances it, the advance key gets past a line of
 * dialogue, and a skip ends it. Everything else — movement, interaction, opening a
 * panel — is dropped, and the save is held back so that an interruption replays the
 * scene rather than resuming a half-applied one.
 */
function duringScene(state: GameState, command: Command, world: WorldProbe): Reduction {
	const scene = state.scene as SceneState;
	const staged = world.stagedScene?.(scene.id);
	// A scene whose staging has gone is a scene that cannot be played. Ending it is the
	// only honest option: leaving it up would lock the player out of their own game.
	if (!staged) return { state: closeScene(state, scene.id), effects: [] };

	if (command.t === "SkipScene") {
		if (!staged.skippable) return { state, effects: [] };
		// Skipping must not skip the *consequences*. A scene is where a chapter turns, so
		// a player who has seen enough of the prose still gets everything it changed.
		const remaining = remainingEffects(staged, scene.step);
		const applied = applyEffects(closeScene(state, scene.id), remaining);
		return { state: applied.state, effects: [{ t: "Save", reason: "checkpoint" }] };
	}

	if (command.t !== "SceneFrame" && command.t !== "Advance" && command.t !== "Confirm") {
		return { state, effects: [] };
	}

	const outcome = advanceScene(staged, scene, {
		advance: command.t === "Advance" || command.t === "Confirm",
	});
	const applied = applyEffects(state, outcome.effects);
	if (outcome.scene) {
		return { state: { ...applied.state, scene: outcome.scene }, effects: [] };
	}
	return {
		state: closeScene(applied.state, scene.id),
		effects: [{ t: "Save", reason: "checkpoint" }],
	};
}

/**
 * Take the scene down and record that whatever opened it is done.
 *
 * The flag is written here rather than by `pendingTriggers` so that only a scene that
 * actually reached its end counts as having happened.
 */
function closeScene(state: GameState, sceneId: string): GameState {
	const fired = (state.triggers ?? []).filter(
		(trigger) =>
			(trigger.once ?? true) &&
			trigger.effects.some((effect) => effect.t === "PlayScene" && effect.id === sceneId),
	);
	const flags = { ...state.flags };
	for (const trigger of fired) flags[triggerKey(trigger.id)] = true;
	const { scene: gone, ...rest } = state;
	void gone;
	return { ...rest, flags };
}

/** Every effect a scene has not applied yet, from this step onwards. */
function remainingEffects(staged: StagedScene, from: number): DomainEffect[] {
	const effects: DomainEffect[] = [];
	for (const step of staged.steps.slice(from)) {
		for (const action of step.do) {
			if (action.t === "Effects") effects.push(...action.effects);
			if (action.t === "Card") effects.push({ t: "ShowCard", card: action.card });
		}
	}
	return effects;
}
```

Add `PlayScene` to `applyEffect`:

```ts
		case "PlayScene":
			// The staged scene is not available here — `applyEffect` has no probe — so this
			// records the *intent* and `settle` opens it on the next pass, which is also
			// where the guard against replaying a finished scene lives.
			return state.scene ? state : { ...state, pendingScene: effect.id };
```

Rather than adding a second piece of state, prefer opening it directly in `settle`,
which does have the probe. Replace the `PlayScene` case with:

```ts
		case "PlayScene":
			// Nothing here: `settle` has the probe this needs, and opening a scene requires
			// staging it. See `openPendingScene`.
			return state;
```

and in `settle`, after the `fired` block, add:

```ts
		// A scene opens after the pass that asked for it, so that everything else the
		// trigger did — a flag set, an item granted — is already true when the first frame
		// of the scene runs.
		const opening = openPendingScene(current, fired.effectsApplied, world);
		if (opening) {
			current = opening;
			notable = true;
			break;
		}
```

Because `applyEffects` does not currently report which effects it applied, the simplest
correct wiring is to scan the effect list before applying it. In `settle`, replace the
`fired` block with:

```ts
		const due = [
			...beatsOpenedByState(current.arc, current).flatMap(beatEffects),
			...pendingTriggers(current.triggers, current),
		];
		const fired = applyEffects(current, due);
		if (fired.state === current && due.length === 0) break;
		current = fired.state;
		notable = true;

		// A scene opens after the pass that asked for it, so everything else that pass did
		// is already true when its first frame runs.
		const asked = due.find((effect) => effect.t === "PlayScene");
		if (asked && asked.t === "PlayScene" && !current.scene) {
			const staged = world.stagedScene?.(asked.id);
			if (staged) {
				current = {
					...current,
					scene: beginScene(
						staged,
						{ x: current.player.x, y: current.player.y },
						current.player.facing,
					),
				};
				break;
			}
		}
		if (fired.state === current) break;
```

Read the existing `settle` loop carefully before editing — the `if (fired.state ===
current) break;` guard must remain the loop's exit, and the new code goes between the
assignment and that guard.

- [ ] **Step 6: Run the new tests**

```bash
npx vitest run src/core/rules/scene-reduce.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 7: Add the trigger-deferral test to the existing suite**

Append to `src/core/rules/trigger.test.ts`:

```ts
it("does not mark a scene-playing trigger fired when it fires", () => {
	const state = stateWithFlags({ ready: true });
	const effects = pendingTriggers(
		[{ id: "arrive", when: { flag: "ready" }, effects: [{ t: "PlayScene", id: "s" }] }],
		state,
	);
	expect(effects).toEqual([{ t: "PlayScene", id: "s" }]);
});
```

Use whatever helper the file already has for building a state with flags; read the top of
the file to find its name rather than assuming `stateWithFlags`.

- [ ] **Step 8: Full check**

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Give a scene the world, and give it back when the scene is over"
```

---

### Task 5: Phase diff composition

**Files:**
- Create: `src/scenario/phase.ts`
- Test: `src/scenario/phase.test.ts`

**Interfaces:**
- Consumes: `Condition`, `evaluate` from `../core/rules/condition.js`; `Placement`,
  `Sign`, `AuthoredBarrier`, `Trigger`, `SiteSpec`, `ScenarioBeat`, `DialogueTree`.
- Produces:
  - `interface Diff<T> { add?, remove?, replace? }`
  - `interface Phase { id, name, when?, sites?, placements?, signs?, barriers?, triggers?, terraform?, trees?, beats? }`
  - `interface ScenarioContent { sites, placements, signs, barriers, triggers, terraform, trees, beats }`
  - `function enteredPhaseIds(phases: readonly Phase[], state: GameState): string[]`
  - `function composeScenario(base: ScenarioContent, phases: readonly Phase[], state: GameState): ScenarioContent`
  - `function phaseProblems(base: ScenarioContent, phases: readonly Phase[]): string[]`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { createInitialState, type GameState } from "../core/rules/state.js";
import { composeScenario, enteredPhaseIds, type Phase, phaseProblems, type ScenarioContent } from "./phase.js";

function state(flags: Record<string, string | number | boolean>): GameState {
	const base = createInitialState({ id: "w", name: "W", seed: 1, createdAt: "" }, { x: 0, y: 0 });
	return { ...base, flags };
}

const EMPTY: ScenarioContent = {
	sites: {},
	placements: [],
	signs: [],
	barriers: [],
	triggers: [],
	terraform: [],
	trees: {},
	beats: [],
};

function withPlacements(...ids: string[]): ScenarioContent {
	return {
		...EMPTY,
		placements: ids.map((id) => ({
			id,
			at: { kind: "world" as const, x: 0, y: 0 },
			item: { name: id, description: "A thing." },
		})),
	};
}

describe("enteredPhaseIds", () => {
	it("always includes a phase with no condition", () => {
		const phases: Phase[] = [{ id: "1-base", name: "The Quiet Vale" }];
		expect(enteredPhaseIds(phases, state({}))).toEqual(["1-base"]);
	});

	it("includes a conditional phase only once its condition holds", () => {
		const phases: Phase[] = [
			{ id: "1-base", name: "Before" },
			{ id: "2-after", name: "After", when: { flag: "flood" } },
		];
		expect(enteredPhaseIds(phases, state({}))).toEqual(["1-base"]);
		expect(enteredPhaseIds(phases, state({ flood: true }))).toEqual(["1-base", "2-after"]);
	});
});

describe("composeScenario", () => {
	it("adds what a phase adds", () => {
		const composed = composeScenario(
			withPlacements("ledger"),
			[{ id: "2", name: "After", when: { flag: "flood" }, placements: { add: [{ id: "body", at: { kind: "world", x: 1, y: 1 }, item: { name: "body", description: "Drowned." } }] } }],
			state({ flood: true }),
		);
		expect(composed.placements.map((p) => p.id)).toEqual(["ledger", "body"]);
	});

	it("leaves the base alone when the phase has not been entered", () => {
		const base = withPlacements("ledger");
		const composed = composeScenario(
			base,
			[{ id: "2", name: "After", when: { flag: "flood" }, placements: { add: [{ id: "body", at: { kind: "world", x: 1, y: 1 }, item: { name: "body", description: "Drowned." } }] } }],
			state({}),
		);
		expect(composed.placements.map((p) => p.id)).toEqual(["ledger"]);
	});

	it("removes what a phase removes", () => {
		const composed = composeScenario(
			withPlacements("ledger", "lantern"),
			[{ id: "2", name: "After", when: { flag: "flood" }, placements: { remove: ["lantern"] } }],
			state({ flood: true }),
		);
		expect(composed.placements.map((p) => p.id)).toEqual(["ledger"]);
	});

	it("replaces by id, keeping position", () => {
		const composed = composeScenario(
			withPlacements("ledger", "lantern"),
			[
				{
					id: "2",
					name: "After",
					when: { flag: "flood" },
					placements: {
						replace: [
							{ id: "ledger", at: { kind: "world", x: 9, y: 9 }, item: { name: "Ledger", description: "Sodden." } },
						],
					},
				},
			],
			state({ flood: true }),
		);
		expect(composed.placements[0]?.item.description).toBe("Sodden.");
		expect(composed.placements.map((p) => p.id)).toEqual(["ledger", "lantern"]);
	});

	it("removes a conversation when a phase maps it to null", () => {
		const base: ScenarioContent = {
			...EMPTY,
			trees: {
				"1-0": { npcId: "1-0", nodes: {}, opening: [] } as never,
				"1-1": { npcId: "1-1", nodes: {}, opening: [] } as never,
			},
		};
		const composed = composeScenario(
			base,
			[{ id: "2", name: "After", when: { flag: "flood" }, trees: { "1-1": null } }],
			state({ flood: true }),
		);
		expect(Object.keys(composed.trees)).toEqual(["1-0"]);
	});

	it("applies phases in order, so a later one wins", () => {
		const composed = composeScenario(
			withPlacements("ledger"),
			[
				{ id: "2", name: "Two", when: { flag: "a" }, placements: { remove: ["ledger"] } },
				{
					id: "3",
					name: "Three",
					when: { flag: "b" },
					placements: { add: [{ id: "ledger", at: { kind: "world", x: 5, y: 5 }, item: { name: "Ledger", description: "Found again." } }] },
				},
			],
			state({ a: true, b: true }),
		);
		expect(composed.placements.map((p) => p.item.description)).toEqual(["Found again."]);
	});
});

describe("phaseProblems", () => {
	it("refuses a removal of something that is not there", () => {
		const problems = phaseProblems(withPlacements("ledger"), [
			{ id: "2", name: "After", placements: { remove: ["lantern"] } },
		]);
		expect(problems).toEqual(['phase 2 removes placement "lantern", which nothing adds']);
	});

	it("refuses a replacement of something that is not there", () => {
		const problems = phaseProblems(withPlacements("ledger"), [
			{
				id: "2",
				name: "After",
				placements: {
					replace: [{ id: "lantern", at: { kind: "world", x: 0, y: 0 }, item: { name: "l", description: "d" } }],
				},
			},
		]);
		expect(problems).toEqual(['phase 2 replaces placement "lantern", which nothing adds']);
	});

	it("accepts a removal of something an earlier phase added", () => {
		const problems = phaseProblems(EMPTY, [
			{
				id: "2",
				name: "Two",
				placements: { add: [{ id: "body", at: { kind: "world", x: 0, y: 0 }, item: { name: "b", description: "d" } }] },
			},
			{ id: "3", name: "Three", placements: { remove: ["body"] } },
		]);
		expect(problems).toEqual([]);
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/scenario/phase.test.ts
```

Expected: FAIL — cannot resolve `./phase.js`.

- [ ] **Step 3: Write `src/scenario/phase.ts`**

```ts
import type { DialogueTree } from "../ai/dialogue/tree.js";
import { type Condition, evaluate } from "../core/rules/condition.js";
import type { AuthoredBarrier } from "../core/rules/lock.js";
import type { Placement } from "../core/rules/placement.js";
import type { Sign } from "../core/rules/signage.js";
import type { GameState } from "../core/rules/state.js";
import type { Trigger } from "../core/rules/trigger.js";
import type { ScenarioBeat } from "../core/rules/arc.js";
import type { SiteSpec } from "../core/world/spec.js";
import type { TerraformEdit } from "./terraform.js";

/**
 * What changes between one part of a story and the next.
 *
 * A diff rather than a snapshot, and the reason is a failure mode rather than a
 * preference: with snapshots, a correction made to the first chapter silently fails to
 * reach the second and third, which is exactly the drift this whole format exists to
 * remove. The cost is composition rules, and they are the twenty lines below.
 */
export interface Diff<T> {
	readonly add?: readonly T[];
	/** By id. Removing something nothing adds is an error — see {@link phaseProblems}. */
	readonly remove?: readonly string[];
	/** By id: same id, new content, same position in the list. */
	readonly replace?: readonly T[];
}

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
	/** Replaces a conversation wholesale. `null` takes it away. */
	readonly trees?: Readonly<Record<string, DialogueTree | null>>;
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
	readonly beats: readonly ScenarioBeat[];
}

/**
 * Which phases are in force, in file order.
 *
 * Derived from state and never stored. That is what makes a phase file something you
 * can correct while a save is in flight: nothing on disk remembers which chapter a
 * player is in, only the flags that put them there.
 */
export function enteredPhaseIds(phases: readonly Phase[], state: GameState): string[] {
	return phases.filter((phase) => !phase.when || evaluate(phase.when, state)).map((p) => p.id);
}

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
			trees: applyTrees(content.trees, phase.trees),
			beats: phase.beats ? [...content.beats, ...phase.beats] : content.beats,
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
	// Replacements keep their position rather than moving to the end, so that a scenario
	// whose placements collide resolves the same way before and after a phase — the
	// resolver's tie-break is list order.
	const kept = current.filter((item) => !gone.has(item.id)).map((item) => swapped.get(item.id) ?? item);
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

function applyTrees(
	current: Readonly<Record<string, DialogueTree>>,
	diff: Readonly<Record<string, DialogueTree | null>> | undefined,
): Readonly<Record<string, DialogueTree>> {
	if (!diff) return current;
	const next: Record<string, DialogueTree> = { ...current };
	for (const [key, tree] of Object.entries(diff)) {
		if (tree === null) delete next[key];
		else next[key] = tree;
	}
	return next;
}

/**
 * Whether every diff has something to act on.
 *
 * A diff that quietly does nothing because the base was rewritten underneath it is the
 * silent failure that snapshots would have produced, arriving by another door — the
 * chapter loads, the door that was meant to open stays shut, and nothing reports it.
 * Checked against the *union* of the base and everything earlier phases add, because a
 * phase removing what the phase before it introduced is perfectly ordinary.
 */
export function phaseProblems(base: ScenarioContent, phases: readonly Phase[]): string[] {
	const problems: string[] = [];
	const known = {
		site: new Set(Object.keys(base.sites)),
		placement: new Set(base.placements.map((p) => p.id)),
		sign: new Set(base.signs.map((s) => s.id)),
		barrier: new Set(base.barriers.map((b) => b.id)),
		trigger: new Set(base.triggers.map((t) => t.id)),
		terraform: new Set(base.terraform.map((t) => t.id)),
	};

	const check = <T extends { readonly id: string }>(
		phase: Phase,
		label: keyof typeof known,
		diff: Diff<T> | undefined,
	) => {
		if (!diff) return;
		for (const id of [...(diff.remove ?? []), ...(diff.replace ?? []).map((i) => i.id)]) {
			if (!known[label].has(id))
				problems.push(
					`phase ${phase.id} ${diff.remove?.includes(id) ? "removes" : "replaces"} ${label} "${id}", which nothing adds`,
				);
		}
		for (const id of diff.remove ?? []) known[label].delete(id);
		for (const item of diff.add ?? []) known[label].add(item.id);
	};

	for (const phase of phases) {
		check(phase, "placement", phase.placements);
		check(phase, "sign", phase.signs);
		check(phase, "barrier", phase.barriers);
		check(phase, "trigger", phase.triggers);
		check(phase, "terraform", phase.terraform);
		if (phase.sites) {
			for (const id of phase.sites.remove ?? []) {
				if (!known.site.has(id))
					problems.push(`phase ${phase.id} removes site "${id}", which nothing adds`);
				known.site.delete(id);
			}
			for (const spec of phase.sites.add ?? []) known.site.add(String(spec.siteId));
		}
	}

	return problems;
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run src/scenario/phase.test.ts
```

Expected: PASS, 11 tests. `phase.ts` imports `./terraform.js`, which Task 6 creates — so
create a minimal `src/scenario/terraform.ts` now with just the type, and Task 6 fills in
the rasteriser:

```ts
export interface Point {
	readonly x: number;
	readonly y: number;
}

/** An authored change to the ground the generator produced. */
export type TerraformEdit =
	| {
			readonly t: "Path";
			readonly id: string;
			readonly from: Point;
			readonly to: Point;
			readonly width?: number;
			readonly surface: "dirt" | "cobble" | "plank";
	  }
	| { readonly t: "Bridge"; readonly id: string; readonly from: Point; readonly to: Point }
	| { readonly t: "Clearing"; readonly id: string; readonly at: Point; readonly radius: number };
```

- [ ] **Step 5: Commit**

```bash
git add src/scenario/phase.ts src/scenario/phase.test.ts src/scenario/terraform.ts
git commit -m "Compose a world out of a base and the chapters that have happened"
```

---

### Task 6: Terraform stamps reach the generator

**Files:**
- Modify: `src/scenario/terraform.ts` (add `terraformBounds`)
- Create: `src/core/gen/features/authored.ts`
- Modify: `src/core/gen/pipeline.ts`, `src/engine/chunk-manager.ts`
- Test: `src/core/gen/features/authored.test.ts`

**Interfaces:**
- Consumes: `TerraformEdit`, `Point` from `../../../scenario/terraform.js`; `T` from
  `../../tiles/terrain.js`; `FeaturePatch`, `patchIndex` from `./patch.js`.
- Produces:
  - `function authoredTiles(edits: readonly TerraformEdit[]): Map<string, number>` —
    world position `"x,y"` to terrain id
  - `function terraformBounds(edits: readonly TerraformEdit[]): { x, y, w, h } | undefined`
  - `GenContext` gains `readonly terraform?: readonly TerraformEdit[]`
  - `ChunkManagerOptions` gains `readonly terraform?: readonly TerraformEdit[]`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { T } from "../../tiles/terrain.js";
import { authoredTiles } from "./authored.js";

describe("authoredTiles", () => {
	it("lays a straight path one tile wide by default", () => {
		const tiles = authoredTiles([
			{ t: "Path", id: "lane", from: { x: 0, y: 0 }, to: { x: 3, y: 0 }, surface: "dirt" },
		]);
		expect([...tiles.keys()].sort()).toEqual(["0,0", "1,0", "2,0", "3,0"]);
	});

	it("widens a path symmetrically", () => {
		const tiles = authoredTiles([
			{ t: "Path", id: "lane", from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, width: 3, surface: "dirt" },
		]);
		expect(tiles.has("0,-1")).toBe(true);
		expect(tiles.has("0,0")).toBe(true);
		expect(tiles.has("0,1")).toBe(true);
	});

	it("steps a diagonal path so it stays connected", () => {
		const tiles = authoredTiles([
			{ t: "Path", id: "lane", from: { x: 0, y: 0 }, to: { x: 2, y: 2 }, surface: "dirt" },
		]);
		// No two consecutive tiles may be diagonal neighbours, or the player cannot walk it.
		const positions = [...tiles.keys()].map((key) => key.split(",").map(Number));
		for (const [x, y] of positions) {
			const orthogonal = positions.filter(
				([ox, oy]) => Math.abs((ox as number) - (x as number)) + Math.abs((oy as number) - (y as number)) === 1,
			);
			expect(orthogonal.length).toBeGreaterThan(0);
		}
	});

	it("gives each surface its own terrain", () => {
		const dirt = authoredTiles([
			{ t: "Path", id: "a", from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, surface: "dirt" },
		]);
		const cobble = authoredTiles([
			{ t: "Path", id: "b", from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, surface: "cobble" },
		]);
		expect(dirt.get("0,0")).not.toBe(cobble.get("0,0"));
	});

	it("makes a bridge out of planks", () => {
		const tiles = authoredTiles([
			{ t: "Bridge", id: "span", from: { x: 0, y: 0 }, to: { x: 2, y: 0 } },
		]);
		expect(tiles.get("1,0")).toBe(T.bridge);
	});

	it("clears a disc of ground", () => {
		const tiles = authoredTiles([{ t: "Clearing", id: "glade", at: { x: 0, y: 0 }, radius: 1 }]);
		expect([...tiles.keys()].sort()).toEqual(["-1,0", "0,-1", "0,0", "0,1", "1,0"]);
	});

	it("lets a later edit win where two overlap", () => {
		const tiles = authoredTiles([
			{ t: "Path", id: "lane", from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, surface: "dirt" },
			{ t: "Bridge", id: "span", from: { x: 0, y: 0 }, to: { x: 0, y: 0 } },
		]);
		expect(tiles.get("0,0")).toBe(T.bridge);
	});
});
```

Before writing the implementation, check the real terrain ids:

```bash
TOKENSAVE_DISABLE_GREP_HOOK=1 grep -nE "bridge|cobble|path|dirt|plank|road" src/core/tiles/terrain.ts | head -20
```

Use the ids that actually exist. If there is no `T.bridge`, use the closest wooden
walkable terrain and say so in a comment; if there is no distinct cobble, map `cobble`
to the road terrain the generator already uses for streets. Adjust the test's expected
values to the real ids — the test asserting `dirt !== cobble` is the one that matters,
not the specific numbers.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/core/gen/features/authored.test.ts
```

Expected: FAIL — cannot resolve `./authored.js`.

- [ ] **Step 3: Write `src/core/gen/features/authored.ts`**

```ts
import { line } from "../../geom/line.js";
import { T, type TerrainId } from "../../tiles/terrain.js";
import type { TerraformEdit } from "../../../scenario/terraform.js";

/**
 * Ground an author asked for, over ground the generator produced.
 *
 * Deliberately a flat map from world position to terrain rather than a list of shapes:
 * two edits that overlap have to resolve to one tile, and the only rule that an author
 * can predict is that the later one wins. Rasterising up front makes that rule the
 * data's rather than the renderer's.
 */
export function authoredTiles(edits: readonly TerraformEdit[]): Map<string, TerrainId> {
	const tiles = new Map<string, TerrainId>();
	for (const edit of edits) {
		switch (edit.t) {
			case "Path": {
				const terrain = SURFACES[edit.surface];
				const half = Math.floor(((edit.width ?? 1) - 1) / 2);
				for (const point of walkable(edit.from, edit.to)) {
					for (let dy = -half; dy <= half; dy++) {
						for (let dx = -half; dx <= half; dx++) {
							tiles.set(`${point.x + dx},${point.y + dy}`, terrain);
						}
					}
				}
				break;
			}
			case "Bridge":
				for (const point of walkable(edit.from, edit.to)) {
					tiles.set(`${point.x},${point.y}`, BRIDGE);
				}
				break;
			case "Clearing":
				for (let dy = -edit.radius; dy <= edit.radius; dy++) {
					for (let dx = -edit.radius; dx <= edit.radius; dx++) {
						if (Math.abs(dx) + Math.abs(dy) > edit.radius) continue;
						tiles.set(`${edit.at.x + dx},${edit.at.y + dy}`, T.grass);
					}
				}
				break;
		}
	}
	return tiles;
}

/**
 * A line the player can actually walk.
 *
 * Bresenham gives the visually straightest line, which for a diagonal is a staircase of
 * *diagonal* steps — and movement is four-directional, so such a path is a row of tiles
 * touching only at their corners. Every diagonal step is therefore expanded into two
 * orthogonal ones.
 */
function walkable(
	from: { readonly x: number; readonly y: number },
	to: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number }[] {
	const points = line(from.x, from.y, to.x, to.y);
	const out: { x: number; y: number }[] = [];
	for (const point of points) {
		const last = out[out.length - 1];
		if (last && last.x !== point.x && last.y !== point.y) out.push({ x: point.x, y: last.y });
		out.push({ x: point.x, y: point.y });
	}
	return out;
}

const SURFACES: Readonly<Record<"dirt" | "cobble" | "plank", TerrainId>> = {
	dirt: T.dirt,
	cobble: T.road,
	plank: T.bridge,
};

const BRIDGE: TerrainId = T.bridge;

/**
 * The rectangle a set of edits touches, for invalidating chunks when a phase changes it.
 *
 * Undefined for no edits, which is the common case and lets the caller skip the work
 * rather than invalidating an empty rectangle.
 */
export function terraformBounds(
	edits: readonly TerraformEdit[],
): { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | undefined {
	const tiles = authoredTiles(edits);
	if (tiles.size === 0) return undefined;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const key of tiles.keys()) {
		const [x, y] = key.split(",").map(Number) as [number, number];
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
	}
	return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
```

Check `src/core/geom/line.ts`'s actual export name and signature first:

```bash
TOKENSAVE_DISABLE_GREP_HOOK=1 grep -n "export" src/core/geom/line.ts
```

If it does not export a suitable `line`, write the Bresenham walk inline in `walkable`
rather than adding an export to a geometry module for one caller.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run src/core/gen/features/authored.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Stamp them during generation**

In `src/core/gen/pipeline.ts`, add to `GenContext`:

```ts
	/**
	 * Ground the scenario authored, as tiles to stamp.
	 *
	 * Applied last, over everything the generator decided, for the same reason gates and
	 * signposts are stamped rather than negotiated: the author is stating what is there,
	 * and a stage that could disagree would make the scenario's own map unreliable.
	 */
	readonly terraform?: readonly TerraformEdit[];
```

At the end of `generateChunk`, after the per-tile loop and after the existing barrier and
sign stamping, add a pass that writes the authored tiles that fall in this chunk. Find
how `ctx.barriers` is stamped and follow it exactly — it will be a loop calling
`setTerrain(chunk, lx, ly, id, flags)` for positions inside the chunk. Use
`terrainDef(id).flags` for the flag argument so an authored path is passable for the same
reason every other path is.

Memoise `authoredTiles(ctx.terraform)` outside `generateChunk` keyed on the array
identity, or compute it in `ChunkManager` once and pass the map — recomputing the
rasterisation per chunk would be quadratic in a big world. Prefer passing the map:
change the `GenContext` field to
`readonly terraform?: ReadonlyMap<string, TerrainId>` and have `ChunkManager` build it.

- [ ] **Step 6: Pass it through the chunk manager**

In `src/engine/chunk-manager.ts`, add to `ChunkManagerOptions`:

```ts
	/** Ground the scenario authored. Rasterised once, here, rather than per chunk. */
	readonly terraform?: readonly TerraformEdit[];
```

Build the map once in the constructor and include it in the `generateChunk` context
alongside `barriers` and `signs`, using the same conditional-spread style.

Add a method for phase changes:

```ts
	/**
	 * Point the manager at a new set of authored ground.
	 *
	 * Called when a phase changes the terraform. Drops the chunks the *union* of the old
	 * and new edits touches — the old ones because a removed edit cannot be un-stamped
	 * from a chunk already carrying it, the new ones because they have yet to be stamped
	 * at all.
	 */
	setTerraform(edits: readonly TerraformEdit[]): ChunkKey[]
```

- [ ] **Step 7: Full check**

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Let a scenario lay a path the generator did not think of"
```

---

### Task 7: Scenario directories

**Files:**
- Modify: `src/scenario/artifact.ts`, `src/scenario/schema.ts`, `src/scenario/repo.ts`
- Create: `src/scenario/dir.ts`, `test/fixtures/scenarios/two-phase/` (a real directory)
- Test: `src/scenario/dir.test.ts`

**Interfaces:**
- Consumes: `Phase`, `ScenarioContent`, `phaseProblems` from `./phase.js`; `Scene` from
  `../core/rules/scene.js`; `TerraformEdit` from `./terraform.js`.
- Produces:
  - `ARTIFACT_VERSION = 2`
  - `ScenarioArtifact` gains `readonly phases?: readonly Phase[]`,
    `readonly scenes?: Readonly<Record<string, Scene>>`,
    `readonly terraform?: readonly TerraformEdit[]`
  - `function readScenarioDir(dir: string): ScenarioArtifact | undefined`
  - `function writeScenarioDir(artifact: ScenarioArtifact): string`
  - `repo.ts`'s `loadScenario`, `listScenarios`, `writeScenario` now work on directories

- [ ] **Step 1: Build the fixture directory by hand**

This is the artifact under test for the rest of the plan and the worked example the skill
will point at later. It needs a real seed whose world actually contains two settlements
within a small bounded rectangle. Find one:

```bash
npm run survey -- --help
```

Read `src/tools/survey.ts` for its arguments, then run it over a few seeds until you have
two settlement site ids and their positions inside a bounded rectangle of about 200x200
tiles. Record the seed, the recipe (or none), the bounds, the two site ids and a walkable
spawn point.

Then write the eleven files, using the layout in the spec. The scenario is: the player
starts in the first town, walking into the second town's square triggers a cutscene in
which a rider arrives and announces a flood, and phase 2 adds a placement, removes one
NPC's conversation and lays a path between the towns.

Keep every file minimal but real — this fixture is load-bearing, and a fixture that
cannot fail is worse than none. In particular the terraform path must connect the two
towns, so the end-to-end test in Task 11 can walk it.

- [ ] **Step 2: Write the failing loader test**

```ts
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readScenarioDir } from "./dir.js";

const FIXTURE = join(process.cwd(), "test/fixtures/scenarios/two-phase");

describe("readScenarioDir", () => {
	it("reads a directory into one artifact", () => {
		const artifact = readScenarioDir(FIXTURE);
		expect(artifact?.id).toBe("two-phase");
		expect(artifact?.artifactVersion).toBe(2);
		expect(Object.keys(artifact?.sites ?? {})).toHaveLength(2);
	});

	it("collects the phases in numeric order, not directory order", () => {
		const artifact = readScenarioDir(FIXTURE);
		expect(artifact?.phases?.map((phase) => phase.id)).toEqual([
			"2-after-the-flood",
		]);
	});

	it("keys scenes by filename", () => {
		const artifact = readScenarioDir(FIXTURE);
		expect(Object.keys(artifact?.scenes ?? {})).toContain("the-messenger-arrives");
	});

	it("keys conversations by filename", () => {
		const artifact = readScenarioDir(FIXTURE);
		const keys = Object.keys(artifact?.trees ?? {});
		expect(keys.length).toBeGreaterThan(0);
		for (const key of keys) expect(artifact?.trees?.[key]?.npcId).toBe(key);
	});

	it("refuses a scene whose id disagrees with its filename", () => {
		// Written to a temp copy so the fixture stays valid for every other test.
		// Use `mkdtempSync`, copy the fixture, rewrite one scene's `id`, and expect
		// `readScenarioDir` to return undefined.
	});

	it("refuses a directory with no scenario.json", () => {
		expect(readScenarioDir(join(FIXTURE, "world"))).toBeUndefined();
	});
});
```

Fill in the fifth test properly — it is the one that proves the filename rule is
enforced. Use `node:fs`'s `mkdtempSync`, `cpSync` and `writeFileSync`, and the temp
directory helper already wired up in `test/harness/home.ts` if it fits.

- [ ] **Step 3: Run it and watch it fail**

```bash
npx vitest run src/scenario/dir.test.ts
```

Expected: FAIL — cannot resolve `./dir.js`.

- [ ] **Step 4: Extend the artifact and its schema**

In `src/scenario/artifact.ts`: bump `ARTIFACT_VERSION` to `2` and add the three fields
with doc comments explaining that `phases` is ordered, `scenes` is keyed by id, and
`terraform` is the base phase's authored ground.

In `src/scenario/schema.ts`: add `SceneSchema`, `PhaseSchema`, `DiffSchema` and
`TerraformEditSchema`, and add the new fields to `ScenarioArtifactSchema`. Read the
existing file first and follow its conventions exactly — it will have helpers for capped
text and for optional records. `DiffSchema` is generic over the item schema:

```ts
const diffOf = <T extends z.ZodTypeAny>(item: T) =>
	z.object({
		add: z.array(item).optional(),
		remove: z.array(z.string()).optional(),
		replace: z.array(item).optional(),
	});
```

- [ ] **Step 5: Write `src/scenario/dir.ts`**

`readScenarioDir(dir)` reads `scenario.json`, then `world/sites.json`,
`world/placements.json`, `world/terraform.json`, then every `phases/*.json` sorted by
their numeric prefix, then every `scenes/*.json` and `trees/*.json` keyed by basename.
It validates the whole against `ScenarioArtifactSchema`, runs `verifyArtifact`,
`phaseProblems` and `sceneEffectProblems`, and returns `undefined` with a warning on any
problem — the same contract `readScenarioFile` had, and for the same reason: one bad
scenario must not stop the launcher listing the good ones.

`writeScenarioDir(artifact)` is the inverse. It writes each file with
`writeFileAtomic`, one JSON per file, tab-indented with a trailing newline to match what
`writeScenario` did.

- [ ] **Step 6: Point `repo.ts` at directories**

`scenarioPath(id)` returns `join(scenarioRoot(), id)` — a directory, no extension.
`loadScenario` calls `readScenarioDir`. `listScenarios` iterates directory entries that
are directories rather than files ending in `.json`. `writeScenario` delegates to
`writeScenarioDir`. Keep `verifyArtifact` exactly as it is; it operates on the assembled
artifact and needs no change.

- [ ] **Step 7: Run the loader tests and the repo suite**

```bash
npx vitest run src/scenario/dir.test.ts src/scenario/repo.test.ts
```

Expected: PASS. `repo.test.ts` will need its fixtures rewritten from single files to
directories — do that as part of this step, using `writeScenarioDir` to build them so the
test exercises the round trip.

- [ ] **Step 8: Full check**

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "A scenario becomes a directory you can read a diff of"
```

---

### Task 8: Scene staging

**Files:**
- Create: `src/engine/scene-staging.ts`
- Test: `src/engine/scene-staging.test.ts`

**Interfaces:**
- Consumes: `Scene`, `StagedScene`, `ScenePoint` from `../core/rules/scene.js`;
  `resolvePlacements`, `ResolveOptions` from `./placements.js`; `findPath` from
  `../core/geom/astar.js`.
- Produces:
  - `interface StagingResult { readonly staged?: StagedScene; readonly problems: readonly string[] }`
  - `function stageScene(scene: Scene, options: StageOptions): StagingResult`
  - `interface StageOptions extends ResolveOptions { readonly isPassable: (x, y) => boolean; readonly player: { x, y } }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import type { Scene } from "../core/rules/scene.js";
import { stageScene } from "./scene-staging.js";

/** A 10x10 room with a wall down the middle at x=5, with a gap at y=9. */
const options = {
	world: { seed: 1 } as never,
	siteSpec: () => undefined,
	isPassable: (x: number, y: number) => {
		if (x < 0 || y < 0 || x > 9 || y > 9) return false;
		return x !== 5 || y === 9;
	},
	player: { x: 0, y: 0 },
	bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
};

describe("stageScene", () => {
	it("turns a world point into a plain coordinate", () => {
		const scene: Scene = {
			id: "s",
			steps: [{ do: [{ t: "Spawn", actor: "rider", at: { kind: "world", x: 3, y: 4 } }] }],
		};
		const { staged } = stageScene(scene, options);
		expect(staged?.steps[0]?.do[0]).toEqual({ t: "Spawn", actor: "rider", at: { x: 3, y: 4 } });
	});

	it("precomputes a walk as the tiles it will step onto", () => {
		const scene: Scene = {
			id: "s",
			steps: [
				{ do: [{ t: "Spawn", actor: "rider", at: { kind: "world", x: 0, y: 0 } }] },
				{ do: [{ t: "WalkTo", actor: "rider", to: { kind: "world", x: 3, y: 0 } }] },
			],
		};
		const { staged } = stageScene(scene, options);
		const walk = staged?.steps[1]?.do[0];
		expect(walk).toMatchObject({ t: "WalkTo", actor: "rider" });
		// The tile it starts on is not in the path — only the ones it steps onto.
		expect((walk as { path: { x: number }[] }).path.map((p) => p.x)).toEqual([1, 2, 3]);
	});

	it("routes a walk around a wall rather than through it", () => {
		const scene: Scene = {
			id: "s",
			steps: [
				{ do: [{ t: "Spawn", actor: "rider", at: { kind: "world", x: 4, y: 0 } }] },
				{ do: [{ t: "WalkTo", actor: "rider", to: { kind: "world", x: 6, y: 0 } }] },
			],
		};
		const { staged } = stageScene(scene, options);
		const path = (staged?.steps[1]?.do[0] as { path: { x: number; y: number }[] }).path;
		// The only gap in the wall is at y=9, so the route has to go down and back up.
		expect(path.some((point) => point.y === 9)).toBe(true);
	});

	it("reports a walk with nowhere to go rather than dropping it", () => {
		const scene: Scene = {
			id: "s",
			steps: [
				{ do: [{ t: "Spawn", actor: "rider", at: { kind: "world", x: 0, y: 0 } }] },
				{ do: [{ t: "WalkTo", actor: "rider", to: { kind: "world", x: 50, y: 50 } }] },
			],
		};
		const { staged, problems } = stageScene(scene, options);
		expect(staged).toBeUndefined();
		expect(problems[0]).toContain("rider");
	});

	it("starts the player where the player actually is", () => {
		const scene: Scene = {
			id: "s",
			steps: [{ do: [{ t: "WalkTo", actor: "player", to: { kind: "world", x: 2, y: 0 } }] }],
		};
		const { staged } = stageScene(scene, { ...options, player: { x: 0, y: 0 } });
		expect((staged?.steps[0]?.do[0] as { path: { x: number }[] }).path.map((p) => p.x)).toEqual([1, 2]);
	});

	it("defaults a scene to skippable", () => {
		const { staged } = stageScene({ id: "s", steps: [{ do: [{ t: "Wait", ticks: 1 }] }] }, options);
		expect(staged?.skippable).toBe(true);
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/engine/scene-staging.test.ts
```

Expected: FAIL — cannot resolve `./scene-staging.js`.

- [ ] **Step 3: Write the implementation**

`stageScene` walks the steps in order, keeping a running position per actor so that a
`WalkTo` knows where the actor is standing when it starts. Points are resolved by
reusing the placement resolver: build a throwaway `Placement` for each `ScenePoint` and
call `resolvePlacements` with the same options, which gives site-and-anchor addressing
for free and makes an unresolvable scene point read the same way as an unresolvable
placement.

Walks use `findPath` with `cost: (x, y) => (options.isPassable(x, y) ? 1 : Infinity)` and
`bounds` derived from the world bounds. Drop the first element of the returned path if
`findPath` includes the start — check its behaviour and write the test accordingly rather
than guessing.

Any problem makes the whole staging fail: a scene that plays with one action missing is
worse than one that does not play, because the story silently loses a beat.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run src/engine/scene-staging.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/scene-staging.ts src/engine/scene-staging.test.ts
git commit -m "Look the world up once, so a scene can be pure"
```

---

### Task 9: Engine wiring — composed content and phase entry

**Files:**
- Modify: `src/engine/engine.ts`, `src/session.ts`
- Test: `src/engine/phase-entry.test.ts`

**Interfaces:**
- Consumes: `composeScenario`, `enteredPhaseIds` from `../scenario/phase.js`;
  `stageScene` from `./scene-staging.js`; `terraformBounds` from
  `../core/gen/features/authored.js`.
- Produces: `GameEngine` implements `WorldProbe.stagedScene`, and recomposes content
  when the set of entered phases changes.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
// Build a session over the two-phase fixture, walk the player until the phase-2
// condition holds, and assert three things.
describe("entering a phase", () => {
	it("brings in the placement the phase adds", () => {
		// Set the phase flag directly rather than playing to it — this test is about
		// composition, not about the trigger.
	});
	it("takes away the conversation the phase removes", () => {});
	it("rebuilds the chunks the phase's terraform touches", () => {});
	it("leaves chunks the terraform does not touch resident", () => {});
	it("does not recompose when a flag changes that no phase watches", () => {});
});
```

Write these out properly against the real fixture. The last one matters most: composition
runs after every command, so it must be memoised on the entered-phase set and must not
allocate a new content object per keypress. Assert it by identity —
`expect(after).toBe(before)`.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/engine/phase-entry.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement in the engine**

`GameEngine` holds the base `ScenarioContent`, the phase list, and the last entered-phase
key (the joined ids). After each dispatch it recomputes `enteredPhaseIds`; when the key
changes it recomposes, writes the new placements/signs/barriers/triggers/trees into
state, calls `chunks.setTerraform(...)` if the terraform list changed, and dispatches
`ChunkReady` for the rebuilt keys so the view refreshes.

Add `stagedScene(id)` to the probe the engine passes to `reduce`: look the scene up in
the composed content, stage it, and cache by id. Log and return `undefined` on staging
problems — the reducer already handles a missing staged scene by closing the scene rather
than locking the player out.

**Judgement call to check the passability of after a rebuild:** if the player is standing
on a tile the new terraform made impassable, move them to the nearest passable tile
rather than leaving them stuck. Use the existing spawn-finding helper in
`src/engine/spawn.ts` if it fits.

- [ ] **Step 4: Seed the state in `session.ts`**

`buildSession` currently copies `artifact.placements`, `signs`, `barriers`, `arc` and
`triggers` into the initial state. Change it to compose the base content against the
pristine state first, and add `scenes` and the phase list. Pass `terraform` into
`ChunkManagerOptions`.

- [ ] **Step 5: Run the tests**

```bash
npx vitest run src/engine/phase-entry.test.ts
```

Expected: PASS.

- [ ] **Step 6: Full check**

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Turn a chapter over without rebuilding the world twice"
```

---

### Task 10: The scene on screen

**Files:**
- Create: `src/ui/panels/scene-caption.tsx`
- Modify: `src/ui/app.tsx`
- Test: `src/ui/scene-view.test.tsx`

**Interfaces:**
- Consumes: `SceneState` from `../core/rules/scene.js`; `dispatch`, `useGameSelector`
  from `./store.js`; `cameraCenteredOn` from `./render/camera.js`.
- Produces: a `SceneCaption` component, and an `App` that drives frames, overrides the
  camera, draws scene actors and locks input.

- [ ] **Step 1: Write the failing test**

```tsx
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
// Build an engine over the fixture, force a scene open, render App, and assert:
describe("a scene on screen", () => {
	it("draws the line the scene is saying", () => {});
	it("centres the view on the scene's camera rather than on the player", () => {});
	it("draws an actor the scene spawned", () => {});
	it("stops dispatching frames once the scene is over", () => {});
});
```

Write these against the real components. `src/ui/app.test.tsx` already sets up an engine
and renders `App` with explicit `{ columns: 100, rows: 24 }` — copy that setup. Note that
Ink trims trailing whitespace per row, which is why the existing width test is phrased as
"draws no row wider than the terminal"; do not assert exact row widths.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/ui/scene-view.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Drive the frames**

In `App`, add an effect that starts an interval when `state.scene` is set and clears it
when it is not:

```tsx
	// A scene is the one thing in this game that happens without the player doing
	// anything, so it needs a clock. Its own interval rather than a global one: when no
	// scene is playing there is nothing to tick and the process should be idle.
	const playing = useGameSelector((state) => state.scene !== undefined);
	useEffect(() => {
		if (!playing) return;
		const timer = setInterval(() => dispatch({ t: "SceneFrame" }), SCENE_FRAME_MS);
		timer.unref?.();
		return () => clearInterval(timer);
	}, [playing]);
```

`SCENE_FRAME_MS` of 90 gives a walk of about eleven tiles a second, which reads as
purposeful movement rather than a slideshow or a scramble. Put the constant next to the
effect with that reasoning as its comment.

- [ ] **Step 4: Override the camera**

Where `App` computes `camera` from `cameraFollowing(...)`, take the scene's camera when
there is one. A scene cuts and pans deliberately, so it must not inherit the dead-zone
follow behaviour — use `cameraCenteredOn(sceneCamera, fit.width, fit.height)`.

Interpolate a `pan` by moving the camera a fixed number of tiles per frame toward the
target instead of jumping. Keep that logic in `src/ui/render/camera.ts` as a new pure
function with its own tests, not inline in the component.

- [ ] **Step 5: Draw the actors and the caption**

Scene actors are extra sprites at their scene positions, taking precedence over the
static NPC for the same person so nobody appears twice. Find where `App` gathers NPCs
for the viewport and merge `state.scene.actors` over them.

`SceneCaption` draws `state.scene.caption` as a banner over the world, in the style of
the existing `dialogue-panel.tsx`. Follow that file's layout conventions.

- [ ] **Step 6: Lock the input**

The reducer already swallows commands during a scene, so the UI's job is only to stop
*sending* the ones that would be pointless and to route the two that matter. In the input
handler, when a scene is playing: SPACE and RETURN dispatch `Advance`, ESC dispatches
`SkipScene`, and everything else is ignored.

- [ ] **Step 7: Run the tests**

```bash
npx vitest run src/ui/scene-view.test.tsx src/ui/app.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Full check**

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Show the scene: camera, actors, and a line to read"
```

---

### Task 11: End to end

**Files:**
- Test: `src/scenario/two-phase.test.ts`
- Modify: `src/scenario/walker.ts` if it cannot get through a scene

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new — this is the proof.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

describe("the two-phase fixture", () => {
	it("plays from spawn to the second town and through the cutscene into phase two", () => {
		// Build a session over the fixture. Walk the player to the second town's square,
		// dispatching SceneFrame and Advance as needed to get through the scene. Then
		// assert: the scene has ended, the phase flag is set, the phase-2 placement
		// resolves, and the terraform path tile is walkable.
	});

	it("leaves no save behind while the scene is playing", () => {
		// The reducer holds the save back mid-scene: assert no Save effect is produced
		// between the scene opening and it ending.
	});

	it("does not replay the cutscene when the world is reopened", () => {
		// Play through, save, reload from the save, and assert the scene does not start.
	});

	it("walks the authored path between the towns", () => {
		// findPath over the composed world from town one to town two, and assert the
		// route uses the authored path tiles rather than going cross-country.
	});
});
```

Write these out fully against the fixture. `src/scenario/play.ts` and `walker.ts` already
know how to drive a headless session; read them and use them rather than building a
harness. If `walker.ts` cannot get past a scene — likely, since it predates them — teach
it to dispatch `SceneFrame` and `Advance` while `state.scene` is set, and note in a
comment that a walkthrough must be able to get through a cutscene or every beat behind
one is unreachable.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/scenario/two-phase.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Make it pass**

Fix whatever it finds. This test's whole purpose is to catch the integration mistakes the
unit tests could not, so expect real bugs here rather than a clean pass.

- [ ] **Step 4: Full check**

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 5: Update the documentation**

`docs/scenarios.md` describes the ten-pass authoring pipeline that Task 1 deleted.
Rewrite it to describe the directory format, phases and scenes. Keep it a reference for
someone hand-writing a scenario — that is now the only way one gets written until
sub-project 2 lands.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Prove a directory with two chapters and a cutscene plays"
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: §2 on-disk format → Task 7;
§3 phases → Tasks 5, 9; §4 terraform → Task 6; §5 scenes → Tasks 2, 3, 4, 8, 10; §6
loader → Task 7; §7 testing → the fixture in Task 7 and the suites throughout, with the
end-to-end and chunk-invalidation cases in Tasks 9 and 11; the deletions → Task 1. The
spec's "In scope, and first: the deletions" is Task 1.

**Known gap, deliberately left.** The spec says `craft check` enforces the
non-idempotent-effect rule and the never-live-for-story-NPCs rule. Task 3 builds the
first as a pure function and Task 7 calls it from the loader; there is no `craft` yet, so
sub-project 2 wires it to the CLI. The `--live` rule has no home in this sub-project at
all, because nothing here reads `liveInGame` per NPC — that is sub-project 2's, and the
spec places it there.

**Type consistency.** `Point` is defined in `src/core/rules/scene.ts` and re-declared in
`src/scenario/terraform.ts`; the second should import the first once Task 6 lands, and
Task 6's step 3 does that by importing from `../../../scenario/terraform.js` in one
direction only. Resolve the duplication in favour of `core/rules/scene.ts` being the
home, since `core` may not import from `scenario`. **Task 6 implementer: move `Point` to
`src/core/geom/vec.ts` if a suitable `Vec2` is already there** — check first, and prefer
the existing type.

`ScenarioContent` is produced by Task 5 and consumed by Tasks 7 and 9 with the same eight
fields. `StagedScene` is produced by Task 2, consumed by Tasks 4 and 8. `SceneState` is
produced by Task 2, consumed by Tasks 4 and 10. `terraformBounds` is produced by Task 6
and consumed by Task 9.
