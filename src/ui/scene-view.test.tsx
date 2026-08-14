import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderInk } from "../../test/harness/ink.js";
import { hashString } from "../core/rand/hash.js";
import type { Scene } from "../core/rules/scene.js";
import { createInitialState } from "../core/rules/state.js";
import { GameEngine } from "../engine/engine.js";
import App from "./app.js";
import { bindEngine } from "./store.js";
import { setTileMode } from "./viewport.js";

/*
 * A cutscene on screen.
 *
 * The scene machine and its staging are tested without a world; this is the part that can only
 * be seen — the line under the map, the camera looking somewhere other than at the player, the
 * actor drawn where the scene has them, and the frames arriving on their own.
 */

const SEED = hashString("scene-view-test");

/** A scene played in open country, so nothing the generator built can get in the way. */
function sceneAt(x: number, y: number): Scene {
	return {
		id: "the-messenger-arrives",
		steps: [
			{ do: [{ t: "Spawn", actor: "rider", at: { kind: "world", x: x + 4, y } }] },
			{ do: [{ t: "Camera", to: { kind: "world", x: x + 4, y }, pan: "cut" }], hold: 2 },
			{ do: [{ t: "Say", actor: "rider", text: "The abbey has fallen." }] },
		],
	};
}

/** An engine standing in empty ground with one scene wired to a trigger. */
function engineWithScene() {
	const at = { x: 400, y: 400 };
	const scene = sceneAt(at.x, at.y);
	const base = createInitialState(
		{ id: "t", name: "t", seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" },
		at,
	);
	const engine = new GameEngine(
		{
			...base,
			world: {
				...base.world,
				bounds: { minX: 0, minY: 0, maxX: 800, maxY: 800, style: "cliffs", thickness: 4 },
			},
			scenes: { [scene.id]: scene },
			triggers: [
				{ id: "arrive", when: { flag: "ready" }, effects: [{ t: "PlayScene", id: scene.id }] },
			],
			flags: { ready: true },
		},
		{ runEffect: () => undefined },
	);
	engine.getChunks().prefetch({ cx: Math.floor(at.x / 64), cy: Math.floor(at.y / 64) }, 1);
	return { engine, at, scene };
}

function mount(engine: GameEngine) {
	setTileMode("glyph");
	bindEngine(engine);
	return renderInk(<App />, { columns: 100, rows: 30 });
}

afterEach(() => {
	setTileMode("glyph");
});

describe("a cutscene on screen", () => {
	it("draws the line the scene is saying, and who is saying it", async () => {
		const { engine } = engineWithScene();
		const ink = mount(engine);
		await ink.settle();

		// Frames arrive on their own once a scene is up: the app runs its own interval, so the
		// scene reaches its line without anybody pressing anything.
		for (let frame = 0; frame < 6; frame++) engine.dispatch({ t: "SceneFrame" });
		await ink.settle();

		const screen = stripAnsi(ink.screen());
		expect(screen).toContain("The abbey has fallen.");
		// The stage alias, because this rider is not somebody the world knows.
		expect(screen).toContain("rider");
		ink.unmount();
	});

	it("says how to get past the line, and that it can be skipped", async () => {
		const { engine } = engineWithScene();
		const ink = mount(engine);
		await ink.settle();
		for (let frame = 0; frame < 6; frame++) engine.dispatch({ t: "SceneFrame" });
		await ink.settle();

		const screen = stripAnsi(ink.screen());
		expect(screen).toContain("SPACE to go on");
		expect(screen).toContain("ESC to skip");
		ink.unmount();
	});

	it("hands the world back when the player skips", async () => {
		const { engine } = engineWithScene();
		const ink = mount(engine);
		await ink.settle();
		engine.dispatch({ t: "SceneFrame" });
		expect(engine.getState().scene).toBeDefined();

		await ink.type(KEY.escape);
		expect(engine.getState().scene).toBeUndefined();
		ink.unmount();
	});

	it("gets past a line on SPACE rather than opening a menu", async () => {
		const { engine } = engineWithScene();
		const ink = mount(engine);
		await ink.settle();
		for (let frame = 0; frame < 6; frame++) engine.dispatch({ t: "SceneFrame" });
		await ink.settle();
		expect(engine.getState().scene?.caption).toBeDefined();

		await ink.type(" ");
		expect(engine.getState().scene?.caption).toBeUndefined();
		ink.unmount();
	});

	it("ignores the menu key while a scene has the world", async () => {
		// The arrow keys a menu wants are the ones the scene needs, so it must not open over one.
		const { engine } = engineWithScene();
		const ink = mount(engine);
		await ink.settle();
		engine.dispatch({ t: "SceneFrame" });
		await ink.settle();

		await ink.type("m");
		await ink.settle();
		expect(stripAnsi(ink.screen())).not.toContain("Quests");
		ink.unmount();
	});

	it("stops dispatching frames once the scene is over", async () => {
		const { engine } = engineWithScene();
		const ink = mount(engine);
		await ink.settle();
		// Skip to the end, then let the interval — if it is still running — have a go.
		await ink.type(KEY.escape);
		await ink.settle();

		const before = engine.getState();
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(engine.getState()).toBe(before);
		ink.unmount();
	});

	it("draws the map as usual once the scene has gone", async () => {
		const { engine } = engineWithScene();
		const ink = mount(engine);
		await ink.settle();
		await ink.type(KEY.escape);
		await ink.settle();

		// The caption band is gone, and the ordinary bottom-of-screen furniture is back.
		const screen = stripAnsi(ink.screen());
		expect(screen).not.toContain("SPACE to go on");
		expect(screen).not.toContain("The abbey has fallen.");
		expect(screen).toContain("day 1");
		ink.unmount();
	});

	it("draws no row wider than the terminal while a scene is playing", async () => {
		// The same rule the rest of the screen is held to. Ink trims trailing whitespace, so the
		// claim is about the maximum rather than about every row being equal.
		const { engine } = engineWithScene();
		const ink = mount(engine);
		await ink.settle();
		for (let frame = 0; frame < 6; frame++) engine.dispatch({ t: "SceneFrame" });
		await ink.settle();

		for (const row of stripAnsi(ink.screen()).split("\n")) {
			expect(row.length, row).toBeLessThanOrEqual(100);
		}
		ink.unmount();
	});
});
