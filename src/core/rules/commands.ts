import type { ChunkKey } from "../world/coords.js";
import type { RegionSpec, SiteSpec, SpecSource, WorldLore } from "../world/spec.js";
import type { DomainEffect } from "./effects.js";
import type { Facing } from "./state.js";

/**
 * Everything that can change the game.
 *
 * There is exactly one entry point into state, and this is its alphabet. The
 * previous design had an action contract *and* seventeen direct store writes
 * that bypassed it, including inside the LLM tool handlers; making the alphabet
 * closed and the reducer pure is what makes that class of bug impossible rather
 * than merely discouraged.
 */
export type Command =
	| { readonly t: "Move"; readonly facing: Facing }
	| { readonly t: "Interact" }
	| { readonly t: "Advance" }
	| { readonly t: "ChoiceUp" }
	| { readonly t: "ChoiceDown" }
	| { readonly t: "Confirm" }
	| { readonly t: "CloseDialogue" }
	| { readonly t: "ChunkReady"; readonly key: ChunkKey }
	| {
			readonly t: "DialogueOpened";
			readonly npcId: string;
			readonly npcName: string;
	  }
	| {
			readonly t: "DialogueTurn";
			readonly npcId: string;
			readonly speaker: string;
			readonly text: string;
			readonly choices?: readonly string[];
	  }
	| { readonly t: "ApplyEffects"; readonly effects: readonly DomainEffect[] }
	// The director reports what it learned by dispatching, like everything else
	// asynchronous; it has no path to the state that does not go through here.
	| { readonly t: "LoreLearned"; readonly lore: WorldLore }
	| { readonly t: "RegionLearned"; readonly spec: RegionSpec }
	| { readonly t: "SiteLearned"; readonly spec: SiteSpec; readonly source: SpecSource }
	| { readonly t: "Tick"; readonly amount: number }
	| { readonly t: "Error"; readonly scope: string; readonly message: string };
