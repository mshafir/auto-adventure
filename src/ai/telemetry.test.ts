import { beforeEach, describe, expect, it } from "vitest";
import { CATALOGUE } from "./catalogue.js";
import {
	estimatedCost,
	isPriced,
	money,
	recordCall,
	recordFailure,
	resetTelemetry,
	telemetrySnapshot,
	tokens,
} from "./telemetry.js";

/**
 * What a run cost, which is the number a player is deciding about while they watch it.
 *
 * The property worth pinning is the one that was quietly false: every model the
 * launcher offers has to be priceable. This file used to carry two hard-coded rows, so
 * choosing any of the other twelve produced a bill of exactly $0.00 — reported
 * confidently, in yellow, on a screen whose whole job is to say what the world cost.
 */

beforeEach(() => {
	resetTelemetry();
});

describe("what a call costs", () => {
	it("prices every model the launcher will let somebody choose", () => {
		for (const choice of CATALOGUE) {
			expect(isPriced(choice.fast.model), `${choice.id} fast`).toBe(true);
			expect(isPriced(choice.prose.model), `${choice.id} prose`).toBe(true);
		}
	});

	it("charges input and output at their own rates", () => {
		// A million in and a million out of the default pair, so the arithmetic is
		// readable rather than merely asserted.
		const model = "google/gemini-2.5-flash";
		expect(estimatedCost(model, 1_000_000, 0)).toBeCloseTo(0.3, 6);
		expect(estimatedCost(model, 0, 1_000_000)).toBeCloseTo(2.5, 6);
	});

	it("says nothing rather than guessing for a model it has never heard of", () => {
		// Understating is the only honest failure here. Inventing an average would put a
		// number on screen that reads exactly like a real one.
		expect(estimatedCost("someone/unreleased-7b", 1_000_000, 1_000_000)).toBe(0);
	});
});

describe("the running total", () => {
	it("adds up calls, tokens and dollars across kinds", () => {
		recordCall(
			"site",
			"google/gemini-2.5-flash-lite",
			{ inputTokens: 1000, outputTokens: 500 },
			120,
		);
		recordCall(
			"dialogue",
			"google/gemini-2.5-flash",
			{ inputTokens: 2000, outputTokens: 400 },
			800,
		);

		const snapshot = telemetrySnapshot();
		expect(snapshot.calls).toBe(2);
		expect(snapshot.totalTokens).toBe(3900);
		expect(snapshot.totalCost).toBeCloseTo(
			(1000 * 0.1 + 500 * 0.4) / 1e6 + (2000 * 0.3 + 400 * 2.5) / 1e6,
			9,
		);
	});

	it("prices each call at its own model, not the bucket's last one", () => {
		// The model set can change inside one session — `MODELS` is read through a getter
		// precisely so it can — and costing a whole bucket at whatever was current when
		// somebody asked for the total would be wrong by a factor of the price gap.
		recordCall("site", "google/gemini-2.5-flash-lite", { inputTokens: 1_000_000 }, 10);
		recordCall("site", "anthropic/claude-sonnet-5", { inputTokens: 1_000_000 }, 10);
		expect(telemetrySnapshot().totalCost).toBeCloseTo(0.1 + 2.0, 6);
	});

	it("counts a failure without pretending it produced anything", () => {
		recordFailure("region", "google/gemini-2.5-flash", new Error("timed out"));
		const snapshot = telemetrySnapshot();
		expect(snapshot.failures).toBe(1);
		expect(snapshot.calls).toBe(0);
		expect(snapshot.totalCost).toBe(0);
	});
});

describe("numbers a person can read", () => {
	it("keeps the interesting digits of a world that costs cents", () => {
		// Two decimal places would print $0.00 for most of a run: technically true and
		// useless for deciding whether the model just chosen is dear.
		expect(money(0.0213)).toBe("$0.0213");
		expect(money(0)).toBe("$0");
		expect(money(3.5)).toBe("$3.50");
	});

	it("abbreviates token counts once they stop being readable", () => {
		expect(tokens(940)).toBe("940");
		expect(tokens(12_400)).toBe("12.4k");
		expect(tokens(2_500_000)).toBe("2.50M");
	});
});
