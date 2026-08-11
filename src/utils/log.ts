import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * The TUI owns stdout, so logs go to a file. `LOG_LEVEL` gates them and
 * `LOG_FILE` relocates them; both default to something sane for a dev run.
 *
 * Two sinks rather than one, and they deliberately disagree about what counts. The
 * *file* is for whoever set `LOG_LEVEL`. The *ring* below is for the working view, which
 * wants the debug lines whether or not anybody asked the file for them — and a file is
 * not somewhere a player can read from anyway, since they are inside a full-screen
 * terminal application at the time.
 *
 * This replaces a worse arrangement, where asking for the prompt-by-prompt view lowered
 * the file's threshold globally for the rest of the run. That made `log.txt` grow on
 * every run that wanted the view, and still showed the player nothing.
 *
 * `setLogLevel` stays, because `LOG_LEVEL=debug` is still how somebody asks the *file*
 * for everything.
 */
let threshold = LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? "info"] ?? LEVELS.info;
const logFile = process.env.LOG_FILE ?? "log.txt";

export interface LogLine {
	/** Epoch milliseconds, so a reader can see the gap between two lines. */
	readonly at: number;
	readonly level: LogLevel;
	/** The formatted line, without the timestamp and level the file prefixes. */
	readonly text: string;
}

/**
 * How many lines the ring holds.
 *
 * A generation run writes tens of lines, not thousands; this is sized to hold a whole
 * session of play on top of one. Bounded rather than unbounded because the alternative
 * is a debug feature that eventually ends the session it exists to explain.
 */
export const LOG_RING_LIMIT = 2000;

const ring: LogLine[] = [];
const listeners = new Set<() => void>();

export function logRing(): readonly LogLine[] {
	return ring;
}

/** Reset between tests, and between one generation run and the next. */
export function clearLogRing(): void {
	ring.length = 0;
	announce();
}

export function onLog(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function announce(): void {
	for (const listener of listeners) listener();
}

/**
 * Lower the bar, never raise it.
 *
 * `LOG_LEVEL=debug` on the command line is somebody saying they want everything, and a
 * feature switched off later in the run must not quietly take that away from them.
 */
export function setLogLevel(level: LogLevel): void {
	threshold = Math.min(threshold, LEVELS[level]);
}

let ensuredDir = false;

function write(line: string) {
	if (!ensuredDir) {
		const dir = path.dirname(logFile);
		if (dir && dir !== ".") {
			fs.mkdirSync(dir, { recursive: true });
		}
		ensuredDir = true;
	}
	fs.appendFileSync(logFile, line);
}

function format(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function emit(level: LogLevel, data: unknown, params: unknown[]) {
	const extra = params.length > 0 ? ` ${params.map(format).join(" ")}` : "";
	const text = `${format(data)}${extra}`;
	const at = Date.now();

	/*
	 * The ring first, and unconditionally.
	 *
	 * Formatting eagerly is what this costs, and the early return it replaces was guarding
	 * very little: every `logger.debug` in the codebase runs once per model call, once per
	 * beat or once per authored site — none is inside chunk generation or any per-tile
	 * loop. So the price of a line nobody reads is a template string, and the price of not
	 * paying it is an empty pane on the one view that exists to explain a bad run.
	 */
	ring.push({ at, level, text });
	if (ring.length > LOG_RING_LIMIT) ring.splice(0, ring.length - LOG_RING_LIMIT);
	announce();

	if (LEVELS[level] < threshold) return;
	write(`[${new Date(at).toISOString()}] ${level.toUpperCase()} ${text}\n`);
}

export const logger = {
	debug: (data: unknown, ...params: unknown[]) => emit("debug", data, params),
	info: (data: unknown, ...params: unknown[]) => emit("info", data, params),
	warn: (data: unknown, ...params: unknown[]) => emit("warn", data, params),
	error: (data: unknown, ...params: unknown[]) => emit("error", data, params),
};

/** Back-compat shim for existing call sites; prefer `logger.*`. */
export function log(data: unknown, ...params: unknown[]) {
	emit("info", data, params);
}

export function logChars(data: string) {
	write(data);
}
