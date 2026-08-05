import { isOverrideEmpty, type PackOverride } from "../core/content/pack.js";
import { PackOverrideSchema } from "../core/content/schema.js";
import { type GameState, SAVE_VERSION, startTick, timeFromTick } from "../core/rules/state.js";
import { normalizeBrief, type ScenarioBrief } from "../core/world/brief.js";
import { logger } from "../utils/log.js";

/**
 * Bring a save on disk up to the current schema.
 *
 * Each migration takes the previous shape and returns the next; they are
 * applied in sequence. Returning `undefined` means "this save cannot be
 * carried forward" and the caller starts a new world.
 */
type Migration = (previous: Record<string, unknown>) => Record<string, unknown> | undefined;

const MIGRATIONS: Readonly<Record<number, Migration>> = {
	// v1 and v2 were the pre-rewrite `state.json`: a single LLM-drawn string map
	// per world coordinate, with no seed and no chunk grid. There is no way to
	// reconstruct an equivalent procedural world from one, so those saves are
	// retired rather than mangled into something that would load but be wrong.
	1: () => undefined,
	2: () => undefined,
};

export function migrateSave(raw: unknown): GameState | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	let current = raw as Record<string, unknown>;

	// A save with no version is the original format, which had none.
	let version = typeof current.version === "number" ? current.version : 1;

	while (version < SAVE_VERSION) {
		const migrate = MIGRATIONS[version];
		if (!migrate) {
			logger.warn(`no migration from save version ${version}; starting a new world`);
			return undefined;
		}
		const next = migrate(current);
		if (!next) {
			logger.info(`save version ${version} cannot be carried forward; starting a new world`);
			return undefined;
		}
		current = next;
		version = typeof current.version === "number" ? current.version : version + 1;
	}

	if (version > SAVE_VERSION) {
		logger.warn(`save version ${version} is newer than this build (${SAVE_VERSION}); refusing it`);
		return undefined;
	}

	return validate(current);
}

function readContent(raw: unknown): PackOverride | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const parsed = PackOverrideSchema.safeParse(raw);
	if (!parsed.success) {
		logger.warn("save carries a content pack that no longer validates; using the default");
		return undefined;
	}
	return isOverrideEmpty(parsed.data as PackOverride) ? undefined : (parsed.data as PackOverride);
}

/**
 * Reject a save whose shape does not match, rather than letting an undefined
 * field surface as a crash three screens later. The old loader handed the
 * result of `JSON.parse` straight back as `GameState` with no checking at all —
 * which is how a save taken mid-action could restore a permanently locked game.
 */
function validate(value: Record<string, unknown>): GameState | undefined {
	const player = value.player as Record<string, unknown> | undefined;
	const world = value.world as Record<string, unknown> | undefined;

	const ok =
		typeof world?.seed === "number" &&
		typeof world.id === "string" &&
		typeof player?.x === "number" &&
		typeof player.y === "number" &&
		Array.isArray(value.inventory) &&
		Array.isArray(value.quests);

	if (!ok) {
		logger.warn("save failed validation; starting a new world");
		return undefined;
	}

	const state = value as unknown as GameState;
	// `dialogue`, `notice` and `card` are UI-transient and must never come back from
	// disk mid-turn: a restored notice would announce a discovery the player made in
	// a previous session, and a restored card would block the first keypress of one.
	// A card that has been read is recorded in the flags, which do persist, so
	// dropping it here cannot bring it back.
	//
	// `brief` is dropped for a different reason and re-derived below: it is the one
	// field a player is likely to hand-edit, and a blank string in it would read as
	// an instruction rather than as silence.
	const { dialogue: _dialogue, notice: _notice, card: _card, brief: _brief, ...rest } = state;
	const brief = normalizeBrief(value.brief as ScenarioBrief | undefined);
	// A pack that no longer validates is dropped rather than refused: the world still
	// plays, with default names for anyone not yet met. Keeping a malformed one would
	// hand `undefined` to a generator on the next chunk.
	const content = readContent(value.content);
	return {
		...(rest as GameState),
		...(brief ? { brief } : {}),
		...(content ? { content } : {}),
		// Day, hour and minute are all derived from the tick, so recomputing them is
		// both a backfill for saves written before a field existed and a repair for
		// any that disagree with their own tick. Derived against the world's own clock
		// settings, so a save from a world with no time of day does not come back with
		// one — which is exactly what happened when the tick alone decided.
		time: timeFromTick(state.time?.tick ?? startTick(world?.time as never), world?.time as never),
		discovered: Array.isArray(value.discovered) ? (value.discovered as string[]) : [],
		journal: Array.isArray(value.journal) ? state.journal : [],
		flags: (value.flags as GameState["flags"]) ?? {},
		deltas: (value.deltas as GameState["deltas"]) ?? {},
		// Authored content was added after v3 shipped; a save without it is not
		// broken, it is simply a world nobody has named yet.
		regions: (value.regions as GameState["regions"]) ?? {},
		sites: (value.sites as GameState["sites"]) ?? {},
		specSources: (value.specSources as GameState["specSources"]) ?? {},
		npcs: (value.npcs as GameState["npcs"]) ?? {},
		reputation: (value.reputation as GameState["reputation"]) ?? {},
	};
}
