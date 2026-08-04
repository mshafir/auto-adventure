import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type GameState, SAVE_VERSION } from "../core/rules/state.js";
import { logger } from "../utils/log.js";
import { migrateSave } from "./migrate.js";

export function saveRoot(): string {
	return process.env.AUTO_ADVENTURE_HOME ?? join(homedir(), ".auto-adventure");
}

/**
 * Write via a temporary file and rename into place.
 *
 * A crash mid-write leaves the previous contents intact rather than a truncated
 * file. Shared with the scenario repository, which has the same requirement for
 * the same reason.
 */
export function writeFileAtomic(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp`;
	writeFileSync(temp, contents, "utf8");
	try {
		renameSync(temp, path);
	} catch (error) {
		if (existsSync(temp)) unlinkSync(temp);
		throw error;
	}
}

export function savePath(worldId: string): string {
	return join(saveRoot(), "saves", worldId, "save.json");
}

export interface SaveSummary {
	readonly worldId: string;
	readonly name: string;
	readonly seed: number;
	readonly at: { readonly x: number; readonly y: number };
	readonly day: number;
	readonly scenarioId?: string;
	/** Modification time, for ordering. Most recently played first. */
	readonly playedAt: number;
}

/**
 * Every world that can be resumed.
 *
 * Each candidate goes through `migrateSave`, so a save the game could not
 * actually load is not offered — the launcher must never present a world that
 * turns out to be unopenable, or a retired save would look like a lost one.
 */
export function listSaves(): SaveSummary[] {
	const root = join(saveRoot(), "saves");
	if (!existsSync(root)) return [];

	const summaries: SaveSummary[] = [];
	for (const worldId of readdirSync(root)) {
		const path = savePath(worldId);
		if (!existsSync(path)) continue;
		let state: GameState | undefined;
		try {
			state = migrateSave(JSON.parse(readFileSync(path, "utf8")));
		} catch {
			state = undefined;
		}
		if (!state) continue;
		summaries.push({
			worldId,
			name: state.world.name,
			seed: state.world.seed,
			at: { x: state.player.x, y: state.player.y },
			day: state.time.day,
			...(state.world.scenarioId ? { scenarioId: state.world.scenarioId } : {}),
			playedAt: statSync(path).mtimeMs,
		});
	}
	summaries.sort((a, b) => b.playedAt - a.playedAt);
	return summaries;
}

/**
 * Reads and writes the whole save.
 *
 * Writes go to a temporary file and are renamed into place, so a crash mid-write
 * leaves the previous save intact rather than a truncated one. The old design
 * did a synchronous `writeFileSync` of the entire state after *every* action,
 * including every step the player took.
 */
export class SaveRepository {
	private dirty = false;
	private timer: NodeJS.Timeout | undefined;
	private latest: GameState | undefined;

	constructor(private readonly debounceMs = 2000) {}

	load(worldId: string): GameState | undefined {
		const path = savePath(worldId);
		if (!existsSync(path)) return undefined;
		try {
			const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
			return migrateSave(raw);
		} catch (error) {
			logger.error("failed to read save; starting fresh", error);
			return undefined;
		}
	}

	/** Queue a debounced write. Repeated calls coalesce into one. */
	schedule(state: GameState): void {
		this.latest = state;
		this.dirty = true;
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.flush();
		}, this.debounceMs);
		// Do not hold the process open purely to write a save.
		this.timer.unref?.();
	}

	/** Write immediately if anything is pending. Safe to call repeatedly. */
	flush(): void {
		if (!this.dirty || !this.latest) return;
		const state = this.latest;
		this.dirty = false;
		try {
			writeFileAtomic(savePath(state.world.id), JSON.stringify(state));
		} catch (error) {
			logger.error("failed to write save", error);
			// Keep the state pending so a later flush can retry.
			this.dirty = true;
		}
	}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.flush();
	}
}

export function isCurrentVersion(state: { version?: number }): boolean {
	return state.version === SAVE_VERSION;
}
