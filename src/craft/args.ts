/**
 * What one command line means.
 *
 * Its own module, and pure, because the consumer of this CLI is an agent rather than a
 * person: a flag that is silently ignored costs a whole authoring round to notice, and a
 * message that says "invalid arguments" costs another to diagnose. Every reader below names
 * the option it was looking for and what it wanted, and an unknown flag is refused outright
 * rather than dropped.
 */

/** A raw command line, split but not yet interpreted. */
export interface ParsedArgs {
	/** Everything before the first flag, so `scene new x` is `["scene", "new", "x"]`. */
	readonly words: readonly string[];
	/** Flag values, in the order given. A bare flag holds one empty string. */
	readonly flags: ReadonlyMap<string, readonly string[]>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
	const words: string[] = [];
	const flags = new Map<string, string[]>();
	let seenFlag = false;

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] as string;
		if (!token.startsWith("--")) {
			// A positional after a flag belongs to that flag — `--path 4,4 9,9` takes two — so
			// only the leading run of bare words is a verb.
			if (!seenFlag) words.push(token);
			continue;
		}
		seenFlag = true;
		const body = token.slice(2);
		const equals = body.indexOf("=");
		const key = equals >= 0 ? body.slice(0, equals) : body;
		const inline = equals >= 0 ? body.slice(equals + 1) : undefined;
		const values = flags.get(key) ?? [];
		flags.set(key, values);

		if (inline !== undefined) {
			values.push(inline);
			continue;
		}
		// Every following bare word, so a flag can take several values without being repeated.
		let taken = 0;
		while (i + 1 < argv.length && !(argv[i + 1] as string).startsWith("--")) {
			values.push(argv[++i] as string);
			taken++;
		}
		// A flag with nothing after it is a switch. Recorded as present-and-empty rather than
		// absent, so `bool` can tell "not given" from "given".
		if (taken === 0) values.push("");
	}

	return { words, flags };
}

/**
 * Refused, with a reason a caller can act on.
 *
 * The exit code is part of the contract: 1 means the scenario is fine and the request was
 * not, 2 means the scenario could not be read at all. An agent retries the first and stops
 * for the second.
 */
export class CraftError extends Error {
	constructor(
		message: string,
		readonly code: 1 | 2 = 1,
	) {
		super(message);
		this.name = "CraftError";
	}
}

export interface Point {
	readonly x: number;
	readonly y: number;
}

/**
 * Typed access to a parsed command line.
 *
 * `known` is declared up front so that a misspelled flag is refused rather than ignored.
 * That matters more here than in a hand-typed CLI: an agent that writes `--desc` where the
 * verb wanted `--description` gets a scenario missing a description and no indication why.
 */
export class Args {
	private readonly used = new Set<string>();

	/**
	 * @param verbWords How many leading words the verb itself took.
	 *
	 * Two for `npc add`, one for `claim`. Without it every two-word command reads its scenario
	 * id from the wrong position and complains that there is no scenario called "add" — which
	 * is exactly what happened the first time this CLI was run end to end.
	 */
	constructor(
		private readonly parsed: ParsedArgs,
		private readonly verbWords = 1,
	) {}

	/** The first word after the verb, which is always the scenario id. */
	target(verb: string): string {
		const id = this.parsed.words[this.verbWords];
		if (!id) throw new CraftError(`craft ${verb} wants a scenario id`);
		return id;
	}

	/** The verb words, e.g. `["scene", "new"]`. */
	get words(): readonly string[] {
		return this.parsed.words;
	}

	has(key: string): boolean {
		this.used.add(key);
		return this.parsed.flags.has(key);
	}

	/** Every value given for a flag, in order. Empty when the flag was absent. */
	list(key: string): readonly string[] {
		this.used.add(key);
		return (this.parsed.flags.get(key) ?? []).filter((value) => value !== "");
	}

	/**
	 * One value, and refuses several.
	 *
	 * The refusal is the point. A flag takes every bare word after it, so an unquoted
	 * `--name Ash Hollow` arrives as two values — and silently keeping the first would name the
	 * town "Ash" with nothing anywhere to say why. An agent writing these calls cannot see the
	 * shell quoting it got wrong; this is where it finds out.
	 */
	str(key: string, fallback?: string): string {
		const values = this.list(key);
		if (values.length > 1) {
			throw new CraftError(
				`--${key} wants one value but got ${values.length} ("${values.join(" ")}") — quote it`,
			);
		}
		const value = values[0];
		if (value === undefined) {
			if (fallback !== undefined) return fallback;
			throw new CraftError(`--${key} is required`);
		}
		return value;
	}

	int(key: string, fallback?: number): number {
		const values = this.list(key);
		const raw = values[0];
		if (raw === undefined) {
			if (fallback !== undefined) return fallback;
			throw new CraftError(`--${key} is required`);
		}
		const value = Number(raw);
		if (!Number.isInteger(value))
			throw new CraftError(`--${key} wants a whole number, not "${raw}"`);
		return value;
	}

	/** A switch. True when the flag is present at all, however it was written. */
	bool(key: string): boolean {
		this.used.add(key);
		return this.parsed.flags.has(key);
	}

	/** `x,y`, which is how every position on a command line is written. */
	point(key: string, index = 0): Point {
		const values = this.list(key);
		const raw = values[index];
		if (raw === undefined) throw new CraftError(`--${key} wants ${index + 1} position(s) as x,y`);
		const [x, y] = raw.split(",").map((part) => Number(part.trim()));
		if (!Number.isInteger(x) || !Number.isInteger(y)) {
			throw new CraftError(`--${key} wants a position as x,y — "${raw}" is not one`);
		}
		return { x: x as number, y: y as number };
	}

	oneOf<T extends string>(key: string, allowed: readonly T[], fallback?: T): T {
		const value = this.str(key, fallback);
		if (!allowed.includes(value as T)) {
			throw new CraftError(`--${key} wants one of ${allowed.join(", ")} — not "${value}"`);
		}
		return value as T;
	}

	/**
	 * Refuse a flag nothing asked about.
	 *
	 * Called once at the end of a verb, after every reader has run, so the set of asked-about
	 * keys is complete. A silently-dropped flag is the worst failure a CLI can have when its
	 * caller is a program: the call succeeds and the world is not what was asked for.
	 */
	refuseUnknown(): void {
		const unknown = [...this.parsed.flags.keys()].filter((key) => !this.used.has(key));
		if (unknown.length === 0) return;
		throw new CraftError(
			`this command does not take ${unknown.map((key) => `--${key}`).join(", ")}`,
		);
	}
}
