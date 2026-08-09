import { describe, expect, it } from "vitest";
import { STRUCTURE_KINDS } from "../../../ai/director/schemas.js";
import { minimumPlot } from "./building.js";
import { getInterior } from "./interior.js";
import type { StructureKind } from "./patch.js";
import { authorableStructureKinds, registeredStructures, structureDef } from "./structures.js";

/**
 * The list of building kinds used to exist three times over — `StructureKind`, the
 * director's `STRUCTURE_KINDS`, and the fallback roster's keys — with nothing tying any
 * two together. These are the assertions that were missing.
 */

/** Every kind the type allows. Written out so the test fails if the union grows. */
const EVERY_KIND: readonly StructureKind[] = [
	"house",
	"shop",
	"inn",
	"smithy",
	"temple",
	"barracks",
	"tower",
	"farmhouse",
	"barn",
	"warehouse",
	"mill",
	"stable",
	"apothecary",
	"ruin",
	"shrine",
	"cave",
];

describe("the structure registry", () => {
	it("has a definition for every kind the type allows", () => {
		const registered = new Set(registeredStructures().map((def) => def.id));
		for (const kind of EVERY_KIND) {
			expect(registered, `no definition registered for "${kind}"`).toContain(kind);
		}
	});

	it("registers nothing the type does not allow", () => {
		for (const def of registeredStructures()) {
			expect(EVERY_KIND).toContain(def.id);
		}
	});

	it("is what the model is allowed to ask for, so the two cannot drift", () => {
		expect([...STRUCTURE_KINDS]).toEqual([...authorableStructureKinds()]);
	});

	it("offers an author everything except the cave, which the cave feature builds", () => {
		const authorable = new Set(authorableStructureKinds());
		expect(authorable.has("cave")).toBe(false);
		for (const kind of EVERY_KIND) {
			if (kind !== "cave") expect(authorable, `"${kind}" should be authorable`).toContain(kind);
		}
	});

	it("falls back to a house rather than throwing, for a kind read off an old artifact", () => {
		expect(structureDef("longhouse").id).toBe("house");
	});

	it("gives every kind a room big enough to stand in", () => {
		for (const def of registeredStructures()) {
			const [width, height] = def.plan.size;
			// Two walls and something between them, on both axes.
			expect(width, `${def.id} is too narrow`).toBeGreaterThan(4);
			expect(height, `${def.id} is too shallow`).toBeGreaterThan(4);
		}
	});

	it("gives every kind a plot its room can be entered from", () => {
		for (const def of registeredStructures()) {
			const plot = minimumPlot(def.id, def.size);
			expect(plot.x, `${def.id} asks for no width`).toBeGreaterThan(4);
			expect(plot.y, `${def.id} asks for no depth`).toBeGreaterThan(4);
		}
	});

	it("builds an interior for every kind, which is the drift the missing test allowed", () => {
		for (const def of registeredStructures()) {
			const interior = getInterior(1234, 99, def.id);
			expect(interior.width, `${def.id} built no room`).toBeGreaterThan(0);
			expect(interior.height, `${def.id} built no room`).toBeGreaterThan(0);
		}
	});
});
