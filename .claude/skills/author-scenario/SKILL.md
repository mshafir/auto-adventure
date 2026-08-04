---
name: author-scenario
description: Write a pre-generated scenario for auto-adventure — a bounded world with named towns, people, a story and authored conversations, playable with no model running. Use when asked to author, write, build or generate a scenario, adventure, campaign or story for this game.
---

# Authoring a scenario

A scenario is a world written down before it is played. The engine already decides
what *exists* — where towns are, how many buildings fit, where doors face — and you
decide what it is all called, who lives there, and what happens. You are the model
here: no API key is involved, and nothing calls out.

Three steps, in order: **ask**, **survey**, **write**. Do not reorder them. The
survey depends on answers, and the writing depends on the survey.

## 1. Ask, before anything else

The game needs specific things, and guessing them produces a scenario the player did
not ask for. Use `AskUserQuestion` to gather these — group them into one or two
calls rather than interrogating one field at a time.

**Required. Do not proceed without these:**

| What | Why it cannot be guessed |
|---|---|
| **id** | The filename and the save-slot name. Lower-case letters, digits, dashes. |
| **duration** | `short`, `medium` or `long`. Sets **both** the number of story beats **and** how large the world is — in a bounded world those are the same knob. 3 beats/4 chunks, 6/6, or 10/9. |
| **premise** | What the world is about. The one thing the whole scenario hangs on. |

**Ask about, but a sensible default is fine if the user waves it off:**

- **storyline** — the specific story wanted, if they have one in mind
- **tone** — e.g. "wry and salt-stained", "quiet folk-horror"
- **protagonist** — who the player is; the engine assumes a traveller on foot
- **setting** — refines the premise
- **avoid** — genres, tropes or subject matter to keep out
- **seed** — which world to author against; defaults to the id, so the same id
  always gets the same map. Offer to reroll if they dislike the surveyed world.
- **how much to write** — see *Scope* below. This is a real cost decision.
- **flavour** — whether the world's *names and trades* should be its own. See
  *Content pack* below; it is the cheapest way to make a scenario feel like itself.

If the user already gave some of these in their request, do not ask again. Ask only
for what is genuinely missing, and always confirm duration explicitly — it is the
one people forget and the one that changes the most.

### Scope

Writing every town and every conversation in a `long` world is a great deal of
output. Anything you leave out falls back to the deterministic content, which is a
real place with real people and a working dialogue tree — not a gap. So offer:

- **Story spine** — write only the towns the story touches, plus dialogue for the
  people who carry beats. Fastest, and the story still works end to end.
- **Full** — every surveyed settlement and every person. Best, and long.

Default to the spine for `medium` and `long`, and to full for `short`.

### Content pack

Names, trades and household rosters come from a content pack, and by default a
scenario gets the generic one — so a timber-levy road ends up with weavers and
coopers in houses called Oakmarch. A `"content"` block in the draft fixes that, and
it is high value for its length.

Worth writing when the setting has a register of its own:

- `names.given` / `names.family` — who people are called
- `names.heads` (per mood) / `names.tails` — how towns are named
- `households` — which trades live in each kind of building
- `appearance` / `talksAbout` — one line each, per trade you invented
- `outdoorRoles` / `wanderers` — who stands outside, and at the well
- `lore` — the world premise, which also feeds the opening card
- `ambient` — lines shown as the player crosses unwritten country

Maps merge by key, so a pack that adds one trade is a few lines. **Lists replace**:
supplying `given` means "these are the given names in my world". `assets/content/default.json`
is the complete default to copy from, and `assets/content/thornwick.json` is a
worked partial. The block is inlined into the artifact, so the scenario carries its
own flavour with nothing to install.

A trade you invent needs nothing but a `households` entry to work — an unwritten
`appearance` still produces a line. Writing one is just better.

## 2. Survey the world

```bash
npm run survey -- --seed <seed-or-id> --duration <duration>
```

This costs nothing and calls nothing. Read it carefully — it is the ground truth,
and writing against anything else produces content the game will reject:

- `sites[]` — every place, with `siteId`, `kind`, `importance`, `distanceFromSpawn`,
  `biome`, `terrain`, `coastal`, `nearRiver`, `roadCount` and `neighbours`.
  **Sites are ordered nearest-first**, which is how to pace a story outward.
- `buildingBudget` — author **at most** this many structures for that site. More
  will not fit and the surplus is silently dropped.
- `likelyAnchors` — the anchor kinds that settlement will actually lay down. Prefer
  one of these for an NPC's `placement`. It is advisory, not fatal: `pickAnchor`
  serves a `yard` from a `doorstep` and falls back to any free anchor otherwise, so
  a mismatch means "they stand somewhere else", not "they stand nowhere". Assembly
  warns rather than refusing.
- `allowedStructureKinds` / `allowedPlacements` — closed sets. Anything else fails.
- `bounds`, `spawn`, `plan.beats` — the world's edge, where the player wakes, and
  how many beats the chosen duration wants.

Tell the user what the world looks like — how many settlements, how far apart, what
kind of country — before you write a story into it. If it is a poor fit for their
premise (all desert for a seafaring tale), say so and offer a different seed.

## 3. Write the draft

Write one JSON file. The format is in `src/scenario/draft.ts`, and there is a worked
example plus every field explained in `reference/draft-format.md` — read it before
writing. Put drafts in `drafts/<id>.json`.

The draft deliberately does **not** ask you for the mechanical parts. Beat order,
gating flags, quest ids and npc ids are all derived on assembly, so you cannot
author a story that waits on a flag nothing sets. Write beats in the order they
should happen; that *is* the order.

Then:

```bash
npm run assemble -- --draft drafts/<id>.json --check   # validate, write nothing
npm run assemble -- --draft drafts/<id>.json           # validate and install
```

Assembly runs the real generator over your words and reports what will not work.
**Errors block the install** — a beat anchored to somebody who is not there, a beat
that cannot be walked to, a `goto` pointing at a node you did not write, a site id
that is not a site of this seed. Fix those in the draft and re-run. Do not pass
`--force` to get past a real problem, and do not report success while errors stand.

Warnings are judgement, not failure, and a healthy draft has several. Expect these:

- *asked for N structures, M fitted* — the budget is advisory and plots are finite.
  Only worth acting on if something important was dropped.
- *X belongs to "Y", which was not built* — that structure lost its plot, so they
  will be placed elsewhere in town.
- *asked for a "yard"* — see `likelyAnchors` above.
- *the story is N tiles of walking* — the beats are closer together or further apart
  than the duration implies. Worth fixing by choosing sites at different distances,
  since this is the one warning that changes how the scenario actually plays.
- *N of M people have no written dialogue* — expected when writing a spine.

## Say where to go next

The commonest way a finished scenario disappoints is that it reads well and the
player has no idea what to do. The game does some of this for you — the opening card
names the first beat's town, who to ask for, and which way it lies; open errands are
marked on the map with a bearing — but only if the draft gives it something to point
at. So:

- **Give most beats a quest, and point it at somewhere.** A `reach` objective is the
  strongest, because it puts a bearing on the map and completes on arrival. A beat
  with no quest is a revelation with no direction, which is fine once and poor twice.
- **Never write a quest the same conversation satisfies.** `have: "X"` for an item
  the NPC hands over in that breath completes instantly and directs nobody. Ask for
  the *next* place instead, and let the item be the reason.
- **Name the next place in dialogue, and say where it is.** "Went up toward
  Stonewait" is weaker than "up the high road toward Stonewait — north and uphill,
  you cannot miss it".
- **Put the destination in the quest description too.** It is what the player reads
  in the panel three sessions later when they have forgotten.

## Writing well

Match the house style the rest of the game is written in: concrete, specific,
unsentimental, like a good tabletop GM. One telling detail beats three adjectives.
Never mention game mechanics, tiles, seeds, or that any of it is generated.

- **Names** should sound like the region they are in, not like fantasy defaults.
- **`knows`** is what a person will actually tell the player if asked — rumours,
  prices, directions, grudges. Make at least one person per town know something the
  player could act on.
- **Dialogue** is choice-only: every `choices[].text` is a line the *player* speaks.
  Keep speech to one or two sentences; this is a terminal panel.
- **Beats** should each be one thing learned or asked for. A beat that is only a
  revelation is good pacing — not every one needs a quest.
- **The last beat should close the story**, not open another door.
- **Quest objectives must be satisfiable**, and this is checked against the engine's
  own rules rather than a guess. `have` passes if a `giveItem` action hands the item
  over, or a trader here stocks it, or a container in one of the buildings holds it,
  or the ground around the town yields it. `reach` needs a place or building name,
  `talk` a person's name — matched on significant words, so "Thorn" will not do for
  "Thornwick". Assembly rewrites a loose name to the world's spelling where it can,
  and reports it where it cannot.

## When you are done

Report: where it installed, how many places were written versus left procedural,
how many beats, how many conversations, and any warnings that stand. Then tell them
it appears in the launcher on `npm start`, under **Scenarios**.
