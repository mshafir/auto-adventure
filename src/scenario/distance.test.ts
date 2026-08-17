import { describe, expect, it } from "vitest";
import { BANDS, describeReach, reachOf, TOO_CLOSE, tilesBetween } from "./distance.js";

/*
 * A number of tiles is not a decision.
 *
 * The first world built this way put its two towns forty-seven tiles apart. Every check
 * passed; what a player saw was one settlement with a field through the middle and two names
 * on it. Nothing had ever written down what a distance *means*, so every placement decision
 * was being made against a number with no interpretation attached.
 */
describe("the bands", () => {
	it("ascend, and start at nothing", () => {
		expect(BANDS[0]?.from).toBe(0);
		for (let i = 1; i < BANDS.length; i++) {
			expect(BANDS[i]?.from, BANDS[i]?.reach).toBeGreaterThan(BANDS[i - 1]?.from ?? 0);
		}
	});

	it("says what every distance is, including a silly one", () => {
		expect(reachOf(0).reach).toBe("adjacent");
		expect(reachOf(47).reach).toBe("adjacent");
		expect(reachOf(TOO_CLOSE).reach).toBe("neighbouring");
		expect(reachOf(200).reach).toBe("a walk");
		expect(reachOf(9_000).reach).toBe("far");
	});

	it("puts the shortest real walk exactly at the floor the checks use", () => {
		// One number, so the tool that refuses and the guide that explains cannot drift apart.
		expect(reachOf(TOO_CLOSE - 1).reach).toBe("adjacent");
		expect(BANDS.some((band) => band.from === TOO_CLOSE)).toBe(true);
	});

	it("names the band and gives the number, because an author needs both", () => {
		expect(describeReach(168)).toBe("a walk (168)");
	});

	it("measures straight-line tiles, rounded", () => {
		expect(tilesBetween({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
		expect(tilesBetween({ x: -10, y: 0 }, { x: 10, y: 0 })).toBe(20);
	});

	it("explains every band, because the reach alone is not advice", () => {
		for (const band of BANDS) {
			expect(band.means.length, band.reach).toBeGreaterThan(20);
		}
	});
});
