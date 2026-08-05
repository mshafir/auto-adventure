import { describe, expect, it } from "vitest";
import { formatDate, formatWhen } from "./when.js";

const NOW = Date.parse("2026-08-05T12:00:00.000Z");
const ago = (ms: number) => formatWhen(NOW - ms, NOW);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatWhen", () => {
	it("says how long ago in the coarsest unit that still distinguishes", () => {
		expect(ago(20 * SECOND)).toBe("just now");
		expect(ago(3 * MINUTE)).toBe("3 minutes ago");
		expect(ago(5 * HOUR)).toBe("5 hours ago");
		expect(ago(30 * HOUR)).toBe("yesterday");
		expect(ago(4 * DAY)).toBe("4 days ago");
		expect(ago(20 * DAY)).toBe("2 weeks ago");
		expect(ago(100 * DAY)).toBe("3 months ago");
		expect(ago(800 * DAY)).toBe("2 years ago");
	});

	it("says one of a thing rather than 1 things", () => {
		expect(ago(MINUTE)).toBe("1 minute ago");
		expect(ago(HOUR)).toBe("1 hour ago");
		expect(ago(8 * DAY)).toBe("1 week ago");
	});

	// Rounding down throughout, so nothing ever claims to be older than it is.
	it("rounds down at every boundary", () => {
		expect(ago(HOUR - SECOND)).toBe("59 minutes ago");
		expect(ago(DAY - SECOND)).toBe("23 hours ago");
		expect(ago(2 * DAY - SECOND)).toBe("yesterday");
		expect(ago(2 * DAY)).toBe("2 days ago");
	});

	/*
	 * A save file copied from another machine, or a clock that moved. "in the
	 * future" would be true and useless on a screen whose whole job is telling two
	 * worlds apart.
	 */
	it("does not claim a save is from the future", () => {
		expect(formatWhen(NOW + 10 * DAY, NOW)).toBe("just now");
	});
});

describe("formatDate", () => {
	it("reads an ISO timestamp as a date", () => {
		// The exact wording is the reader's locale, so this checks the pieces rather
		// than a format nobody chose.
		const shown = formatDate("2026-07-12T09:00:00.000Z");
		expect(shown).toContain("2026");
		expect(shown).toMatch(/12/);
	});

	it("has nothing to say about a save that never recorded one", () => {
		// A save from before `createdAt` was surfaced is still a world worth resuming;
		// the card simply carries one fewer part.
		expect(formatDate(undefined)).toBeUndefined();
		expect(formatDate("not a date")).toBeUndefined();
	});
});
