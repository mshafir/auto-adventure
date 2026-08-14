import { describe, expect, it } from "vitest";
import type { Scene } from "./scene.js";
import { MIN_VISIBLE_HOLD, sceneEffectProblems, scenePacingProblems } from "./scene-check.js";

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

/*
 * Written after a shipped scene turned out to be unwatchable. Every other check passed: it
 * staged, it reached its end, nothing repeated. It simply spawned a rider and held him for
 * three frames — a quarter of a second — before sending him off at a gallop, so what the
 * scene existed to show was over before the player's eye had found him.
 */
describe("scenePacingProblems", () => {
	const RIDER = { t: "Spawn", actor: "rider", at: { kind: "world", x: 0, y: 0 } } as const;

	it("complains about somebody appearing and the scene moving straight on", () => {
		const [problem, ...rest] = scenePacingProblems(sceneWith([{ do: [RIDER] }]));
		expect(rest).toEqual([]);
		expect(problem).toContain("Spawn rider");
		// The message has to carry the fix, because the author's next question is "how long?".
		expect(problem).toContain(`"hold": ${MIN_VISIBLE_HOLD}`);
	});

	it("is satisfied by a hold long enough to see", () => {
		expect(scenePacingProblems(sceneWith([{ do: [RIDER], hold: MIN_VISIBLE_HOLD }]))).toEqual([]);
	});

	it("still complains about a hold that is there but too short", () => {
		expect(scenePacingProblems(sceneWith([{ do: [RIDER], hold: 3 }]))).toHaveLength(1);
	});

	it("says nothing when something in the step takes time of its own", () => {
		// A walk, a wait, a line and a pan all keep the frame up long enough for whatever
		// appeared beside them to be looked at.
		const alongside = [
			{ t: "WalkTo", actor: "rider", to: { kind: "world", x: 4, y: 0 } },
			{ t: "Wait", ticks: 10 },
			{ t: "Say", actor: "rider", text: "Here." },
			{ t: "Camera", to: { kind: "world", x: 9, y: 9 }, pan: "slow" },
		] as const;
		for (const action of alongside) {
			expect(scenePacingProblems(sceneWith([{ do: [RIDER, action] }])), action.t).toEqual([]);
		}
	});

	it("counts a camera cut as something that needs to be held", () => {
		// A cut is the one camera move that is over in a frame, so on its own it is a shot
		// nobody was given time to read.
		const cut = { t: "Camera", to: { kind: "world", x: 9, y: 9 }, pan: "cut" } as const;
		expect(scenePacingProblems(sceneWith([{ do: [cut] }]))).toHaveLength(1);
		expect(scenePacingProblems(sceneWith([{ do: [cut], hold: 6 }]))).toEqual([]);
	});

	it("leaves a step that changes nothing visible alone", () => {
		// Setting a flag is not a shot. It has nothing to be looked at, so it needs no time.
		const scene = sceneWith([
			{ do: [{ t: "Effects", effects: [{ t: "SetFlag", key: "flood", value: true }] }] },
		]);
		expect(scenePacingProblems(scene)).toEqual([]);
	});

	it("names the step and how many there are, so it can be found in the file", () => {
		const scene = sceneWith([
			{ do: [{ t: "Say", actor: "rider", text: "One." }] },
			{ do: [RIDER] },
		]);
		expect(scenePacingProblems(scene)[0]).toContain("step 2 of 2");
	});
});
