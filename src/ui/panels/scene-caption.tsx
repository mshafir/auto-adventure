import { Box, Text } from "ink";
import type { SceneState } from "../../core/rules/scene.js";

/**
 * What somebody is saying while the world holds still.
 *
 * A band under the map rather than a full screen, because a cutscene's whole point is that
 * you are watching something happen — a card would cover the thing being said *about*. The
 * card step is still there for the moments that really are a page of prose.
 *
 * Takes the same rows as the conversation panel and sits in the same place, so a scene
 * beginning does not move the map up or down. That matters more than it sounds: the viewport
 * memoises its whole frame on its dimensions, and a band that changed the map's height would
 * re-rasterise every tile at the start and end of every scene.
 */

/** The speaker's name, the line, and a hint. Fixed, so the map above never moves. */
export const SCENE_CAPTION_ROWS = 4;

export interface SceneCaptionProps {
	readonly caption: NonNullable<SceneState["caption"]>;
	/** Who the alias refers to, when the scene named somebody the world knows. */
	readonly speakerName?: string;
	readonly width: number;
	readonly skippable: boolean;
}

export function SceneCaption({ caption, speakerName, width, skippable }: SceneCaptionProps) {
	const who = speakerName ?? caption.speaker;
	return (
		<Box flexDirection="column" width={width} height={SCENE_CAPTION_ROWS}>
			{/* Magenta rather than the map's story colour: an Ink colour name degrades with the
			    terminal, and `PAL.story` is an rgb triple for the pixel renderer. */}
			<Text color="magenta" bold wrap="truncate">
				{who}
			</Text>
			<Text wrap="truncate-end">{caption.text}</Text>
			<Text dimColor wrap="truncate">
				{skippable ? "SPACE to go on · ESC to skip" : "SPACE to go on"}
			</Text>
		</Box>
	);
}
