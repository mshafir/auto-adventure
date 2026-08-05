import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, it } from "vitest";
import { T } from "../core/tiles/terrain.js";
import type { TileSource } from "./render/compose.js";
import { PLACEHOLDER } from "./render/kitty.js";
import { setTileMode, Viewport } from "./viewport.js";

const source: TileSource = {
	terrainAt: () => T.grass,
	decorAt: () => 0,
	variantAt: () => 0,
	entityAt: () => undefined,
};

describe("what does KittyViewport actually emit", () => {
	it("dumps the frame", () => {
		setTileMode("kitty");
		const { lastFrame } = render(
			<Box width={88}>
				<Viewport source={source} camera={{ x: 0, y: 0, width: 44, height: 4 }} />
			</Box>,
		);
		const out = lastFrame() ?? "";
		console.log("LEN:", out.length);
		console.log("HAS APC:", out.includes("_G"));
		console.log("PLACEHOLDERS:", out.split(PLACEHOLDER).length - 1);
		console.log("LINES:", out.split("\n").length);
		console.log("HEAD:", JSON.stringify(out.slice(0, 120)));
		const lastLine = out.split("\n").at(-1) ?? "";
		console.log("LASTLINE:", JSON.stringify(lastLine.slice(0, 80)));
		setTileMode(undefined);
	});
});
