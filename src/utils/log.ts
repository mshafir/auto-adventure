import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * The TUI owns stdout, so logs go to a file. `LOG_LEVEL` gates them and
 * `LOG_FILE` relocates them; both default to something sane for a dev run.
 */
const threshold = LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? "info"] ?? LEVELS.info;
const logFile = process.env.LOG_FILE ?? "log.txt";

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
	if (LEVELS[level] < threshold) return;
	const extra = params.length > 0 ? ` ${params.map(format).join(" ")}` : "";
	write(`[${new Date().toISOString()}] ${level.toUpperCase()} ${format(data)}${extra}\n`);
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
