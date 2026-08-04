import { Box, useStdout } from "ink";
import { useEffect, useMemo, useState } from "react";
import { computeFov, lightAt } from "../core/geom/fov.js";
import { facingDelta } from "../core/rules/effects.js";
import { decorDef } from "../core/tiles/decor.js";
import { TFlag } from "../core/tiles/flags.js";
import { terrainDef } from "../core/tiles/terrain.js";
import { toChunk } from "../core/world/coords.js";
import { weatherAt } from "../core/world/weather.js";
import type { GameEngine } from "../engine/engine.js";
import type { WorldView } from "../engine/world-view.js";
import { useGameInput } from "./input/use-game-input.js";
import { DialoguePanel, panelHeightFor } from "./panels/dialogue-panel.js";
import { type PanelTab, SidePanel } from "./panels/side-panel.js";
import { FACING_MARKER, PLAYER_GLYPH } from "./render/glyphs.js";
import { lightFor } from "./render/lighting.js";
import { PAL } from "./render/palette.js";
import { tileSourceFrom } from "./render/world-source.js";
import { getEngine, useGameState } from "./store.js";
import { cameraCenteredOn, Viewport } from "./viewport.js";

const SIDE_PANEL_WIDTH = 32;
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

export default function App() {
	const engine = getEngine();
	const state = useGameState();
	const { width, height } = useTerminalSize();
	const [tab, setTab] = useState<PanelTab>("map");

	useGameInput({ dispatch: engine.dispatch, onToggleTab: setTab });

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
						return { ch: PLAYER_GLYPH, fg: PAL.player, bold: true };
					}
					const npc = npcs.at(x, y);
					// A letter per role is the classic roguelike answer and the only one
					// with no glyph-width risk at all.
					return npc ? { ch: npc.glyph, fg: dispositionColor(npc.spec.disposition) } : undefined;
				},
				// Marking the faced tile communicates direction better than a
				// directional player glyph: it shows what SPACE would act on.
				overlayAt: (x, y) =>
					x === facedX && y === facedY
						? { ch: FACING_MARKER, fg: PAL.player, bold: true }
						: undefined,
			}),
		[view, npcs, npcs.revision, player.x, player.y, facedX, facedY],
	);

	// Stay one row short of the window. Ink updates incrementally only while the
	// rendered output is *shorter* than the terminal; at exactly the terminal
	// height it clears the whole screen every frame, which reads as flicker.
	const frameHeight = Math.max(10, height - 1);
	const mapWidth = Math.max(20, width - SIDE_PANEL_WIDTH - 2);
	// The conversation panel has two fixed sizes; the map takes whatever is left,
	// so the total is constant either way.
	const panelHeight = panelHeightFor(state.dialogue !== undefined);
	const mapHeight = Math.max(6, frameHeight - panelHeight);
	const camera = useMemo(
		() => cameraCenteredOn([player.x, player.y], mapWidth, mapHeight),
		[player.x, player.y, mapWidth, mapHeight],
	);

	const cc = toChunk(player.x, player.y);
	const summary = engine.getChunks().summaryFor(cc.cx, cc.cy);
	const looking = describeFaced(engine, view, facedX, facedY, player.x, player.y);
	const placeName = player.inside?.name ?? engine.placeNameAt(player.x, player.y);
	const facedNpc = npcs.at(facedX, facedY);

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

	return (
		<Box flexDirection="row" width={width} height={frameHeight}>
			<Box flexDirection="column" flexGrow={1}>
				<Viewport source={source} camera={camera} options={composeOptions} />
				<DialoguePanel
					width={mapWidth}
					height={panelHeight}
					looking={looking}
					{...(facedNpc ? { nearbyName: facedNpc.name } : {})}
				/>
			</Box>
			<SidePanel
				tab={tab}
				width={SIDE_PANEL_WIDTH}
				height={frameHeight}
				summary={summary}
				{...(placeName ? { placeName } : {})}
			/>
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
	const npc = engine.getNpcs().at(x, y);
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
		return def.describe;
	}

	const facedTerrain = view.terrainAt(x, y);
	if (facedTerrain !== 0) {
		const def = terrainDef(facedTerrain);
		// A blank patch of the same ground you stand on is not worth narrating.
		if (facedTerrain !== view.terrainAt(standingX, standingY)) return def.describe;
	}

	return terrainDef(view.terrainAt(standingX, standingY)).describe;
}
