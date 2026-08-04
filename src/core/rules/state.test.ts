import { describe, expect, it } from "vitest";
import { START_TICK, TICKS_PER_HOUR, timeFromTick } from "./state.js";

describe("the clock", () => {
	/**
	 * A tick is a minute and a tick is one player action, so an hour is sixty
	 * moves. Showing only the hour left the clock reading 08:00 for a solid minute
	 * of play, which reads as stopped rather than slow.
	 */
	it("advances a minute for every action", () => {
		expect(timeFromTick(START_TICK).minute).toBe(0);
		expect(timeFromTick(START_TICK + 1).minute).toBe(1);
		expect(timeFromTick(START_TICK + 37).minute).toBe(37);
	});

	it("rolls the hour over at sixty and not before", () => {
		expect(timeFromTick(START_TICK + 59)).toMatchObject({ hour: 8, minute: 59 });
		expect(timeFromTick(START_TICK + 60)).toMatchObject({ hour: 9, minute: 0 });
	});

	it("rolls the day over at midnight", () => {
		expect(timeFromTick(23 * TICKS_PER_HOUR + 59)).toMatchObject({
			day: 1,
			hour: 23,
			minute: 59,
		});
		expect(timeFromTick(24 * TICKS_PER_HOUR)).toMatchObject({ day: 2, hour: 0, minute: 0 });
	});

	it("keeps every field derivable from the tick alone", () => {
		// Day, hour and minute are never stored independently, which is what lets a
		// save be repaired by recomputing them.
		for (const tick of [0, 1, 59, 60, 1439, 1440, 100_000]) {
			const time = timeFromTick(tick);
			expect(time.tick).toBe(tick);
			expect(time.hour * TICKS_PER_HOUR + time.minute + (time.day - 1) * 24 * TICKS_PER_HOUR).toBe(
				tick,
			);
		}
	});
});
