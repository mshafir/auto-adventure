# When the tool is wrong about the world

Everything here was found by building one world end to end, and every one of them presented as
a fault in the *world* when it was a fault in the instrument. That is the worst failure mode a
review tool has, so they are written down together.

## `craft check` passing is not the same as the game working

The check builds the ground around every founded place and derives its roster before staging a
cutscene. The *game* fills the world in around the player as they walk. So a scene can stage
perfectly in `check` and fail in play, and the difference is always about what exists yet.

**If a scene will not play, look in `log.txt` for "cannot be staged".** Nothing surfaces it in
the game — the trigger is simply left unfired, which is correct behaviour and invisible.

## A cast member who does not stay is not there

`--stays` is not a nicety. Anybody without it follows a schedule, so a scene cast on them
stages at eight in the morning and fails at eleven with its whole cast at work — and the
message used to say only "not on stage", which reads like a typo in an alias.

**Cast only people with `--stays`, or spawn stand-ins.** A scene about a crowd gathering does
not need the crowd to be the real villagers.

## `--when-visited` wants a place, and takes a site id

Arrival is recorded as `visited:<place name>`, lower-cased. A condition written against a site
id can never be true, and the CLI used to accept one, print "fires once the player has been to
2730798778", and produce a cutscene that never played. Both spellings are accepted now and
anything that names no place is refused with the list — but if you are reading an older
scenario, check its conditions.

## `flags` is the command that answers "why has that not happened"

`craft play` has it. A trigger is a condition over flags, so a scene that never fires is either
a flag nothing wrote or a condition written against a name nothing writes. Print the flags and
the answer is usually immediate.

## Distances are Manhattan

Movement is four-connected. A place two hundred tiles east and two hundred north is *four
hundred* steps away, not two hundred and eighty. `distance.ts` measures it properly now; the
old straight-line figures understated every diagonal leg by up to root two, which is how a
"journey (429)" turned out to be a 583-tile walk and tripped the leg limit.

## Founding is not final, and never was documented as such

- `craft site set --kind town --importance 5` changes a place already founded. The cell does
  not move, so the id does not either, and nothing written against it has to be touched.
- `craft npc set --npc ... --like/--stays/--live/--at` changes somebody already there.

Both exist because the first world built in the intended order — populate, then write the
conversations, then discover the four householders should be sharing them — had no way back
except starting the town again.

## A village will not build a warehouse

Each kind has a roster of what it builds, and asking for a building outside it means the check
reports "asked for 1 warehouse, built 0" after the fact. If you want a warehouse, found a
`town`. `craft site set --kind town` is the fix, not a bigger `--importance`.
