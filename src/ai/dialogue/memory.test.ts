import { describe, expect, it } from "vitest";
import { hashString } from "../../core/rand/hash.js";
import { MAX_FACTS, MAX_RECENT_TURNS, needsSummary } from "../../core/rules/npc.js";
import { reduce } from "../../core/rules/reduce.js";
import { createInitialState } from "../../core/rules/state.js";
import { siteContext } from "../../core/world/context.js";
import { type MacroSite, macroSite } from "../../core/world/macro.js";
import { worldSeed } from "../../core/world/recipe.js";
import { GameEngine } from "../../engine/engine.js";
import { fallbackLore, fallbackSite } from "../director/fallback.js";
import { createDialogueService } from "./dialogue.js";

const SEED = hashString("memory-test");

const PROBE = { isPassable: () => true, isLoaded: () => true, npcAt: () => undefined };

function findTown(seed: number): MacroSite {
	for (let radius = 0; radius < 16; radius++) {
		for (let my = -radius; my <= radius; my++) {
			for (let mx = -radius; mx <= radius; mx++) {
				const site = macroSite(worldSeed(seed), mx, my);
				if (site.kind === "town" || site.kind === "village") return site;
			}
		}
	}
	throw new Error("no town found");
}

describe("npc memory records", () => {
	it("is created on the first meeting and never duplicated", () => {
		let state = createInitialState(
			{ id: "t", name: "t", seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" },
			{ x: 0, y: 0 },
		);
		const meet = {
			t: "ApplyEffects" as const,
			effects: [
				{
					t: "MeetNpc" as const,
					npcId: "npc:1:0",
					name: "Wren",
					role: "smith",
					siteId: 1,
					disposition: 5,
				},
			],
		};
		state = reduce(state, meet, PROBE).state;
		const first = state.npcs["npc:1:0"];
		state = reduce(state, meet, PROBE).state;
		expect(state.npcs["npc:1:0"]).toBe(first);
		expect(first?.disposition).toBe(5);
	});

	it("ignores memory writes for someone who was never met", () => {
		const state = createInitialState(
			{ id: "t", name: "t", seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" },
			{ x: 0, y: 0 },
		);
		const next = reduce(
			state,
			{
				t: "ApplyEffects",
				effects: [{ t: "RecordTurn", npcId: "ghost", turn: { role: "npc", text: "hello" } }],
			},
			PROBE,
		).state;
		expect(next.npcs.ghost).toBeUndefined();
	});

	it("folds the oldest turns away and keeps the facts bounded", () => {
		let state = createInitialState(
			{ id: "t", name: "t", seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" },
			{ x: 0, y: 0 },
		);
		state = reduce(
			state,
			{
				t: "ApplyEffects",
				effects: [
					{ t: "MeetNpc", npcId: "n", name: "Wren", role: "smith", siteId: 1, disposition: 0 },
				],
			},
			PROBE,
		).state;

		for (let i = 0; i < MAX_RECENT_TURNS; i++) {
			state = reduce(
				state,
				{
					t: "ApplyEffects",
					effects: [{ t: "RecordTurn", npcId: "n", turn: { role: "npc", text: `line ${i}` } }],
				},
				PROBE,
			).state;
		}
		expect(needsSummary(state.npcs.n as never)).toBe(true);
		expect(state.npcs.n?.totalTurns).toBe(MAX_RECENT_TURNS);

		state = reduce(
			state,
			{
				t: "ApplyEffects",
				effects: [
					{
						t: "FoldNpcMemory",
						npcId: "n",
						summary: "They asked about the road.",
						newFacts: Array.from({ length: MAX_FACTS + 4 }, (_, i) => `fact ${i}`),
						foldedTurns: 6,
					},
				],
			},
			PROBE,
		).state;

		const record = state.npcs.n;
		expect(record?.recentTurns).toHaveLength(MAX_RECENT_TURNS - 6);
		expect(record?.recentTurns[0]?.text).toBe("line 6");
		expect(record?.facts).toHaveLength(MAX_FACTS);
		// totalTurns counts the whole relationship, not the window.
		expect(record?.totalTurns).toBe(MAX_RECENT_TURNS);
	});

	it("clamps disposition to its range however often it is nudged", () => {
		let state = createInitialState(
			{ id: "t", name: "t", seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" },
			{ x: 0, y: 0 },
		);
		state = reduce(
			state,
			{
				t: "ApplyEffects",
				effects: [
					{ t: "MeetNpc", npcId: "n", name: "Wren", role: "smith", siteId: 1, disposition: 0 },
				],
			},
			PROBE,
		).state;
		for (let i = 0; i < 20; i++) {
			state = reduce(
				state,
				{ t: "ApplyEffects", effects: [{ t: "AdjustDisposition", npcId: "n", delta: 15 }] },
				PROBE,
			).state;
		}
		expect(state.npcs.n?.disposition).toBe(100);
	});
});

describe("offline conversation", () => {
	it("holds a real conversation and remembers it afterwards", async () => {
		const site = findTown(SEED);
		const spec = fallbackSite(SEED, site, siteContext(worldSeed(SEED), site));
		const engine = new GameEngine(
			createInitialState(
				{ id: "t", name: "t", seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" },
				site.site,
			),
			{
				runEffect: () => undefined,
				specFor: (s) => (s.id === site.id ? spec.settlement : undefined),
				siteSpec: (id) => (id === site.id ? spec : undefined),
			},
		);
		engine.getChunks().prefetch({ cx: site.mx, cy: site.my }, 2);
		engine.populateNpcs({ cx: site.mx, cy: site.my });

		const target = engine.getNpcs().all()[0];
		expect(target).toBeDefined();
		if (!target) return;

		const dialogue = createDialogueService({
			world: worldSeed(SEED),
			lore: () => fallbackLore(),
			regionSpec: () => undefined,
			siteSpec: (id) => (id === site.id ? spec : undefined),
			disabled: true,
		});

		engine.dispatch({ t: "DialogueOpened", npcId: target.id, npcName: target.name });
		await dialogue.runDialogueTurn(target.id, undefined, engine);

		const opened = engine.getState().dialogue;
		expect(opened?.pending).toBe(false);
		expect(opened?.lines.at(-1)?.text).toMatch(/\S/);
		expect(engine.getState().npcs[target.id]?.totalTurns).toBe(1);

		// Answer one of the offered choices; the reply must be a different line.
		const choice = opened?.choices?.[0];
		expect(choice).toBeDefined();
		if (!choice) return;
		await dialogue.runDialogueTurn(target.id, choice, engine);

		const record = engine.getState().npcs[target.id];
		expect(record?.totalTurns).toBe(3);
		expect(record?.recentTurns.some((turn) => turn.role === "player")).toBe(true);

		// Walking away and coming back keeps the memory.
		engine.dispatch({ t: "CloseDialogue" });
		expect(engine.getState().dialogue).toBeUndefined();
		expect(engine.getState().npcs[target.id]?.totalTurns).toBe(3);
	});
});
