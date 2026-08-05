/**
 * Whether this world has a clock, and what it does.
 *
 * The time of day is one of the cheapest things in the game that makes a village feel
 * inhabited — schedules, lamplight, a sky that changes — but it is not something every
 * game wants. A single-afternoon mystery, a dungeon crawl, a puzzle box: for those a
 * clock is a thing the player has to work around rather than something the story uses,
 * and a village that empties at 22:00 is an obstacle.
 *
 * So it is configuration, and it is *four* switches rather than one. They come apart in
 * practice: a game can want lamplight without schedules, or schedules without weather.
 * `enabled: false` freezes the whole thing; the rest turn off one consequence each.
 *
 * The tick keeps counting either way. It is an action counter, not a clock — the journal
 * orders entries on it and `weatherAt` samples noise along it — so stopping it would
 * break two things that have nothing to do with the time of day. What a frozen clock
 * does is stop deriving an hour from it.
 */
export interface WorldTime {
	/** Advances one per player action. */
	readonly tick: number;
	readonly day: number;
	/** 0..23. Drives lighting and NPC schedules. */
	readonly hour: number;
	/**
	 * 0..59. Display only — nothing schedules on it.
	 *
	 * A tick is a minute, so an hour is sixty player actions. Showing only the hour
	 * left the clock reading 08:00 for a solid minute of play, which looks stopped
	 * rather than slow.
	 */
	readonly minute: number;
}

/**
 * A world's clock settings, as an author writes them.
 *
 * Partial, and stored partial the way a pack override is: almost every world says
 * nothing at all, and the one that turns the clock off writes one line.
 */
export interface TimeOptions {
	/** Whether the hour advances. False freezes it at {@link TimeOptions.startHour}. */
	readonly enabled?: boolean;
	/** The hour a new world opens at, and the hour a frozen clock sits at. */
	readonly startHour?: number;
	/** Player actions per hour. Sixty means a tick is a minute. */
	readonly ticksPerHour?: number;
	/** Day/night tint. Defaults to whether the clock runs at all. */
	readonly lighting?: boolean;
	/** Whether people move about the day. Defaults to whether the clock runs. */
	readonly schedules?: boolean;
	/**
	 * Rain, fog and snow. Defaults on even with the clock off.
	 *
	 * Independent of the clock on purpose: weather is sampled along the tick, which
	 * keeps counting, so a world with no time of day can still have a sky. A game that
	 * wants neither says so.
	 */
	readonly weather?: boolean;
}

/** How many ticks make an hour, when nobody says otherwise. */
export const TICKS_PER_HOUR = 60;

/** A new world opens at eight in the morning, not at midnight. */
export const DEFAULT_START_HOUR = 8;

/** The tick a new world starts on, so its first frame reads as morning. */
export function startTick(time?: TimeOptions): number {
	return (time?.startHour ?? DEFAULT_START_HOUR) * (time?.ticksPerHour ?? TICKS_PER_HOUR);
}

/** Kept for the saves and tests written before the clock was configurable. */
export const START_TICK = DEFAULT_START_HOUR * TICKS_PER_HOUR;

/**
 * Derive the calendar from the action counter.
 *
 * Day, hour and minute are all functions of the tick and nothing else, which is what
 * makes the clock free to store — and what makes freezing it a matter of not doing the
 * arithmetic rather than of maintaining a second kind of state.
 *
 * Written without building a resolved config object, because this runs on every step.
 */
export function timeFromTick(tick: number, time?: TimeOptions): WorldTime {
	if (time?.enabled === false) {
		// The tick still moves; the calendar does not. Day one, on the hour, forever.
		return { tick, day: 1, hour: time.startHour ?? DEFAULT_START_HOUR, minute: 0 };
	}
	const perHour = time?.ticksPerHour ?? TICKS_PER_HOUR;
	const totalHours = Math.floor(tick / perHour);
	return {
		tick,
		day: 1 + Math.floor(totalHours / 24),
		hour: totalHours % 24,
		minute: tick % perHour,
	};
}

/** Whether there is a time of day worth showing the player. */
export function clockRuns(time?: TimeOptions): boolean {
	return time?.enabled !== false;
}

/** Whether the map is tinted by the hour. */
export function lightingRuns(time?: TimeOptions): boolean {
	return time?.lighting ?? clockRuns(time);
}

/** Whether people move between stations as the day goes on. */
export function schedulesRun(time?: TimeOptions): boolean {
	return time?.schedules ?? clockRuns(time);
}

/** Whether the sky does anything. On by default even with the clock frozen. */
export function weatherRuns(time?: TimeOptions): boolean {
	return time?.weather ?? true;
}
