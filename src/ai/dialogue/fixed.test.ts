import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashString } from "../../core/rand/hash.js";
import type { ScenarioArc } from "../../core/rules/arc.js";
import { createInitialState } from "../../core/rules/state.js";
import { siteContext } from "../../core/world/context.js";
import { type MacroSite, macroSite } from "../../core/world/macro.js";
import { worldSeed } from "../../core/world/recipe.js";
import { npcId } from "../../core/world/spec.js";
import { GameEngine } from "../../engine/engine.js";
import { fallbackLore, fallbackSite } from "../director/fallback.js";
import { createDialogueService } from "./dialogue.js";
import type { DialogueTree } from "./tree.js";

/**
 * Who is allowed to improvise, and who is not.
 *
 * The fault this pins was reported from a real playthrough: errands appearing in the
 * journal with no conversation that could have handed them over. Two separate bugs met
 * to produce it. The people the story hangs on were improvising, so the scene the beat
 * existed for was replaced by a pleasant remark about the weather; and a scenario with
 * any authored tree at all silenced improvisation for *everybody*, because the scripted
 * path answered for people it had nothing written for.
 *
 * The model is mocked rather than absent, which is the point: with no key both halves
 * pass for the wrong reason.
 */

const IMPROVISED = "Improvised: fine weather for the road.";

vi.mock("../client.js", () => ({
	aiAvailable: () => true,
	streamed: vi.fn(async () => ({
		speech: IMPROVISED,
		choices: [],
		actions: [],
		endsConversation: true,
	})),
	structured: vi.fn(async () => undefined),
}));

const { streamed } = await import("../client.js");

const SEED = hashString("fixed-dialogue-test");

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

/** A town, its people, and a story whose first beat opens at slot 0. */
function stage(
	options: {
		readonly trees?: Record<string, DialogueTree>;
		readonly live?: readonly number[];
	} = {},
) {
	const site = findTown(SEED);
	const found = fallbackSite(worldSeed(SEED), site, siteContext(worldSeed(SEED), site));
	// Improvisation is opt-in for an authored cast, so a test about who improvises has to say
	// who was allowed to. A world with no authored spec at all is the other case, and is
	// unchanged — see `mayImprovise`.
	const live = new Set(options.live ?? []);
	const spec = {
		...found,
		npcs: found.npcs.map((npc) => (live.has(npc.slot) ? { ...npc, live: true } : npc)),
	};
	const arc: ScenarioArc = {
		title: "The Tally",
		premise: "Somebody has to count the sacks.",
		beats: [
			{
				id: "first",
				order: 0,
				siteId: site.id,
				npcSlot: 0,
				requires: [],
				setsFlag: "arc:first",
				quest: {
					id: "first",
					name: "Count the sacks",
					description: "Count them.",
					objectives: [{ kind: "talk", target: "anyone", done: false }],
				},
			},
		],
	};

	const engine = new GameEngine(
		{
			...createInitialState(
				{ id: "t", name: "t", seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" },
				site.site,
			),
			arc,
		},
		{
			runEffect: () => undefined,
			specFor: (candidate) => (candidate.id === site.id ? spec.settlement : undefined),
			siteSpec: (id) => (id === site.id ? spec : undefined),
		},
	);
	engine.getChunks().prefetch({ cx: site.mx, cy: site.my }, 2);
	engine.populateNpcs({ cx: site.mx, cy: site.my });

	const trees = options.trees;
	const dialogue = createDialogueService({
		world: worldSeed(SEED),
		lore: () => fallbackLore(),
		regionSpec: () => undefined,
		siteSpec: (id) => (id === site.id ? spec : undefined),
		...(trees ? { tree: (id: string) => trees[id] } : {}),
	});

	return { site, spec, engine, dialogue, arc };
}

async function speak(
	stageResult: ReturnType<typeof stage>,
	slot: number,
): Promise<string | undefined> {
	const { engine, dialogue, site } = stageResult;
	const id = npcId(site.id, slot);
	const person = engine.personById(id);
	expect(person, `nobody in slot ${slot}`).toBeDefined();
	engine.dispatch({ t: "DialogueOpened", npcId: id, npcName: person?.name ?? "" });
	await dialogue.runDialogueTurn(id, undefined, engine);
	return engine.getState().dialogue?.lines.at(-1)?.text;
}

describe("who is allowed to improvise", () => {
	beforeEach(() => {
		vi.mocked(streamed).mockClear();
	});

	it("never asks a model to speak for somebody the story hangs on", async () => {
		const staged = stage();
		const said = await speak(staged, 0);

		expect(streamed).not.toHaveBeenCalled();
		expect(said).not.toBe(IMPROVISED);
		// And the beat still opened, which is why the scene mattered: the errand is in
		// the log either way, so the only question was whether anything was said for it.
		expect(staged.engine.getState().flags["arc:first"]).toBe(true);
		expect(said).toMatch(/\S/);
	});

	it("lets a resident the author marked improvise", async () => {
		// The other half of the same fault. Somebody standing in a town who anchors no beat is
		// exactly who live conversation was bought for — once the author has said so.
		const staged = stage({ live: [1] });
		expect(await speak(staged, 1)).toBe(IMPROVISED);
		expect(streamed).toHaveBeenCalledTimes(1);
	});

	/*
	 * Opt-in, not opt-out, and the difference matters while a world is half written.
	 *
	 * The old rule was "anybody the author did not write a conversation for", which made
	 * improvisation the default for everybody not yet reached — so a town in progress was a town
	 * full of people inventing facts about a story nobody had told them.
	 */
	it("does not let an unmarked resident improvise, however little is written", async () => {
		const staged = stage();
		const said = await speak(staged, 1);
		expect(streamed).not.toHaveBeenCalled();
		expect(said).not.toBe(IMPROVISED);
		// The canned menu, which is a real conversation built from what they know.
		expect(said).toMatch(/\S/);
	});

	it("lets a marked resident improvise even when other people have written trees", async () => {
		// The bug: the scripted path answered for everybody, tree or no tree, so one
		// authored conversation anywhere in a scenario silenced the model for the whole
		// cast. A world that paid for improvisation got none of it.
		const staged = stage({
			live: [1],
			trees: {
				[npcId(findTown(SEED).id, 0)]: {
					npcId: npcId(findTown(SEED).id, 0),
					entry: ["hello"],
					nodes: {
						hello: { id: "hello", speech: "The sacks are short again.", choices: [] },
					},
				},
			},
		});
		expect(await speak(staged, 1)).toBe(IMPROVISED);
	});

	it("prefers an author's words to a model's for the person carrying the beat", async () => {
		const id = npcId(findTown(SEED).id, 0);
		const staged = stage({
			trees: {
				[id]: {
					npcId: id,
					entry: ["hello"],
					nodes: {
						hello: { id: "hello", speech: "The sacks are short again.", choices: [] },
					},
				},
			},
		});
		expect(await speak(staged, 0)).toBe("The sacks are short again.");
		expect(streamed).not.toHaveBeenCalled();
	});
});
