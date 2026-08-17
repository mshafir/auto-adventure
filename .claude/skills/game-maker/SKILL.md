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

**The seed gives you land and nothing else.** No towns, no ruins, no caves — every one of
those is yours to put somewhere for a reason. The survey therefore lists *ground*: which cells
will hold a village, how far each is from the spawn, what the country is like there, and how
many buildings will actually fit. Every row is measured by laying a settlement out on that
cell, so a row it prints is a place `craft found` will accept.

**Place things a real distance apart.** The survey prints the reach between every candidate
and everything already founded — `adjacent`, `neighbouring`, `a walk`, `a journey`, `far` —
and `--reach "a journey"` asks it for somewhere at least that far. Most legs of a story want
to be `a walk`; one may be `a journey`. Two places that come out `adjacent` are one place with
two names, which is the mistake the first world made and the player noticed immediately.

**If the ground does not suit the story, reseed.** `craft reseed <id> --seed <word>` is free
and takes a second. Do it five times if you need to. A story that wants a coast and a deep
forest two days apart is a story worth shopping for.

Reseeding stops working the moment you found anything, because site ids come from the seed.
So do all of your shopping first.

### 3. Found and populate

```
npm run craft -- found <id> --at x,y --name "..." --description "..." --structure "inn:The Long Tide"
npm run craft -- npc add <id> --site N --name "..." --role "..." --at square --stays
npm run craft -- tree <id> --npc npc:N:0 --init
```

`found` writes both halves at once — the recipe entry that makes the generator build the
place, and the spec that names it — and hands back the site id everything else refers to it
by. `--kind hamlet|village|town|fort` and `--importance 1..5` decide how big it is; the
refusal tells you the real building budget before anything is written.

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

### 8. Have it reviewed, then play it yourself

Dispatch a reviewer with the `game-reviewer` skill. It plays the world without reading the
files first — which is the point: you cannot un-know where you put the ledger, so you are the
worst possible judge of whether anything told the player.

Address what comes back, worst first. A dead end or a lie is not negotiable. "The second town
feels like a set" usually means one more written conversation and one more reason to be there.

Then play it yourself anyway:

```
npm run craft -- play <id>
```

Walk to the first town. Talk to the person the story starts with. Ask whether you would know
where to go next if nobody had told you.

### 9. Write down what you learned

Add to `docs/gamecraft/` anything a future run would want to know: a mistake that cost you an
hour, a shape that worked, a rule the CLI does not enforce. One short file per topic, prose,
no ceremony. The human reviews it as an ordinary commit — do not ask permission, just write it
and mention it.

## Things that are always true

- **Reseeding is free; terraforming is a debt.** Terraform grows the scenario and makes the
  world look hand-mangled. Use it for the lane the story needs between two farms, not to
  reshape a country you should have reseeded away from.
- **Moving the ground is a bigger debt, and it goes first.** `terraform --lower/--raise`
  changes the elevation field itself, so the coastline, the buildable ground and the rivers
  all move with it — which is the only way to author a river, and the reason an earthwork
  under a town is refused. Shape the land before you found anything on it.
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
