import { describe, expect, it } from "vitest";
import {
	CATALOGUE,
	costLabel,
	costRatio,
	DEFAULT_MODEL_SET,
	defaultChoice,
	modelChoice,
	priceLine,
} from "./catalogue.js";

describe("the model catalogue", () => {
	it("has a default that is actually in it", () => {
		// `defaultChoice` falls back to the first row rather than throwing, which would
		// turn a typo in DEFAULT_MODEL_SET into a silently different default.
		expect(CATALOGUE.some((entry) => entry.id === DEFAULT_MODEL_SET)).toBe(true);
		expect(defaultChoice().id).toBe(DEFAULT_MODEL_SET);
	});

	it("keeps the ids unique", () => {
		// They are what gets written into settings and onto a generate request, so a
		// duplicate would make one of the two rows unreachable.
		const ids = CATALOGUE.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("names every model with a provider prefix", () => {
		// The gateway routes on `provider/model`; a bare name is a call that fails
		// several minutes into writing a world.
		for (const entry of CATALOGUE) {
			expect(entry.fast.model, entry.id).toMatch(/^[a-z0-9-]+\/\S+$/);
			expect(entry.prose.model, entry.id).toMatch(/^[a-z0-9-]+\/\S+$/);
		}
	});

	it("prices every model above nothing", () => {
		// A zero would put a row at the top of the list claiming to be free, which is
		// a claim this table is in no position to make.
		for (const entry of CATALOGUE) {
			for (const half of [entry.fast, entry.prose]) {
				expect(half.price.input, entry.id).toBeGreaterThan(0);
				expect(half.price.output, entry.id).toBeGreaterThan(0);
			}
		}
	});

	it("never runs the dear model on the cheap job", () => {
		// The pairing is the whole point: a row whose bookkeeping model costs more
		// than its writing model has them the wrong way round.
		for (const entry of CATALOGUE) {
			expect(entry.fast.price.output, entry.id).toBeLessThanOrEqual(entry.prose.price.output);
		}
	});

	it("is ordered cheapest first", () => {
		// The list is walked with the arrow keys and has no other ordering cue, so a
		// row out of order reads as noise rather than as a scale.
		const ratios = CATALOGUE.map((entry) => costRatio(entry));
		for (let i = 1; i < ratios.length; i++) {
			expect(ratios[i], CATALOGUE[i]?.id).toBeGreaterThanOrEqual(ratios[i - 1] as number);
		}
	});

	it("prices the default at exactly one", () => {
		expect(costRatio(defaultChoice())).toBeCloseTo(1);
		expect(costLabel(defaultChoice())).toContain("the default");
	});

	it("says which way the dearest and cheapest rows go", () => {
		// By id, so a row quietly dropped from the table fails here rather than
		// falling back to the default and comparing it against itself.
		expect(CATALOGUE.map((entry) => entry.id)).toContain("glm");
		expect(costRatio(modelChoice("claude-sonnet"))).toBeGreaterThan(1);
		expect(costRatio(modelChoice("glm"))).toBeLessThan(1);
	});

	it("falls back to the default rather than to nothing", () => {
		// A settings file naming a model that has since been dropped from the table
		// must start the game, not stop it.
		expect(modelChoice("a-model-that-was-retired").id).toBe(DEFAULT_MODEL_SET);
		expect(modelChoice(undefined).id).toBe(DEFAULT_MODEL_SET);
	});

	it("writes a price a person can read", () => {
		expect(priceLine({ input: 0.3, output: 2.5 })).toBe("$0.30 in / $2.50 out per Mtok");
	});

	it("covers the providers the game claims to offer", () => {
		const providers = CATALOGUE.map((entry) => entry.provider).join(" ");
		expect(providers).toContain("Google");
		expect(providers).toContain("Anthropic");
		expect(providers).toContain("OpenAI");
		expect(CATALOGUE.some((entry) => entry.openWeights)).toBe(true);
	});
});
