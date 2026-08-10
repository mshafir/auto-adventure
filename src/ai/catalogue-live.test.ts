import { generateObject } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
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
