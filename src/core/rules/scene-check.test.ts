import { describe, expect, it } from "vitest";
import type { Scene } from "./scene.js";
import { sceneEffectProblems } from "./scene-check.js";

function sceneWith(steps: Scene["steps"]): Scene {
	return { id: "a-scene", steps };
}

const LEDGER = {
	t: "GrantItem",
	name: "Ledger",
	description: "Damp at the corners.",
	quantity: 1,
} as const;

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
			{ do: [{ t: "Effects", effects: [LEDGER] }] },
			{ do: [{ t: "Say", actor: "player", text: "Heavy." }] },
		]);
		expect(sceneEffectProblems(scene)).toEqual([
			'scene a-scene grants "Ledger" in step 1 of 2; an interrupted scene replays, ' +
				"so GrantItem may only appear in the last step",
		]);
	});

	it("allows the same grant in the last step", () => {
		const scene = sceneWith([
			{ do: [{ t: "Say", actor: "player", text: "Heavy." }] },
			{ do: [{ t: "Effects", effects: [LEDGER] }] },
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
		expect(sceneEffectProblems(sceneWith([{ do: [{ t: "Effects", effects: [LEDGER] }] }]))).toEqual(
			[],
		);
	});

	it("leaves the idempotent effects alone wherever they appear", () => {
		// The whole closed set of what a scene may safely do more than once. If a new
		// DomainEffect is added that accumulates, this test keeps passing and the rule has to
		// be extended by hand — which is why REPEATABLE_EFFECTS is spelled out rather than
		// derived.
		const scene = sceneWith([
			{
				do: [
					{
						t: "Effects",
						effects: [
							{ t: "SetFlag", key: "seen", value: true },
							{ t: "OpenBarrier", id: "abbey-gate" },
							{ t: "Teleport", x: 3, y: 4 },
							{ t: "CompleteQuest", id: "the-errand" },
						],
					},
				],
			},
			{ do: [{ t: "Say", actor: "player", text: "Open." }] },
		]);
		expect(sceneEffectProblems(scene)).toEqual([]);
	});

	it("looks inside every action of a step, not only the first", () => {
		const scene = sceneWith([
			{
				do: [
					{ t: "Say", actor: "player", text: "Wait." },
					{ t: "Effects", effects: [LEDGER] },
				],
			},
			{ do: [{ t: "Say", actor: "player", text: "There." }] },
		]);
		expect(sceneEffectProblems(scene)).toHaveLength(1);
	});
});
