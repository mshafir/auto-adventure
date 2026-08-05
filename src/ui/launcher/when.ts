/**
 * How long ago something was, in words.
 *
 * The Continue page exists to answer "which of these is the one I was playing",
 * and a wall-clock timestamp answers it badly: `2026-07-31 22:14` requires the
 * reader to know today's date and do the subtraction. "yesterday" does not.
 *
 * Deliberately coarse, and coarser the further back it goes. The difference
 * between four and five minutes ago does not distinguish two saves; the difference
 * between yesterday and three weeks ago does. Rounding down throughout, so nothing
 * ever claims to be older than it is.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** `now` is passed in rather than read, so the result is testable and pure. */
export function formatWhen(at: number, now: number): string {
	const ago = now - at;

	// A save written moments ago while the clock skewed, or a file copied in from
	// another machine. "in the future" would be true and useless.
	if (ago < 0) return "just now";
	if (ago < MINUTE) return "just now";
	if (ago < HOUR) return plural(Math.floor(ago / MINUTE), "minute");
	if (ago < DAY) return plural(Math.floor(ago / HOUR), "hour");
	if (ago < 2 * DAY) return "yesterday";
	if (ago < WEEK) return plural(Math.floor(ago / DAY), "day");
	if (ago < MONTH) return plural(Math.floor(ago / WEEK), "week");
	if (ago < YEAR) return plural(Math.floor(ago / MONTH), "month");
	return plural(Math.floor(ago / YEAR), "year");
}

function plural(count: number, unit: string): string {
	return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/**
 * The date itself, for the line that says when a world was *made*.
 *
 * "created 3 months ago" and "last played 3 months ago" side by side read as the
 * same fact twice. A date does not, and for the older of the two it is the more
 * useful thing anyway.
 *
 * `toLocaleDateString` rather than a chosen format: this is the one string on the
 * screen the player already has an expectation about.
 */
export function formatDate(iso: string | undefined): string | undefined {
	if (!iso) return undefined;
	const at = Date.parse(iso);
	if (Number.isNaN(at)) return undefined;
	return new Date(at).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}
