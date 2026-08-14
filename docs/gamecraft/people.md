# People

A town of six with one conversation between them is a town nobody wants to walk around. A town
of six with six written conversations is most of the cost of a scenario. The vocabulary exists
to get most of the first for the price of the second divided by six.

## Three ways somebody can speak

**Written words.** `craft tree --npc <id> --init`, then write the prose. This is what the
people the story turns on get, always.

**Shared words.** `craft npc add ... --like npc:N:0`. They speak with somebody else's tree.
One carefully written villager answers for the five other householders, and the player meets a
town that talks rather than a town of menus. Free.

**Improvisation.** `--live`. A model speaks for them at play time, one call per reply, and the
reply is remembered in the save so the same exchange is never paid for twice.

And the floor under all three: somebody with none of them gets a deterministic conversation
built from what they know and what the site's hooks say. It is a real conversation, not
silence — but it is the same every time, and a town of six of them reads as a town of six
identical people.

## Who gets what

| Who | What |
|---|---|
| Anyone the arc anchors | Written words. Never `--live` |
| Anyone with something specific to say | Written words |
| The rest of a town | `--like` somebody who has words |
| Somebody deliberately ambient | `--live`, if the world is meant to cost anything |

`craft check` refuses `--live` on a story anchor, and the runtime refuses it too. Talking to
one *is* the story moving — the beat has opened, the errand is in the log — and a model asked
to greet the player writes a fine line about the weather while the thing it was meant to hand
over goes unmentioned.

## `--stays`, or they will not be there

Without it, an NPC follows a schedule: the square in the evening, home at night. That is the
cheapest thing in the game that makes a village feel inhabited, and it is exactly wrong for the
person an errand names. The player arrives at dusk, they are elsewhere, and nothing on screen
says the game has hours.

Every beat anchor wants `--stays`. Almost nobody else does.

## Indoors

`--in "The Long Tide" --indoors` puts somebody in a building. Their id is unchanged, so beats,
trees and `talk` objectives work exactly as they do for anyone in the street — but the player
has to open a door to find them, which is worth doing for two or three people and tiresome for
a whole town.

An indoor character behind a locked door is a good shape for a story: the lock is a beat, and
the room is the reward.

## What `knows` is for

Each line is something the deterministic conversation may raise, and something the dialogue
layer can hand a model as material. Two or three concrete facts beat six vague ones — "the
millrace runs fast after rain and catches whatever the river brings" is usable; "knows about
the mill" is not.
