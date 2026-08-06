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
	/**
	 * Put something down and leave it.
	 *
	 * There is no ground-item layer, so a dropped thing is gone — which is why the
	 * panel asks before dispatching this rather than acting on the keypress.
	 */
	| { readonly t: "DropItem"; readonly name: string; readonly quantity: number }
	/** Write the save out now. Dispatched when the player asks to quit. */
	| { readonly t: "RequestSave" }
	| { readonly t: "Advance" }
	| { readonly t: "ChoiceUp" }
	| { readonly t: "ChoiceDown" }
	| { readonly t: "Confirm" }
	| { readonly t: "CloseDialogue" }
	/** Put the card away and give the player the world back. */
	| { readonly t: "DismissCard" }
	/**
	 * Ground that has just been built, and so is now known.
	 *
	 * Plural because they arrive in batches and each one that discovers new ground
	 * is a state change — which is a render and a re-uploaded frame. One command for
	 * the batch is one render for the batch.
	 */
	| { readonly t: "ChunkReady"; readonly keys: readonly ChunkKey[] }
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
