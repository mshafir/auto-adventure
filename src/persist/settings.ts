import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The few answers that outlive a world.
 *
 * Everything else the launcher asks is about *this* world and dies with it — the
 * premise, the length, the packs. A gateway key and a choice of model are neither:
 * they are about the machine the game is being played on, and asking for them once
 * per world would be asking for them forever.
 *
 * Kept under the player's home directory rather than in the repository, and
 * deliberately not in `.env.local`. A dotfile beside the source is a file that gets
 * committed, copied into a container, or pasted into a bug report; this one lives
 * where saves live, and `npx auto-adventure` has a home directory even when it has
 * no checkout at all.
 *
 * Nothing here may import `../utils/log.js`, directly or transitively. `config.ts`
 * reads this module at evaluation time and carries the same rule for the same
 * reason — the logger reads `LOG_LEVEL` when it is imported, and importing it too
 * early reads it before dotenv has defined it.
 */

/**
 * Where settings live, resolved on every call.
 *
 * Not cached, because `AUTO_ADVENTURE_HOME` is how the tests point this at a
 * temporary directory, and they set it after this module has been imported.
 * Deliberately the same root `save-repo.ts` uses; that file cannot be imported
 * here because it pulls in the logger.
 */
export function settingsRoot(): string {
	return process.env.AUTO_ADVENTURE_HOME ?? join(homedir(), ".auto-adventure");
}

export function settingsPath(): string {
	return join(settingsRoot(), "settings.json");
}

export interface Settings {
	/**
	 * The Vercel AI Gateway key, as typed into the options page.
	 *
	 * Plaintext, in a file only its owner can read. There is no OS keychain here —
	 * one that worked on all three platforms is a dependency and a permissions
	 * prompt, and this is a key for a hobby game's model budget, not a bank. The
	 * file mode is the whole of the protection, which is why it is set explicitly
	 * below rather than left to the process umask.
	 */
	readonly gatewayKey?: string;
	/** An id from `src/ai/catalogue.ts`. Absent means the built-in default. */
	readonly modelSet?: string;
}

/**
 * The settings on disk, or nothing.
 *
 * Never throws. A settings file that has been hand-edited into invalid JSON must
 * not stop the game starting — the worst it can honestly do is cost the player
 * their key, and that is a screen they can walk back into.
 */
export function readSettings(): Settings {
	const path = settingsPath();
	if (!existsSync(path)) return {};
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!raw || typeof raw !== "object") return {};
		const record = raw as Record<string, unknown>;
		return {
			...(typeof record.gatewayKey === "string" && record.gatewayKey.trim()
				? { gatewayKey: record.gatewayKey.trim() }
				: {}),
			...(typeof record.modelSet === "string" && record.modelSet
				? { modelSet: record.modelSet }
				: {}),
		};
	} catch {
		return {};
	}
}

/**
 * Merge a change in and write the whole file back.
 *
 * A patch rather than a replace, so the options page can set a key without
 * knowing that a model choice exists, and the config page can set a model
 * without being able to wipe the key.
 *
 * `undefined` in the patch leaves a field alone; an empty string clears it. That
 * distinction is the difference between "I did not touch the key" and "delete my
 * key", and both are things the options page needs to say.
 */
export function writeSettings(patch: Settings): Settings {
	const merged: Settings = {
		...readSettings(),
		...patch,
	};
	// An explicitly empty value means "forget this", which is not the same as
	// storing an empty string and later reading it back as a key.
	const next: Record<string, string> = {};
	if (merged.gatewayKey?.trim()) next.gatewayKey = merged.gatewayKey.trim();
	if (merged.modelSet) next.modelSet = merged.modelSet;

	const root = settingsRoot();
	// 0700 on the directory as well as 0600 on the file: a world-readable parent
	// makes the file's own mode the only thing standing between the key and every
	// other account on a shared machine, and directories are created here first.
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const path = settingsPath();
	const temp = `${path}.tmp`;
	// Written at 0600 rather than chmod-ed afterwards, so there is no window in
	// which the key exists on disk under the process umask.
	writeFileSync(temp, `${JSON.stringify(next, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		renameSync(temp, path);
	} catch (error) {
		if (existsSync(temp)) unlinkSync(temp);
		throw error;
	}
	// A file that already existed keeps its old mode through a rename, so an
	// upgrade from a version that wrote it more loosely is tightened here.
	try {
		chmodSync(path, 0o600);
	} catch {
		// Windows, or a filesystem with no modes. The rest of the write stands.
	}
	return next;
}

/**
 * The settings path as a person would write it, with `~` for the home directory.
 *
 * Cosmetic, and worth it: the untruncated path is the longest thing on the options
 * page and pushes the sentence explaining what the file is off the end of its own
 * paragraph. `~/.auto-adventure/settings.json` is also the form somebody would type
 * to go and look at it, which is the only reason it is on screen.
 */
export function displaySettingsPath(): string {
	const path = settingsPath();
	const home = homedir();
	return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Enough of a key to recognise it by, with the middle taken out. */
export function maskKey(key: string): string {
	if (key.length <= 8) return "•".repeat(key.length);
	return `${key.slice(0, 4)}${"•".repeat(6)}${key.slice(-4)}`;
}
