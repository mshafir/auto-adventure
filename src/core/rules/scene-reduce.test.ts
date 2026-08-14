import { describe, expect, it } from "vitest";
import { reduce, type WorldProbe } from "./reduce.js";
import type { StagedScene } from "./scene.js";
import { createInitialState, type GameState } from "./state.js";
import { triggerKey } from "./trigger.js";

const ARRIVAL: StagedScene = {
	id: "the-messenger-arrives",
	skippable: true,
	steps: [
		{ do: [{ t: "Camera", to: { x: 9, y: 9 }, pan: "cut" }] },
		{ do: [{ t: "Say", actor: "player", text: "The abbey has fallen." }] },
		{ do: [{ t: "Effects", effects: [{ t: "SetFlag", key: "chapter", value: 2 }] }] },
	],
};

/** A probe that lets the player walk anywhere and knows one scene. */
const world: WorldProbe = {
	isPassable: () => true,
	isLoaded: () => true,
	npcAt: () => undefined,
	stagedScene: (id) => (id === ARRIVAL.id ? ARRIVAL : undefined),
};

/** A probe that has forgotten the scene its triggers ask for. */
const forgetful: WorldProbe = { ...world, stagedScene: () => undefined };

function start(): GameState {
	const base = createInitialState({ id: "w", name: "W", seed: 1, createdAt: "" }, { x: 5, y: 5 });
	return {
		...base,
		triggers: [
			{ id: "arrive", when: { flag: "ready" }, effects: [{ t: "PlayScene", id: ARRIVAL.id }] },
		],
		flags: { ready: true },
	};
}

/** Play a scene out, pressing the advance key whenever a line is waiting. */
function playThrough(from: GameState, probe: WorldProbe = world): GameState {
	let state = from;
	for (let frame = 0; frame < 20 && state.scene; frame++) {
		state = reduce(
			state,
			state.scene.caption ? { t: "Advance" } : { t: "SceneFrame" },
			probe,
		).state;
	}
	return state;
}

describe("scenes in the reducer", () => {
	it("opens the scene a trigger asked for", () => {
		const { state } = reduce(start(), { t: "SceneFrame" }, world);
		expect(state.scene?.id).toBe(ARRIVAL.id);
	});

	it("puts the player on stage where they are standing", () => {
		const { state } = reduce(start(), { t: "SceneFrame" }, world);
		expect(state.scene?.actors.player).toMatchObject({ x: 5, y: 5 });
	});

	it("swallows movement while a scene is playing", () => {
		const opened = reduce(start(), { t: "SceneFrame" }, world).state;
		const moved = reduce(opened, { t: "Move", facing: "right" }, world).state;
		expect(moved.player.x).toBe(opened.player.x);
		expect(moved).toBe(opened);
	});

	it("swallows interaction too, so a scene cannot be talked over", () => {
		const opened = reduce(start(), { t: "SceneFrame" }, world).state;
		expect(reduce(opened, { t: "Interact" }, world).state).toBe(opened);
	});

	/*
	 * The correctness crux. If the trigger were marked fired when it fired, a player who quit
	 * mid-cutscene would come back to a world that believed the scene had happened: it would
	 * never play again, and the chapter flag it was going to set would never be set either.
	 */
	it("leaves the trigger unfired until the scene finishes", () => {
		const opened = reduce(start(), { t: "SceneFrame" }, world).state;
		expect(opened.flags[triggerKey("arrive")]).toBeUndefined();

		const finished = playThrough(opened);
		expect(finished.scene).toBeUndefined();
		expect(finished.flags[triggerKey("arrive")]).toBe(true);
		expect(finished.flags.chapter).toBe(2);
	});

	it("does not replay a scene whose trigger has fired", () => {
		const finished = playThrough(reduce(start(), { t: "SceneFrame" }, world).state);
		expect(reduce(finished, { t: "SceneFrame" }, world).state.scene).toBeUndefined();
	});

	it("replays a scene that was interrupted, because nothing was written down", () => {
		// What an interruption looks like: the scene is dropped from state the way loading a
		// save would drop it, and the trigger is still waiting.
		const opened = reduce(start(), { t: "SceneFrame" }, world).state;
		const midway = reduce(opened, { t: "SceneFrame" }, world).state;
		const { scene: interrupted, ...reloaded } = midway;
		void interrupted;

		const again = reduce(reloaded as GameState, { t: "SceneFrame" }, world).state;
		expect(again.scene?.id).toBe(ARRIVAL.id);
		expect(again.scene?.step).toBe(0);
	});

	it("marks the trigger fired when the player skips", () => {
		const opened = reduce(start(), { t: "SceneFrame" }, world).state;
		const skipped = reduce(opened, { t: "SkipScene" }, world).state;
		expect(skipped.scene).toBeUndefined();
		expect(skipped.flags[triggerKey("arrive")]).toBe(true);
	});

	it("still applies a skipped scene's effects, so skipping cannot stop the story", () => {
		const opened = reduce(start(), { t: "SceneFrame" }, world).state;
		expect(reduce(opened, { t: "SkipScene" }, world).state.flags.chapter).toBe(2);
	});

	it("refuses to skip a scene that says it may not be skipped", () => {
		const fixed: StagedScene = { ...ARRIVAL, skippable: false };
		const probe: WorldProbe = { ...world, stagedScene: () => fixed };
		const opened = reduce(start(), { t: "SceneFrame" }, probe).state;
		expect(reduce(opened, { t: "SkipScene" }, probe).state.scene).toBeDefined();
	});

	/*
	 * The command that *opens* a scene does check-point, and should: its trigger pass may have
	 * granted an item or opened a gate, and that is worth keeping. What makes it safe is that
	 * the trigger is still unfired and `withoutPlayingScene` keeps the scene itself off disk —
	 * so what gets written is a world in which the cutscene has yet to play.
	 */
	it("emits no save on the frames of a playing scene", () => {
		const opened = reduce(start(), { t: "SceneFrame" }, world);
		const frame = reduce(opened.state, { t: "SceneFrame" }, world);
		expect(frame.effects).toEqual([]);

		const answered = reduce(frame.state, { t: "Advance" }, world);
		expect(answered.effects).toEqual([]);
	});

	it("saves once the scene is over, because that is a checkpoint worth keeping", () => {
		let state = reduce(start(), { t: "SceneFrame" }, world).state;
		let saves = 0;
		for (let frame = 0; frame < 20 && state.scene; frame++) {
			const outcome = reduce(
				state,
				state.scene.caption ? { t: "Advance" } : { t: "SceneFrame" },
				world,
			);
			state = outcome.state;
			saves += outcome.effects.filter((effect) => effect.t === "Save").length;
		}
		expect(saves).toBe(1);
	});

	/*
	 * A scene the world cannot stage must not lock the player out of their own game. Ending it
	 * is the only honest option — and its effects still apply, so the story does not stop at a
	 * cutscene that failed to load.
	 */
	it("does not open a scene the world cannot stage, and leaves the trigger waiting", () => {
		const { state } = reduce(start(), { t: "SceneFrame" }, forgetful);
		expect(state.scene).toBeUndefined();
		expect(state.flags[triggerKey("arrive")]).toBeUndefined();
	});

	it("ends a playing scene whose staging has gone, applying what it had left to do", () => {
		const opened = reduce(start(), { t: "SceneFrame" }, world).state;
		const rescued = reduce(opened, { t: "SceneFrame" }, forgetful).state;
		expect(rescued.scene).toBeUndefined();
		expect(rescued.flags[triggerKey("arrive")]).toBe(true);
	});

	/*
	 * A scene may raise a full screen of prose, and a screen the player cannot put down is a
	 * game that has stopped. So `DismissCard` is the one ordinary command a scene lets through —
	 * and while the card is up the scene waits behind it rather than playing on unseen.
	 */
	it("lets the player put down a card the scene raised", () => {
		const withCard: StagedScene = {
			id: "chapter",
			skippable: true,
			steps: [
				{
					do: [
						{
							t: "Card",
							card: {
								id: "chapter-two",
								title: "Chapter Two",
								// A card with no sections and no subtitle is dropped by `ShowCard` as
								// having nothing on it, so a scene that raises one has to say something.
								sections: [{ heading: "The second day", body: "The water did not go out." }],
							},
						},
					],
				},
				{ do: [{ t: "Say", actor: "player", text: "Well." }] },
			],
		};
		const probe: WorldProbe = { ...world, stagedScene: () => withCard };
		// Opening a scene sets the stage; the first step runs on the frame after, which is when
		// the card goes up.
		const opened = reduce(
			reduce(start(), { t: "SceneFrame" }, probe).state,
			{ t: "SceneFrame" },
			probe,
		).state;
		expect(opened.card).toBeDefined();
		expect(opened.scene).toBeDefined();

		// Frames do not get past it.
		const held = reduce(opened, { t: "SceneFrame" }, probe).state;
		expect(held.card).toBeDefined();
		expect(held.scene?.step).toBe(opened.scene?.step);

		const read = reduce(held, { t: "DismissCard" }, probe).state;
		expect(read.card).toBeUndefined();
		expect(read.scene).toBeDefined();
	});

	it("does not advance the clock, so a cutscene costs no daylight", () => {
		const opened = reduce(start(), { t: "SceneFrame" }, world).state;
		const finished = playThrough(opened);
		expect(finished.time.tick).toBe(opened.time.tick);
	});
});

/*
 * What a player saw: a conversation whose spinner never stopped.
 *
 * The lock a scene puts on the world is a lock on the player's hands. A model's answer is not
 * the player's hands — it is something that arrived — and swallowing one leaves the
 * conversation it belongs to waiting on a reply that has already been thrown away.
 */
describe("what a scene may not swallow", () => {
	const talking = (state: GameState): GameState => ({
		...state,
		dialogue: {
			npcId: "npc:1:0",
			npcName: "Ilse",
			lines: [],
			cursor: 0,
			choiceIndex: 0,
			pending: true,
		},
	});

	/*
	 * The scene is opened first and the conversation attached afterwards, which is the shape
	 * the bug actually had: the reply was already in flight when the world was taken away.
	 * A trigger can no longer produce this — one that takes the screen waits for the
	 * conversation to close — but a scene raised any other way still can, and an arrival must
	 * not be droppable by any path.
	 */
	it("lets a reply through to the conversation waiting on it", () => {
		const playing = reduce(start(), { t: "SceneFrame" }, world).state;
		expect(playing.scene, "the scene should be up for this test to mean anything").toBeDefined();
		const opened = talking(playing);

		const answered = reduce(
			opened,
			{
				t: "DialogueTurn",
				npcId: "npc:1:0",
				speaker: "Ilse",
				text: "Ferry's not running.",
				choices: ["Why?"],
			},
			world,
		).state;
		expect(answered.dialogue?.pending).toBe(false);
		expect(answered.dialogue?.lines.at(-1)?.text).toBe("Ferry's not running.");
		// And the scene is still playing: an arrival changes the conversation, not the cutscene.
		expect(answered.scene?.id).toBe(ARRIVAL.id);
	});

	it("still swallows a keypress", () => {
		const playing = reduce(start(), { t: "SceneFrame" }, world).state;
		const moved = reduce(talking(playing), { t: "Move", facing: "left" }, world).state;
		expect(moved.player.x).toBe(playing.player.x);
	});

	it("does not raise a scene over a conversation in the first place", () => {
		// The rule that made the spinner impossible rather than merely survivable. A beat's flag
		// is set when its conversation opens, so a trigger watching for that beat used to fire
		// on the first line of it.
		const held = reduce(talking(start()), { t: "SceneFrame" }, world).state;
		expect(held.scene).toBeUndefined();

		const closed = reduce(held, { t: "CloseDialogue" }, world).state;
		expect(closed.scene?.id).toBe(ARRIVAL.id);
	});
});
