import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T, terrainDef } from "./src/core/tiles/terrain.js";
import { resolvePlacements } from "./src/engine/placements.js";
import { artifactWorld } from "./src/scenario/artifact.js";
import { readScenarioDir, writeScenarioDir } from "./src/scenario/dir.js";
import { buildSession } from "./src/session.js";
import { twoPhaseArtifact } from "./test/fixtures/two-phase.js";

const artifact = readScenarioDir(
	writeScenarioDir(twoPhaseArtifact(), mkdtempSync(join(tmpdir(), "p-"))),
)!;
const s = buildSession(
	{ worldId: "probe", seed: artifact.seed, flavour: "prebuilt", scenario: artifact },
	{ persist: false },
);
console.log("T.path", T.path, "T.dirtRoad", T.dirtRoad);
const v = s.engine.getView();
const before: string[] = [];
for (let x = 45; x <= 80; x += 5)
	for (let y = -33; y <= -28; y++) {
		if (v.terrainAt(x, y) === T.path) before.push(`${x},${y}`);
	}
console.log("base path tiles sampled:", before.slice(0, 12));
s.engine.dispatch({ t: "ApplyEffects", effects: [{ t: "SetFlag", key: "flood", value: true }] });
const v2 = s.engine.getView();
console.log(
	"after flood, same tiles:",
	before.slice(0, 6).map((k) => {
		const [x, y] = k.split(",").map(Number);
		return `${k}=${terrainDef(v2.terrainAt(x!, y!)).key}`;
	}),
);
const st = s.engine.getState();
const r = resolvePlacements(st.placements, {
	world: artifactWorld(artifact),
	siteSpec: (id: number) => st.sites[String(id)],
	bounds: artifact.bounds,
});
console.log(
	"resolved:",
	r.resolved.map((x) => x.id),
	"unresolved:",
	r.unresolved,
);
s.dispose();
