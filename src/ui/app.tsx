import { Box, useApp, useStdout } from "ink";
import { useEffect, useMemo, useReducer, useState } from "react";
import { computeFov, lightAt } from "../core/geom/fov.js";
import { facingDelta } from "../core/rules/effects.js";
import { forageKey, isForageable } from "../core/rules/forage.js";
import { isContainer, lootKey } from "../core/rules/loot.js";
import { questNeeding } from "../core/rules/quests.js";
import { activeQuests } from "../core/rules/state.js";
import { decorDef } from "../core/tiles/decor.js";
import { TFlag } from "../core/tiles/flags.js";
import { terrainDef } from "../core/tiles/terrain.js";
import { toChunk } from "../core/world/coords.js";
import { weatherAt } from "../core/world/weather.js";
import type { GameEngine } from "../engine/engine.js";
import type { WorldView } from "../engine/world-view.js";
import { logger } from "../utils/log.js";
import { hudReducer, initialHud, LIST_TABS, type PanelTab } from "./hud-state.js";
import { useGameInput } from "./input/use-game-input.js";
import { CardScreen } from "./panels/card-screen.js";
import { DialoguePanel, panelHeightFor } from "./panels/dialogue-panel.js";
import { KeyBar, type KeyBarMode } from "./panels/key-bar.js";
import { Reader } from "./panels/reader.js";
import { TOP_BAR_ROWS, TopBar } from "./panels/top-bar.js";
import { PLAYER_GLYPH } from "./render/glyphs.js";
import { MAX_PLACEHOLDER_INDEX } from "./render/kitty.js";
import { lightFor } from "./render/lighting.js";
import { minimapCells } from "./render/minimap-data.js";
import { cellPixels, renderTilePixels, tilePixels } from "./render/mode.js";
import { minimapExtent } from "./render/overlay.js";
import { PAL } from "./render/palette.js";
import { tileFit } from "./render/raster.js";
import { tileSourceFrom } from "./render/world-source.js";
import { getEngine, useGameState } from "./store.js";
import { cameraCenteredOn, tileMode, tilesAcross, Viewport } from "./viewport.js";

/** How far a lamp carries indoors. */
const INTERIOR_SIGHT = 9;

/**
 * Slope shading costs bandwidth: it bands terrain into more distinct styles, so
 * the row encoder collapses less and a frame grows from about 22KB to 36KB. That
 * is still smaller than the 45KB this used to send, but frame size is the one
 * thing still driving flicker on a slow link, so it stays switchable.
 */
const RELIEF_ENABLED = process.env.NO_RELIEF !== "1" && process.env.NO_RELIEF !== "true";

function useTerminalSize() {
	const { stdout } = useStdout();
	const [size, setSize] = useState({
		width: stdout.columns ?? 80,
		height: stdout.rows ?? 24,
	});

	useEffect(() => {
		const onResize = () => setSize({ width: stdout.columns ?? 80, height: stdout.rows ?? 24 });
		stdout.on("resize", onResize);
		return () => {
			stdout.off("resize", onResize);
		};
	}, [stdout]);

	return size;
}

export interface AppProps {
	/** Which page starts open. Only the screenshot tool and tests pass this. */
	readonly initialTab?: PanelTab;
	/** Which row of it is selected. Same callers, same reason. */
	readonly initialCursor?: number;
}

export default function App({ initialTab, initialCursor = 0 }: AppProps = {}) {
	const engine = getEngine();
	const state = useGameState();
	const { width, height } = useTerminalSize();
	const { exit } = useApp();
	const [hud, hudDispatch] = useReducer(hudReducer, initialTab, (tab) => ({
		...initialHud(tab),
		cursor: initialCursor,
	}));

	// How long the open page's list is, so a cursor cannot survive the list
	// shrinking under it — an item spent, a quest closed, a save reloaded.
	const listCount =
		hud.tab === "inventory"
			? state.inventory.length
			: hud.tab === "quests"
				? activeQuests(state).length
				: hud.tab === "journal"
					? state.journal.length
					: 0;

	// Only once the arrow keys are actually in the list. On the tab strip the
	// cursor is not yet the player's — offering to destroy what it happens to be
	// resting on would be a `D` press away from losing an errand item.
	const held =
		hud.tab === "inventory" && hud.inList && state.inventory.length > 0
			? state.inventory[Math.min(hud.cursor, state.inventory.length - 1)]
			: undefined;

	useGameInput({
		dispatch: engine.dispatch,
		hud,
		hudDispatch,
		listCount,
		// Dropping destroys the item — the world has no ground layer to pick it
		// back up from — so this only ever raises the question.
		...(held
			? {
					onDrop: () => {
						const wanted = questNeeding(state, held.name);
						hudDispatch({
							t: "Ask",
							confirm: {
								action: { t: "drop", name: held.name, quantity: held.quantity },
								prompt: `Drop ${held.quantity > 1 ? `${held.quantity} ` : ""}${held.name}? It is gone for good.`,
								...(wanted ? { warning: `Wanted for "${wanted.name}".` } : {}),
							},
						});
					},
				}
			: {}),
		onQuit: () => {
			// Flushed here rather than relying on the debounce timer, which is
			// unref'd and would be abandoned by the exiting process.
			engine.dispatch({ t: "RequestSave" });
			exit();
		},
	});

	const view = engine.getView();
	const player = state.player;

	// The camera and the tile source both depend on the player's position, so
	// they are rebuilt only when it actually changes rather than every render.
	const [fx, fy] = facingDelta(player.facing);
	const facedX = player.x + fx;
	const facedY = player.y + fy;

	const npcs = engine.getNpcs();

	// The directory is mutated in place as site specs arrive, so its identity
	// never changes and its revision counter is the only signal that its answers
	// did.
	// biome-ignore lint/correctness/useExhaustiveDependencies: npcs.revision is a mutable-source key
	const source = useMemo(
		() =>
			tileSourceFrom(view, {
				entityAt: (x, y) => {
					if (x === player.x && y === player.y) {
						// The facing rides on the player rather than being painted on the
						// tile in front. Only the pixel renderer can use it — a sprite has
						// room for a wedge, a character does not — and it is what stops the
						// marker punching a hole through the signpost about to be read.
						return { ch: PLAYER_GLYPH, fg: PAL.player, bold: true, facing: player.facing };
					}
					// `personAt` rather than the outdoor directory: indoors the coordinates
					// are interior-local and the people are the building's own residents.
					const npc = engine.personAt(x, y);
					// A letter per role is the classic roguelike answer and the only one
					// with no glyph-width risk at all.
					return npc ? { ch: npc.glyph, fg: dispositionColor(npc.spec.disposition) } : undefined;
				},
			}),
		[view, engine, npcs, npcs.revision, player.x, player.y, player.facing, player.inside],
	);

	// Stay one row short of the window. Ink updates incrementally only while the
	// rendered output is *shorter* than the terminal; at exactly the terminal
	// height it clears the whole screen every frame, which reads as flicker.
	const frameHeight = Math.max(10, height - 1);
	// The key bar is one unbordered row along the bottom of the whole frame, so
	// everything above it gets one row less.
	const bodyHeight = Math.max(8, frameHeight - 1);
	// The map owns every column of its rows, and it has to: Ink cuts a row of
	// kitty placeholders in half the moment anything shares the screen line with
	// it, then composites the neighbour into the gap.
	const mapWidth = Math.max(20, width);
	// The conversation panel has two fixed sizes; the map takes whatever is left,
	// so the total is constant either way.
	const panelHeight = panelHeightFor(state.dialogue !== undefined);
	/*
	 * How many rows the map may have, and in pixel mode there is a ceiling on it.
	 *
	 * Every placeholder row is anchored by a combining mark from a fixed table, and
	 * the table here holds 64 of the protocol's 297 — a deliberate limit, because the
	 * entries cannot be computed and a wrong one silently draws the wrong slice of
	 * the image. Past the end `diacritic` throws, which on a window taller than about
	 * seventy-five rows took the whole game down rather than drawing a shorter map.
	 *
	 * So the map stops at the table and the leftover rows go under it. A band of
	 * empty terminal is a poor look; a crash on a big monitor is worse.
	 */
	const wanted = Math.max(6, bodyHeight - panelHeight - TOP_BAR_ROWS);
	const mapHeight = tileMode() === "kitty" ? Math.min(wanted, MAX_PLACEHOLDER_INDEX) : wanted;
	// The camera is measured in tiles and the layout in terminal cells, and how
	// many cells a tile takes depends on the renderer: TILE_WIDTH columns and one
	// row for glyphs, and whatever its pixel size works out to for the image
	// renderer, which is not bound to the character grid. Centring on the player
	// in tile space is what keeps them in the middle either way.
	const fit =
		tileMode() === "kitty"
			? tileFit(mapWidth, mapHeight, cellPixels(), tilePixels())
			: { width: tilesAcross(mapWidth), height: mapHeight };

	// Logged because a screenshot cannot tell you what the game *thought* the
	// terminal was, and a disagreement between the two is exactly the kind of
	// bug that looks like a rendering fault.
	useEffect(() => {
		const cell = cellPixels();
		const tilePx = renderTilePixels(fit.width, fit.height);
		const megapixels = ((fit.width * tilePx * (fit.height * tilePx)) / 1_000_000).toFixed(1);
		logger.info(
			`layout: terminal ${width}x${height} cells, map ${mapWidth}x${mapHeight}, ` +
				`cell ${cell.width}x${cell.height}px, tile ${tilePixels()}px` +
				`${tilePx === tilePixels() ? "" : ` (drawn at ${tilePx}px)`}, ` +
				`camera ${fit.width}x${fit.height} tiles, frame ${megapixels}MP`,
		);
	}, [width, height, mapWidth, mapHeight, fit.width, fit.height]);
	const camera = useMemo(
		() => cameraCenteredOn([player.x, player.y], fit.width, fit.height),
		[player.x, player.y, fit.width, fit.height],
	);

	const cc = toChunk(player.x, player.y);
	const summary = engine.getChunks().summaryFor(cc.cx, cc.cy);
	const looking = state.notice ?? describeFaced(engine, view, facedX, facedY, player.x, player.y);
	// Indoors, the position is interior-local, so the settlement has to be resolved
	// from the doorway rather than from where the player is standing.
	const placeName = player.inside
		? (player.inside.name ??
			engine.placeNameAt(player.inside.returnX, player.inside.returnY) ??
			player.inside.structure)
		: engine.placeNameAt(player.x, player.y);
	const facedNpc = engine.personAt(facedX, facedY);

	const inside = player.inside !== undefined;
	const weather = useMemo(
		() => (inside ? undefined : weatherAt(state.world.seed, state.time.tick, player.x, player.y)),
		[inside, state.world.seed, state.time.tick, player.x, player.y],
	);
	// `lightFor` builds a fresh tint array, so memoising on its scalar inputs is
	// what stops the compositor rerunning on every render that changes nothing
	// about the lighting — including every turn on the spot.
	const light = useMemo(
		() => lightFor(state.time.hour, weather, inside),
		[state.time.hour, weather, inside],
	);

	// Field of view only indoors. Hiding the landscape behind a torch radius
	// would make an infinite world feel like a corridor; hiding the next room of
	// a shop is exactly what makes walking into one worth doing.
	const fov = useMemo(
		() =>
			inside
				? computeFov(player.x, player.y, INTERIOR_SIGHT, (x, y) =>
						Boolean(view.flagsAt(x, y) & TFlag.BlocksSight),
					)
				: undefined,
		[inside, view, player.x, player.y],
	);

	// Composited into the corner of the map rather than laid out beside it, so the
	// same overlay works in both renderers — and so it survives the side panel
	// going away. Sized in terminal cells for both, which keeps it the same
	// fraction of the screen whichever one is drawing.
	// Destructured to scalars: `minimapExtent` builds a fresh object every render,
	// so depending on it would rebuild the map every frame and memoising it would
	// be a lie.
	const extent = minimapExtent(mapWidth, mapHeight);
	const miniW = extent?.width ?? 0;
	const miniH = extent?.height ?? 0;
	const minimap = useMemo(
		() => (miniW > 0 ? minimapCells(state, miniW, miniH) : undefined),
		[state, miniW, miniH],
	);

	const composeOptions = useMemo(
		() => ({
			tint: light.tint,
			tintStrength: light.strength,
			shadows: true,
			relief: RELIEF_ENABLED,
			...(fov ? { lightAt: (x: number, y: number) => lightAt(fov, x, y) } : {}),
		}),
		[light.tint, light.strength, fov],
	);

	const keyMode: KeyBarMode = state.card
		? { t: "card" }
		: hud.tab !== undefined
			? {
					t: "menu",
					canDrop: held !== undefined,
					hasList: LIST_TABS.has(hud.tab),
					inList: hud.inList,
				}
			: state.dialogue
				? { t: "dialogue" }
				: { t: "world" };

	// A card takes the whole frame rather than overlaying the map. Everything above
	// is still computed, which costs a frame's worth of work nobody sees — but the
	// alternative is hooks that run conditionally, and the map has to be ready the
	// instant the card comes down anyway.
	if (state.card) {
		return (
			<Box flexDirection="column" width={width} height={frameHeight}>
				<CardScreen card={state.card} width={width} height={bodyHeight} />
				<KeyBar width={width} mode={keyMode} />
			</Box>
		);
	}

	// A page takes the frame the same way a card does. The map is still computed
	// above, which costs a frame nobody sees but keeps the hooks unconditional — and
	// it has to be ready the instant the page closes anyway.
	if (hud.tab !== undefined) {
		return (
			<Box flexDirection="column" width={width} height={frameHeight}>
				<Reader state={state} hud={hud} tab={hud.tab} width={width} height={bodyHeight} />
				<KeyBar width={width} mode={keyMode} {...(hud.confirm ? { confirm: hud.confirm } : {})} />
			</Box>
		);
	}

	// One column per child, no siblings on any row. That is what the pixel renderer
	// needs, and the reason the side panel is gone.
	return (
		<Box flexDirection="column" width={width} height={frameHeight}>
			<TopBar
				state={state}
				width={width}
				summary={summary}
				{...(placeName ? { placeName } : {})}
				{...(inside ? {} : { weather })}
				light={light.label}
			/>
			<Viewport
				source={source}
				camera={camera}
				options={composeOptions}
				columns={mapWidth}
				rows={mapHeight}
				{...(minimap ? { minimap } : {})}
			/>
			{/*
			 * Takes up whatever the map could not, so the conversation and the key bar
			 * stay against the bottom of the window rather than floating under a map
			 * that stopped short of the diacritic table.
			 */}
			<Box flexGrow={1} />
			<DialoguePanel
				width={mapWidth}
				height={panelHeight}
				looking={looking}
				facing={player.facing}
				{...(facedNpc ? { nearbyName: facedNpc.name } : {})}
			/>
			<KeyBar width={width} mode={keyMode} {...(hud.confirm ? { confirm: hud.confirm } : {})} />
		</Box>
	);
}

/** Warm for the well-disposed, cool for the wary. */
function dispositionColor(disposition: number) {
	if (disposition >= 25) return PAL.friendly;
	if (disposition <= -20) return PAL.hostile;
	if (disposition < 0) return PAL.wary;
	return PAL.neutral;
}

/**
 * Describe whatever the player is facing.
 *
 * Looking at a thing costs nothing and takes no turn — the first press of a new
 * direction only turns — so this is the game's examine verb, and it is how
 * shop signs and doors are read.
 */
function describeFaced(
	engine: GameEngine,
	view: WorldView,
	x: number,
	y: number,
	standingX: number,
	standingY: number,
): string {
	const npc = engine.personAt(x, y);
	if (npc) return `${npc.name}, ${npc.role}. ${npc.spec.appearance}`;

	const door = engine.getChunks().doorAt(x, y);
	if (door) {
		const label = door.name ?? `a ${door.kind}`;
		return door.signText
			? `A painted board reads "${door.signText}". The door of ${label} stands closed. Walk into it to enter.`
			: `The door of ${label}. Walk into it to enter.`;
	}

	const decor = view.decorAt(x, y);
	if (decor !== 0) {
		const def = decorDef(decor);
		const sign = engine.getChunks().signNear(x, y);
		if (sign) return `${def.describe} It reads "${sign}".`;
		if (isContainer(decor)) {
			const inside = engine.getState().player.inside;
			const emptied =
				inside !== undefined && engine.getState().flags[lootKey(inside.interiorId, x, y)];
			return emptied
				? `${def.describe} You have already been through it.`
				: `${def.describe} SPACE to search it.`;
		}
		return def.describe;
	}

	const facedTerrain = view.terrainAt(x, y);
	if (facedTerrain !== 0) {
		const def = terrainDef(facedTerrain);
		// Ground worth gathering from says so, and says so only while it still is.
		if (!engine.getState().player.inside && isForageable(facedTerrain)) {
			return engine.getState().flags[forageKey(x, y)]
				? `${def.describe} You have been through this patch.`
				: `${def.describe} SPACE to gather.`;
		}
		// A blank patch of the same ground you stand on is not worth narrating.
		if (facedTerrain !== view.terrainAt(standingX, standingY)) return def.describe;
	}

	return terrainDef(view.terrainAt(standingX, standingY)).describe;
}
