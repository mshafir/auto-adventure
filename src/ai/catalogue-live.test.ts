import { generateObject } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ARC_SYSTEM, arcPrompt } from "./author/prompts.js";
import { ArcSchema } from "./author/schemas.js";
import { CATALOGUE } from "./catalogue.js";

/**
 * Every model in the catalogue, asked for an object.
 *
 * The one property the table cannot assert on its own, and the one that matters
 * most: a slug that is spelled right, priced right and cannot answer in a schema
 * is worse than a slug that is simply wrong. Nothing in the game would crash —
 * `structured` returns undefined on a bad answer and every caller has a
 * deterministic fallback — so the failure arrives as a world with procedural names
 * in it, several minutes and several hundred calls after the player chose to pay
 * for authored ones.
 *
 * Two rows were caught this way before anybody could pick them: `gpt-oss-20b`
 * burning half a minute to produce unparseable output, and Alibaba's Qwen
 * rejecting every structured call outright.
 *
 * The escalation models are covered too, and they need it most: they are the least
 * exercised slugs in the table — reached only by a call that has already failed twice —
 * so a typo in one would show up as an escalation that never works, on the rare path
 * nobody watches, and the symptom would be indistinguishable from having no escalation
 * at all.
 *
 * Skipped without a key, because it spends money. Run it after touching the
 * catalogue, and when a row starts looking suspect.
 */
describe.skipIf(!process.env.AI_GATEWAY_API_KEY?.trim())("every model in the catalogue", () => {
	const schema = z.object({ name: z.string().min(1), trade: z.string().min(1) });

	// Both halves of every row, deduplicated: several rows share a model, and the
	// pairing means the cheap half is asked exactly the same kind of question.
	const models = [
		...new Set(
			CATALOGUE.flatMap((e) => [
				e.fast.model,
				e.prose.model,
				...(e.strong ? [e.strong.model] : []),
			]),
		),
	];

	for (const model of models) {
		it(`answers ${model} in the shape it was asked for`, async () => {
			const result = await generateObject({
				model,
				schema,
				system: "You name people in a fantasy village.",
				prompt: "Invent one villager: a name and a trade.",
				abortSignal: AbortSignal.timeout(45_000),
			});
			const villager = result.object as { name: string; trade: string };
			expect(villager.name).toBeTruthy();
			expect(villager.trade).toBeTruthy();
		}, 60_000);
	}
});

/**
 * Every model that can be asked to plot a story, asked to plot one.
 *
 * The test above asks for `{name, trade}` and every model in the table passes it — which is
 * exactly why it did not catch this. The arc is the largest object the pipeline asks for by a
 * long way, it is the only call whose failure costs the *whole story*, and nothing measured it
 * until two live runs came back saying "no story could be plotted" and reporting a clean world
 * either side of that line.
 *
 * What the first measurement found, three arcs per model:
 *
 * - `anthropic/claude-haiku-4.5` and `claude-sonnet-5` — 0 of 3, every time by leaving out
 *   `title`, `premise` and `endings` while writing perfectly good beats. Fixed by making those
 *   three `nullish` in `ArcSchema` and taking the title from the world's lore: 3 of 3 and 2 of 3
 *   afterwards, with no change to either model.
 * - `zai/glm-4.7-flash` — 0 of 3, missing `beats`. Nothing can stand in for the beats, so that
 *   row cannot write a story at all, and it is gone from the table.
 * - `deepseek/deepseek-v3.2` — 2 of 3, missing `beats` on the third. Survives on the retries
 *   every authoring call already has.
 * - Both OpenAI rows and all four Google models — 3 of 3.
 *
 * One arc each here rather than three: this is a smoke test against a table that has been
 * measured, not the measurement itself.
 */
describe.skipIf(!process.env.AI_GATEWAY_API_KEY?.trim())("every model that plots a story", () => {
	const sites = [1, 2, 3].map((id) => ({
		entry: { site: { id, kind: "village", x: id * 10, y: id * 10 }, distanceFromSpawn: id * 20 },
		spec: {
			siteId: id,
			name: `Ashbeck ${id}`,
			description: "A village on the marsh road.",
			npcs: [
				{ slot: 0, name: `Ash ${id}`, role: "warden" },
				{ slot: 1, name: `Bree ${id}`, role: "tallier" },
			],
		},
	}));
	const prompt = arcPrompt({
		brief: { premise: "a village that owes a tithe it cannot pay", duration: "short" },
		lore: {
			title: "The Reed Tithe",
			premise: "The marsh owes more than it can cut.",
			tone: "damp and wry",
			era: "the third wet year",
			factions: ["the wardens", "the cutters"],
			deities: ["the Drowned Mother"],
		},
		beats: 5,
		// biome-ignore lint/suspicious/noExplicitAny: the prompt needs only the fields both shapes share
		sites: sites as any,
	});

	// The arc runs on the prose model and escalates to the strong one, so both have to manage it.
	const models = [
		...new Set(CATALOGUE.flatMap((e) => [e.prose.model, ...(e.strong ? [e.strong.model] : [])])),
	];

	for (const model of models) {
		it(`plots a story on ${model}`, async () => {
			const result = await generateObject({
				model,
				schema: ArcSchema,
				system: ARC_SYSTEM,
				prompt,
				abortSignal: AbortSignal.timeout(180_000),
			});
			// The beats are the arc. Everything else has somewhere to fall back to, and does.
			expect(result.object.beats.length).toBeGreaterThan(0);
		}, 200_000);
	}
});
