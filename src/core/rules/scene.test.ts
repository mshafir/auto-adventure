import { describe, expect, it } from "vitest";
import { advanceScene, beginScene, type SceneState, type StagedScene } from "./scene.js";

/** A scene with one actor walking three tiles, then speaking, then turning a chapter. */
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
			{ do: [{ t: "Effects", effects: [{ t: "SetFlag", key: "chapter", value: 2 }] }] },
		],
	};
}

const idle = { advance: false } as const;
const pressed = { advance: true } as const;

/** Run frames until the scene ends or the budget runs out, collecting what it emitted. */
function play(
	staged: StagedScene,
	input: { readonly advance: boolean } = idle,
	budget = 20,
): { readonly frames: readonly SceneState[]; readonly effects: readonly unknown[] } {
	let scene: SceneState | undefined = beginScene(staged, { x: 4, y: 4 }, "down");
	const frames: SceneState[] = [];
	const effects: unknown[] = [];
	for (let frame = 0; frame < budget && scene; frame++) {
		const outcome = advanceScene(staged, scene, input);
		effects.push(...outcome.effects);
		scene = outcome.scene;
		if (scene) frames.push(scene);
	}
	return { frames, effects };
}

describe("advanceScene", () => {
	it("puts an actor on stage and aims the camera in the first frame", () => {
		const staged = walkThenSpeak();
		const first = advanceScene(staged, beginScene(staged, { x: 4, y: 4 }, "down"), idle);

		expect(first.scene?.actors.rider).toMatchObject({ x: 10, y: 10 });
		expect(first.scene?.camera).toEqual({ x: 10, y: 10 });
	});

	it("consumes one tile of a walk per frame and moves on when the path runs out", () => {
		const staged = walkThenSpeak();
		const { frames } = play(staged, idle, 5);

		// Frame one is the spawn. Then three tiles, one per frame, and the fourth frame
		// has nothing left to walk — so the step is done and the line is up.
		expect(frames.map((frame) => frame.actors.rider?.x)).toEqual([10, 11, 12, 13, 13]);
		expect(frames.at(-1)?.caption?.text).toBe("The abbey has fallen.");
	});

	it("faces a walking actor along the direction it is travelling", () => {
		const { frames } = play(walkThenSpeak(), idle, 2);
		expect(frames.at(-1)?.actors.rider?.facing).toBe("right");
	});

	it("holds a line on screen until the player advances", () => {
		const staged = walkThenSpeak();
		const { frames } = play(staged, idle, 8);
		// Idle frames never get past the caption, so the scene is still standing there.
		expect(frames.at(-1)?.caption?.text).toBe("The abbey has fallen.");

		const answered = advanceScene(staged, frames.at(-1) as SceneState, pressed);
		expect(answered.scene?.caption).toBeUndefined();
	});

	it("emits a step's effects when that step runs", () => {
		const { effects } = play(walkThenSpeak(), pressed);
		expect(effects).toContainEqual({ t: "SetFlag", key: "chapter", value: 2 });
	});

	it("reports the scene over by returning no scene", () => {
		const staged = walkThenSpeak();
		let scene: SceneState | undefined = beginScene(staged, { x: 4, y: 4 }, "down");
		for (let frame = 0; frame < 20 && scene; frame++) {
			scene = advanceScene(staged, scene, pressed).scene;
		}
		expect(scene).toBeUndefined();
	});

	it("holds a step for its stated number of frames before moving on", () => {
		const staged: StagedScene = {
			id: "a-pause",
			skippable: true,
			steps: [
				{ do: [{ t: "Wait", ticks: 3 }] },
				{ do: [{ t: "Say", actor: "player", text: "Oh." }] },
			],
		};
		const { frames } = play(staged, idle, 4);
		expect(frames.slice(0, 3).map((frame) => frame.caption)).toEqual([
			undefined,
			undefined,
			undefined,
		]);
		expect(frames[3]?.caption?.text).toBe("Oh.");
	});

	it("ends a step when the slower of two parallel actions finishes, not the faster", () => {
		const staged: StagedScene = {
			id: "together",
			skippable: true,
			steps: [
				{
					do: [
						{ t: "Spawn", actor: "a", at: { x: 0, y: 0 } },
						{ t: "Spawn", actor: "b", at: { x: 4, y: 0 } },
					],
				},
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
		const { frames } = play(staged, idle, 6);

		// `a` arrived on the first frame of the walk; the step ran on because `b` had three
		// tiles to cover. A step that ended with the fastest action would have cut `b` off
		// mid-stride and teleported it into place for the next step.
		const midway = frames[2] as SceneState;
		expect(midway.actors.a).toMatchObject({ x: 1, y: 0 });
		expect(midway.actors.b).toMatchObject({ x: 6, y: 0 });
		expect(midway.caption).toBeUndefined();

		// `b` arrives, and that frame shows the arrival rather than the next step's line.
		expect(frames[3]?.actors.b).toMatchObject({ x: 7, y: 0 });
		expect(frames[3]?.caption).toBeUndefined();
		expect(frames[4]?.caption?.text).toBe("There.");
	});

	/*
	 * The frame on which a step's actions finish renders the state they finished in, and the
	 * next step begins on the frame after. That is not an off-by-one: it is the only frame on
	 * which an actor is drawn standing at the end of its walk. Running the next step in the
	 * same frame would compose its first actions over the arrival and the player would never
	 * see anybody get anywhere.
	 */
	it("shows the state a step finished in before beginning the next one", () => {
		const staged: StagedScene = {
			id: "arrive-then-speak",
			skippable: true,
			steps: [
				{ do: [{ t: "Spawn", actor: "rider", at: { x: 0, y: 0 } }] },
				{ do: [{ t: "WalkTo", actor: "rider", path: [{ x: 1, y: 0 }], speed: "normal" }] },
				{ do: [{ t: "Say", actor: "rider", text: "Here." }] },
			],
		};
		const { frames } = play(staged, idle, 4);
		expect(frames[0]?.actors.rider).toMatchObject({ x: 0, y: 0 });
		expect(frames[1]?.actors.rider).toMatchObject({ x: 1, y: 0 });
		expect(frames[1]?.caption).toBeUndefined();
		expect(frames[2]?.caption?.text).toBe("Here.");
	});

	it("takes a slow walker several frames to cross one tile", () => {
		const staged: StagedScene = {
			id: "slowly",
			skippable: true,
			steps: [
				{ do: [{ t: "Spawn", actor: "old", at: { x: 0, y: 0 } }] },
				{
					do: [
						{
							t: "WalkTo",
							actor: "old",
							path: [
								{ x: 1, y: 0 },
								{ x: 2, y: 0 },
							],
							speed: "slow",
						},
					],
				},
				{ do: [{ t: "Say", actor: "old", text: "Far enough." }] },
			],
		};
		const { frames } = play(staged, idle, 8);
		// One tile on the frame the walk starts, then two frames standing on it, then the
		// next. A slow walker holds a tile rather than covering a fraction of one, because
		// the world is a grid and there is nowhere to draw somebody between two tiles.
		expect(frames.map((frame) => frame.actors.old?.x).slice(0, 5)).toEqual([0, 1, 1, 1, 2]);
	});

	it("takes an actor off stage when the scene says so", () => {
		const staged: StagedScene = {
			id: "gone",
			skippable: true,
			steps: [
				{ do: [{ t: "Spawn", actor: "rider", at: { x: 1, y: 1 } }] },
				{ do: [{ t: "Despawn", actor: "rider" }] },
				{ do: [{ t: "Say", actor: "player", text: "Well." }] },
			],
		};
		const { frames } = play(staged, idle, 3);
		expect(frames[0]?.actors.rider).toBeDefined();
		expect(frames[1]?.actors.rider).toBeUndefined();
	});

	it("turns an actor to look at a point", () => {
		const staged: StagedScene = {
			id: "look",
			skippable: true,
			steps: [
				{ do: [{ t: "Spawn", actor: "rider", at: { x: 5, y: 5 } }] },
				{ do: [{ t: "Face", actor: "rider", at: { x: 5, y: 0 } }] },
				{ do: [{ t: "Say", actor: "player", text: "Ah." }] },
			],
		};
		const { frames } = play(staged, idle, 2);
		expect(frames[1]?.actors.rider?.facing).toBe("up");
	});

	it("raises a card as an effect rather than as scene state", () => {
		// The full-screen card already exists, is already shown once by id, and already
		// survives a reload. A scene that reimplemented it would be a second one.
		const staged: StagedScene = {
			id: "chapter",
			skippable: true,
			steps: [
				{
					do: [
						{
							t: "Card",
							card: { id: "chapter-two", title: "Chapter Two", sections: [] },
						},
					],
				},
			],
		};
		const { effects } = play(staged, idle, 2);
		expect(effects).toEqual([
			{ t: "ShowCard", card: { id: "chapter-two", title: "Chapter Two", sections: [] } },
		]);
	});

	it("starts the player where the player actually is", () => {
		const staged = walkThenSpeak();
		const opened = beginScene(staged, { x: 7, y: 9 }, "left");
		expect(opened.actors.player).toEqual({ x: 7, y: 9, facing: "left" });
	});
});
