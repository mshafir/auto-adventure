import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type GameState, SAVE_VERSION, worldAnchor } from "../core/rules/state.js";
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
	/**
	 * When the world was made, as the ISO string the state has carried all along.
	 *
	 * Surfaced because the Continue page has to answer "which of these is which",
	 * and two worlds last played the same evening are told apart by their age.
	 * Optional: a save from before the field existed has none, and that is a world
	 * worth still being able to resume.
	 */
	readonly createdAt?: string;
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
			at: worldAnchor(state.player),
			day: state.time.day,
			...(state.world.scenarioId ? { scenarioId: state.world.scenarioId } : {}),
			playedAt: statSync(path).mtimeMs,
			...(state.world.createdAt ? { createdAt: state.world.createdAt } : {}),
		});
	}
	summaries.sort((a, b) => b.playedAt - a.playedAt);
	return summaries;
}

/**
 * Throw a world away, for good.
 *
 * The whole slot directory, not just `save.json`: leaving the folder behind would
 * make the world invisible in the launcher while still holding its name, so a new
 * world of the same name would be uniquified to `hollowmoor-2` for no reason the
 * player could see.
 *
 * Guarded against deleting anything that is not a save slot. `worldId` reaches
 * this from a save the launcher listed, so it is already trustworthy — but this is
 * a recursive delete under the player's home directory, and a path separator
 * arriving here from somewhere else must not be able to walk out of the saves
 * folder. Cheap insurance against a mistake that has no undo.
 */
export function deleteSave(worldId: string): boolean {
	if (!worldId || worldId.includes("/") || worldId.includes("\\") || worldId.includes("..")) {
		logger.error(`refusing to delete a save called "${worldId}"`);
		return false;
	}
	const dir = join(saveRoot(), "saves", worldId);
	if (!existsSync(dir)) return false;
	try {
		rmSync(dir, { recursive: true, force: true });
		return true;
	} catch (error) {
		logger.error(`failed to delete save "${worldId}"`, error);
		return false;
	}
}

export interface SaveOptions {
	/**
	 * Whether to write anything at all. Default yes.
	 *
	 * Off for a session built to ask a question rather than to be played: walking a story,
	 * validating a scenario, settling one. It lives here rather than in a rule about not
	 * calling `dispose` because `dispose` *flushes* — so the caller who tidied up properly
	 * would be the one who left a world behind, and `listSaves` has no filter to hide it
	 * from the Continue list.
	 */
	readonly persist?: boolean;
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
	private readonly persist: boolean;

	constructor(
		private readonly debounceMs = 2000,
		options: SaveOptions = {},
	) {
		this.persist = options.persist ?? true;
	}

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
		// Nothing is ever held pending, so `flush` and `dispose` need no guard of their own —
		// which is the point of refusing here rather than there.
		if (!this.persist) return;
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
			writeFileAtomic(savePath(state.world.id), JSON.stringify(withoutPlayingScene(state)));
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

/**
 * The state as it goes to disk: everything except the scene currently playing.
 *
 * A scene is the one part of `GameState` that must not survive a reload. Its steps are
 * applied as they run, so resuming from the middle of one would mean either replaying the
 * effects already applied or skipping the ones still to come — and the whole design picks
 * neither: an interrupted scene replays from its first step, which is safe precisely
 * because the trigger that opened it is still unfired and its non-idempotent effects are
 * confined to its last step.
 *
 * Done here, at the one place anything is written, rather than by the callers. Every caller
 * is a place that does not know a scene exists, and a save written from one of them that
 * happened to carry a half-finished cutscene would be indistinguishable from a good one.
 */
function withoutPlayingScene(state: GameState): GameState {
	if (!state.scene) return state;
	const { scene: playing, ...rest } = state;
	void playing;
	return rest;
}

export function isCurrentVersion(state: { version?: number }): boolean {
	return state.version === SAVE_VERSION;
}
