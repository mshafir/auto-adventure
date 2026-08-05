/**
 * Every feature builder, loaded.
 *
 * A registry only contains what has been registered, and a builder registers itself
 * when its module is evaluated — so a module nobody imports is a site kind that
 * silently generates nothing. That is not a hypothetical: moving the settlement
 * generator behind the registry left `pipeline.ts` importing only the *type*
 * `SettlementSpec` from it, type imports are erased, and every town in the world
 * quietly stopped being built. The goldens caught it; nothing at runtime would have.
 *
 * So there is exactly one place that names the builders, this is it, and anything
 * that generates terrain imports it. Adding a region is a new file and a line here.
 */

import "./settlement.js";
import "./castle.js";
import "./docks.js";
import "./cave.js";

export { featureBounds, featuresOverlapping, registeredFeatures } from "./registry.js";
