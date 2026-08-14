---
name: game-maker
description: Use when writing, editing or reviewing a scenario for auto-adventure — a whole authored world with a story, cutscenes and chapters. Drives the `craft` CLI over a scenario directory in `.scenarios/`.
---

# Making a world

You are writing a game, not describing one. The one rule everything else follows from:

> **The only way to assert a fact about the world is to call a tool that makes it true.**

A story cannot mention a ledger unless a ledger exists — in a container, in a building, in a
named town, at real coordinates on a map. `craft place` is what makes it exist, and its
refusal is what stops you writing a story about something that is nowhere.

This exists because the pipeline it replaced did the opposite: a model wrote prose about a
world, and five passes afterwards tried to argue the world into agreement. What that produced
was worlds in which people asked the player about a document they could never find.

## Before anything else

Read `docs/gamecraft/` — every file. It is what previous runs learned, and it is short. Then
read `docs/scenarios.md` for the vocabulary: conditions, triggers, barriers, placements,
chapters, scenes, dialogue trees, recipes.

`npm run craft` with no arguments lists every command. Run it rather than guessing.

## The order of work

Do these in order. Each one is cheap to redo and expensive to skip.

### 1. Expand the premise into a story

Write `story.md` before you touch the world. A page: the beginning, the middle, the end; who
the cast are and what each of them wants; what each place is *for*. Nothing parses this file.
It is the brief you write to yourself, and it is what a person reads to judge whether the
story is worth playing.

A story that cannot be written down in a page is a story you have not decided yet, and you
will discover that later at much greater cost.

### 2. Shop for a world

```
npm run craft -- new <id> --premise "..." --duration short
npm run craft -- survey <id>
```

The survey lists every settlement the generator put there: its size, its ground, its distance
from the spawn, the anchors it will lay down. It costs nothing, because the generator is pure.

**If the map does not suit the story, reseed.** `craft reseed <id> --seed <word>` is free and
takes a second. Do it five times if you need to. A story that wants a coastal town and a
ruin two days apart is a story worth shopping for.

Reseeding stops working the moment you claim anything, because site ids come from the seed.
So do all of your shopping first.

### 3. Claim and populate

```
npm run craft -- claim <id> --site N --name "..." --description "..." --structure "inn:The Long Tide"
npm run craft -- npc add <id> --site N --name "..." --role "..." --at square --stays
npm run craft -- tree <id> --npc npc:N:0 --init
```

Then edit `trees/npc:N:0.json` directly and write the conversation. Prose is yours; the CLI
only owns what has to agree with the map.

- `--stays` for anybody an errand sends the player to find. Without it they follow a schedule
  and are somewhere else at dusk, which reads as a broken quest.
- `--like npc:N:0` for the rest of a town: they speak with somebody else's written words. Six
  householders sharing one carefully written villager is a better floor than six silences.
- `--live` only for people the story does not touch. `craft check` refuses it for anybody the
  arc anchors, and it is right to.

### 4. Beats, then chapters, then scenes

```
npm run craft -- beat add <id> --beat ask-the-ferryman --site N --slot 0 --journal "..."
npm run craft -- phase add <id> --phase after-the-flood --name "After the Flood" --when flood
npm run craft -- scene new <id> --scene the-messenger-arrives --at N --cast keeper:npc:N:0
npm run craft -- scene step <id> --scene the-messenger-arrives --spawn "rider:61,-24"
npm run craft -- trigger add <id> --trigger t --when <flag> --scene the-messenger-arrives
```

Every command takes `--phase <id>` to write into a chapter instead of the base world. There is
no `craft phase place`; there is `craft place --phase after-the-flood`.

### 5. Check after every step, not at the end

```
npm run craft -- check <id>
```

It stages every cutscene against the real world, resolves every placement, walks the arc for
reachability, and refuses anything that could never work. Run it constantly. A world that has
been checked after every command has one thing wrong with it; a world checked at the end has
twenty, and they interact.

### 6. Playtest

```
npm run craft -- playtest <id>
```

Walks the story through the real engine. `check` proves the files are consistent; this proves
the story can actually be told — that the person a beat hangs on is standing where the world
put them, that the road between two beats can be walked, that every errand can close.

### 7. Side quests, per chapter

Once the main line plays, add optional beats — `--optional` — conditioned on what has already
happened. Place what each one needs. If it cannot be placed, **delete the side quest**; do not
weaken the main line to fit it.

### 8. Play it yourself

```
npm run craft -- play <id>
```

Walk to the first town. Talk to the person the story starts with. Ask yourself whether you
would know where to go next if nobody had told you. This is the only step that catches a world
that is correct and dull.

### 9. Write down what you learned

Add to `docs/gamecraft/` anything a future run would want to know: a mistake that cost you an
hour, a shape that worked, a rule the CLI does not enforce. One short file per topic, prose,
no ceremony. The human reviews it as an ordinary commit — do not ask permission, just write it
and mention it.

## Things that are always true

- **Reseeding is free; terraforming is a debt.** Terraform grows the scenario and makes the
  world look hand-mangled. Use it for the lane the story needs between two farms, not to
  reshape a country you should have reseeded away from.
- **A scene's last step is the only place a non-idempotent effect may go.** An interrupted
  scene replays, so a `GrantItem` in the middle hands the item out twice. `craft check`
  refuses it.
- **A cast member already in the world starts where they stand.** `Spawn` is for somebody
  genuinely not there — a rider off the road. Cast a scene's rider as somebody already
  standing at the well and it will stage perfectly and nothing will move.
- **`--stays` or the schedule will move them.**
- **Nobody the story hangs on may improvise.** Talking to one *is* the story moving.
- **A signpost is derived.** `craft signposts <id>` puts a board on the road out of every town
  the story walks between, and works out every bearing from where the places really are. Never
  write a direction by hand.

## When something is refused

Read the message. Every refusal names what it wanted and lists what is actually there — which
buildings a town has, which settlements the seed produced, which people are in a site. The
answer is almost always in the refusal.

If a command refuses, **nothing was written**. The scenario is exactly as it was, so you can
try again without cleaning up.
