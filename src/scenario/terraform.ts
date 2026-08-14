import type { Vec2 } from "../core/geom/vec.js";

/**
 * An authored change to the ground the generator produced.
 *
 * The escape hatch of last resort, and the skill tells the agent so. The generator decides
 * where settlements can exist and what the country between them looks like; a scenario that
 * needs a lane between two farms, or a bridge where the story crosses the river, says so
 * here. What it costs is naturalness — a heavily terraformed world looks hand-mangled — and
 * size, since every edit is bytes in the scenario. Reseeding until the map suits the story
 * is free and comes first.
 *
 * A discriminated union so that a new kind of edit is additive. The one already designed
 * and deliberately not built yet is an elevation brush: a region and a delta applied to the
 * elevation field *before* banding, so that biome, coastline and the procedural river
 * network all respond to a carved valley rather than having water tiles stamped onto a
 * hillside. See the umbrella spec.
 */
export type TerraformEdit =
	| {
			readonly t: "Path";
			readonly id: string;
			readonly from: Vec2;
			readonly to: Vec2;
			/** Odd numbers read best, since a path is laid symmetrically about its line. */
			readonly width?: number;
			/** A beaten footpath, a rutted cart track, or laid cobbles. */
			readonly surface: "path" | "dirt" | "cobble";
	  }
	| { readonly t: "Bridge"; readonly id: string; readonly from: Vec2; readonly to: Vec2 }
	/** Ground cleared of whatever the generator scattered on it, for a scene to happen on. */
	| { readonly t: "Clearing"; readonly id: string; readonly at: Vec2; readonly radius: number };
