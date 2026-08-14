# Scenes

A cutscene is the only thing in the game that shows the player something rather than telling
them. Used well it is the difference between being told a chapter turned and watching it turn;
used badly it is a caption over a still picture.

## What makes one worth watching

**Something has to move.** A scene whose every step is a `Say` is a conversation with the
controls taken away. At least one actor should walk, arrive, leave, or turn.

**The camera should look at what is happening**, and it should get there before the thing
happens. A `slow` pan onto an empty gate, then somebody walking through it, reads as
anticipation. A cut to somebody already standing there reads as a jump.

**Give the last step a `hold`.** The frame a step completes on is the only frame an actor is
drawn standing at the end of its walk — except the last step, whose completion hands control
straight back. Without a hold, the final beat of a scene is never seen.

## Length

Four to seven steps. A scene of twelve is a chapter and wants to be two, with the player given
the world back in between — partly for pacing and partly because a long scene is a long time
holding a skip key.

## Where the effects go

Everything a scene changes should be in its **last step**. Not only because non-idempotent
effects are refused anywhere else — an interrupted scene replays — but because it reads
better: the prose happens, and then the world is different.

A scene that sets its chapter flag in step two and then plays three more steps has already
turned the chapter while the player is still watching the reason for it.

## Skipping

Assume every player skips. `ESC` applies all of the scene's remaining effects, so skipping
skips the prose and never the consequences — but it does mean anything the player *needs* to
know cannot only be in a caption. Put it in the journal, or in a card, or in the conversation
that follows.

`--unskippable` exists. Use it approximately never.

## The two ways a scene comes out inert

1. **The actor is already where it is walking to**, so the walk is zero tiles. See
   `failures.md`. Cast someone who is not there and spawn them.
2. **The camera never moves and nobody enters**, so the only thing that changes is the text.
   That is a card, and a card is a better card than a scene is.

Both stage clean and pass every check. The only way to find them is `craft play`.
