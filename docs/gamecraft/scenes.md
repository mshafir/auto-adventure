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

## How long a frame is, which is the mistake I made

**A frame is ninety milliseconds, and every duration is counted in frames.** The first scene
this engine shipped was written with `"hold": 3` on every step, which reads as three beats and
is a quarter of a second. Its whole visual content — a camera moving to a village, a rider
appearing on the road, a rider crossing the square — took under two seconds, and the player who
played it said it went by too fast to tell what had happened. They were right.

The numbers worth having in your head:

- **A hold of 5** is about half a second, which is the floor `craft check` asks for and about
  as short as something can appear and still register.
- **A hold of 8 to 10** is what a spawn actually wants. Somebody who was not on the road a
  moment ago needs a second of standing there before they move, or the player's eye never
  finds them.
- **A walk is the cheapest length you have.** Twenty tiles at `normal` is three and a half
  seconds of somebody visibly arriving, and it costs one step.
- **`fast` is a gallop**, eleven tiles a second. Right for a rider on a road, wrong for
  somebody crossing a room, and wrong for the arrival you want the player to watch.

Time it before you ship it. Add up the holds, add two frames per tile of every `normal` walk,
and if the answer is under about five seconds of watching, the scene has not earned the
interruption.

Pacing is edited in the scene file directly, like prose — `craft scene step` appends, it does
not retime. Holds and speeds are the two things in a scene that need no knowledge of the world,
which is exactly why the CLI does not own them.

## When a scene actually fires, which is not when you think

**A cutscene waits for the conversation to end.** A beat's flag is set the moment its
conversation *opens*, so a trigger watching for that beat is true while the player is still
reading the first line. The engine now holds the scene back until the dialogue closes — but
that changes what a scene off a beat *means*, and it is the difference between a scene that
reads and one that does not:

> The scene plays when the player walks away from the conversation, not during it.

So a scene hung off a beat has to show a **consequence**, not a continuation. "The rider
arrives and tells the keeper the news" is a continuation, and it played after the keeper had
already said the same thing — which is exactly what a player reported as "the cutscene didn't
make much sense".

**Never hang a scene off the last beat.** The arc's ending card fires on the same command the
last beat's conversation closes on, and it goes up first — so the story is declared over and
*then* the climax plays. Put the scene on an earlier beat, or on a chapter flag, and let the
last beat be the thing that ends it.

**Arrival is usually a better trigger than a beat.** `--when-visited <site>` fires when the
player walks in, with nothing open and nobody mid-sentence, which is the cleanest moment a
scene can have.

## Somebody walking up to somebody else

A scene walks to *places* — the well, the gate, the shrine door — and a place is exactly where
somebody stands, because that is where the generator puts them. Walking onto the well drew the
rider standing inside the keeper: one figure crossed the square and disappeared into another.

Staging stops the walker one tile short now, which is also what the sentence meant — "the rider
comes to the keeper" is approach, not merger — and the last step of an approach leaves them
facing what they approached. Nothing to do about it while authoring except know that the
arriving actor ends up *beside* the anchor, not on it.

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

## The three ways a scene comes out inert

1. **The actor is already where it is walking to**, so the walk is zero tiles. See
   `failures.md`. Cast someone who is not there and spawn them.
2. **The camera never moves and nobody enters**, so the only thing that changes is the text.
   That is a card, and a card is a better card than a scene is.
3. **Everything happens, and it happens in a second and a half.** The check catches the worst
   of this now; it cannot catch a scene whose every step is individually long enough and which
   is still over before it has been understood.

All three stage clean. Only the third is checkable at all, and the way to find any of them is
to watch it — `craft play`, and take the scene at its own speed.
