import { Box, useApp, useStdout } from "ink";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { CONFIG } from "../config.js";
import { resolveTileTheme } from "../content/tiles.js";
import { computeFov, lightAt } from "../core/geom/fov.js";
import { lightingRuns, weatherRuns } from "../core/rules/clock.js";
import { facingDelta } from "../core/rules/effects.js";
import { forageKey, isForageable } from "../core/rules/forage.js";
import { isContainer, lootKey } from "../core/rules/loot.js";
import { takenKey } from "../core/rules/placement.js";
import { questNeeding } from "../core/rules/quests.js";
import { activeQuests, worldAnchor } from "../core/rules/state.js";
import { D, type DecorId, decorDef } from "../core/tiles/decor.js";
import { TFlag } from "../core/tiles/flags.js";
import { terrainDef } from "../core/tiles/terrain.js";
import { toChunk } from "../core/world/coords.js";
import { worldSeed } from "../core/world/recipe.js";
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
import type { Camera } from "./render/compose.js";
import { mapFit } from "./render/fit.js";
import { PLAYER_GLYPH } from "./render/glyphs.js";
import { lightFor, NEUTRAL_LIGHT } from "./render/lighting.js";
import { minimapCells } from "./render/minimap-data.js";
import { cellPixels, envZoom, renderTilePixels } from "./render/mode.js";
import { minimapExtent } from "./render/overlay.js";
import { PAL } from "./render/palette.js";
import { tileSourceFrom } from "./render/world-source.js";
import { getEngine, useGameState } from "./store.js";
import { cameraFollowing, tileMode, Viewport } from "./viewport.js";

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
		// `ZOOM` is where zoom starts; the keys take it from there.
		...initialHud(tab, envZoom()),
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
	const source = useMemo(() => {
		// Authored items lying in the open, drawn as `something lies here`. Built into
		// a position lookup rather than asked per tile, because `markedPlacements`
		// filters by condition and by whether the thing has been taken, and doing that
		// once per visible tile would be thousands of evaluations a frame.
		const marks = new Map<string, DecorId>();
		for (const entry of engine.markedPlacements()) marks.set(`${entry.x},${entry.y}`, D.item);

		return tileSourceFrom(view, {
			decorAt: (x, y) => marks.get(`${x},${y}`),
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
		});
	}, [
		view,
		engine,
		npcs,
		npcs.revision,
		player.x,
		player.y,
		player.facing,
		player.inside,
		// Which authored items are on show depends on both: a placement can be gated
		// on the story, and one that has been taken stops being drawn.
		state.flags,
		state.inventory,
	]);

	// Stay one row short of the window. Ink updates incrementally only while the
	// rendered output is *shorter* than the terminal; at exactly the terminal
	// height it clears the whole screen every frame, which reads as flicker.
	const frameHeight = Math.max(10, height - 1);
	// The key bar is one unbordered row along the bottom of the whole frame, so
	// everything above it gets one row less.
	const bodyHeight = Math.max(8, frameHeight - 1);
	// The conversation panel has two fixed sizes; the map takes whatever is left,
	// so the total is constant either way.
	const panelHeight = panelHeightFor(state.dialogue !== undefined);
	// What the map *may* have. What it takes is `fit`, which stops well short of
	// this on a large window — see `fit.ts` for why filling the screen made the
	// game worse the bigger the screen got.
	const roomForMap = {
		columns: Math.max(20, width),
		rows: Math.max(6, bodyHeight - panelHeight - TOP_BAR_ROWS),
	};
	const fit = mapFit({
		mode: tileMode(),
		columns: roomForMap.columns,
		rows: roomForMap.rows,
		cell: cellPixels(),
		zoom: hud.zoom,
	});
	// The map still owns every column of the rows it draws on, and it has to: Ink
	// cuts a row of kitty placeholders in half the moment anything shares the screen
	// line with it. The blank cells beside it are part of its own rows, not a
	// sibling — which is what `indent` is.
	const mapWidth = fit.columns;
	const mapHeight = fit.rows;

	// Logged because a screenshot cannot tell you what the game *thought* the
	// terminal was, and a disagreement between the two is exactly the kind of
	// bug that looks like a rendering fault.
	useEffect(() => {
		const cell = cellPixels();
		const drawn = renderTilePixels(fit.width, fit.height, process.env, cell, fit.tilePx);
		const megapixels = ((fit.width * drawn * (fit.height * drawn)) / 1_000_000).toFixed(1);
		logger.info(
			`layout: terminal ${width}x${height} cells, map ${mapWidth}x${mapHeight} ` +
				`at +${fit.indent}, cell ${cell.width}x${cell.height}px, tile ${fit.tilePx}px` +
				`${drawn === fit.tilePx ? "" : ` (drawn at ${drawn}px)`}, zoom ${hud.zoom}, ` +
				`camera ${fit.width}x${fit.height} tiles, frame ${megapixels}MP`,
		);
	}, [width, height, mapWidth, mapHeight, fit.width, fit.height, fit.indent, fit.tilePx, hud.zoom]);
	/*
	 * The camera follows rather than being recomputed from scratch, so it needs the
	 * frame before it — which is what the ref holds.
	 *
	 * Only a camera describing *the same coordinate space* may be followed. Indoors
	 * the player's coordinates are local to the interior grid, so a camera from the
	 * street outside names entirely different ground; carrying it across the doorway
	 * would put the player wherever the arithmetic happened to land. `space` keys
	 * that, and a change to it is a fresh centred camera.
	 *
	 * Written during render, which is safe here only because `cameraFollowing` is
	 * idempotent: running it again on its own answer returns that answer. A rule that
	 * crept a tile per call would drift sideways under React's double render.
	 */
	const cameraRef = useRef<Camera | undefined>(undefined);
	const spaceRef = useRef<string | undefined>(undefined);
	const space = player.inside
		? `in:${player.inside.interiorId}:${player.inside.level ?? 0}`
		: "world";
	const camera = useMemo(() => {
		const held = spaceRef.current === space ? cameraRef.current : undefined;
		const next = cameraFollowing(held, [player.x, player.y], fit.width, fit.height);
		spaceRef.current = space;
		// The previous object when nothing moved, not an equal new one: the viewport
		// memoises its whole frame on the camera's identity, so a fresh object for a
		// camera that stayed put would re-rasterise and re-upload the same image.
		const settled = held && next.x === held.x && next.y === held.y ? held : next;
		cameraRef.current = settled;
		return settled;
	}, [player.x, player.y, fit.width, fit.height, space]);

	// Where the player is *in the world*. Indoors their coordinates are local to the
	// interior grid, so anything asked in chunk space — which region is this, what is
	// on the minimap, which way is the errand — has to be asked from the doorway.
	const outside = worldAnchor(player);
	const cc = toChunk(outside.x, outside.y);
	const summary = engine.getChunks().summaryFor(cc.cx, cc.cy);
	const looking = state.notice ?? describeFaced(engine, view, facedX, facedY, player.x, player.y);
	const placeName = player.inside
		? (player.inside.name ?? engine.placeNameAt(outside.x, outside.y) ?? player.inside.structure)
		: engine.placeNameAt(player.x, player.y);
	const facedNpc = engine.personAt(facedX, facedY);

	const inside = player.inside !== undefined;
	// Both switches are the world's, and both are off for a game that wants no clock and
	// no sky. Weather is asked separately from lighting because they come apart: a world
	// with the hour frozen can still have rain, since weather is sampled along the tick
	// and the tick keeps counting.
	const hasWeather = weatherRuns(state.world.time);
	const hasLighting = lightingRuns(state.world.time);
	const weather = useMemo(
		() =>
			inside || !hasWeather
				? undefined
				: weatherAt(
						worldSeed(state.world.seed, state.world.recipe),
						state.time.tick,
						player.x,
						player.y,
					),
		[inside, hasWeather, state.world.seed, state.world.recipe, state.time.tick, player.x, player.y],
	);
	// `lightFor` builds a fresh tint array, so memoising on its scalar inputs is
	// what stops the compositor rerunning on every render that changes nothing
	// about the lighting — including every turn on the spot.
	const light = useMemo(
		() =>
			// Interiors keep their lamplight even with the day/night cycle off: that is
			// ambience for a room with no windows, not a time of day.
			hasLighting || inside ? lightFor(state.time.hour, weather, inside) : NEUTRAL_LIGHT,
		[hasLighting, state.time.hour, weather, inside],
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

	// Resolved once per world rather than per frame: reading a pack means a file read
	// and a PNG decode, and the name cannot change while a world is open.
	const theme = useMemo(
		() => resolveTileTheme(state.world.tiles ?? CONFIG.tilePack),
		[state.world.tiles],
	);

	const composeOptions = useMemo(
		() => ({
			theme,
			tint: light.tint,
			tintStrength: light.strength,
			shadows: true,
			relief: RELIEF_ENABLED,
			...(fov ? { lightAt: (x: number, y: number) => lightAt(fov, x, y) } : {}),
		}),
		[theme, light.tint, light.strength, fov],
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
			{/*
			 * Half the slack above the map and half below, so a window taller than the
			 * map wants letterboxes it rather than pinning it to the top with a band of
			 * empty terminal underneath.
			 */}
			<Box flexGrow={1} />
			<Viewport
				source={source}
				camera={camera}
				options={composeOptions}
				columns={mapWidth}
				rows={mapHeight}
				indent={fit.indent}
				tilePx={fit.tilePx}
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

	// The authored item first, and before the decor it is sitting in or on.
	//
	// Its own line rather than the container's, because the two disagree about the only
	// thing the player needs: a shelf already searched says "you have been through it"
	// while the thing the story just put in it is still there waiting. And a placement
	// lying on open ground has no decor at all to describe, so without this the game
	// drew a mark on the tile and then said nothing whatsoever about it.
	const placed = engine.placedAt(x, y);
	if (placed) {
		const taken = engine.getState().flags[takenKey(placed.id)];
		if (!taken) {
			const decorHere = view.decorAt(x, y);
			const where = decorHere !== 0 ? `${decorDef(decorHere).describe} ` : "";
			return `${where}Something is here. SPACE to take it.`;
		}
		return placed.placement.emptyText ?? "There is nothing more here.";
	}

	const decor = view.decorAt(x, y);
	if (decor !== 0) {
		const def = decorDef(decor);
		const sign = engine.getChunks().signNear(x, y);
		if (sign) return `${def.describe} It reads "${sign}".`;
		if (isContainer(decor)) {
			const inside = engine.getState().player.inside;
			// The storey too: a chest emptied on the ground floor is not the chest
			// directly above it, and `lootKey` has always distinguished them.
			const emptied =
				inside !== undefined &&
				engine.getState().flags[lootKey(inside.interiorId, x, y, inside.level ?? 0)];
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
