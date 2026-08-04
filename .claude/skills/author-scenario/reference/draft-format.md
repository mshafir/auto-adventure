# The draft format

One JSON file describes a whole scenario. Validated by `ScenarioDraftSchema` in
`src/scenario/draft.ts`, which is the authority if this document and the code ever
disagree.

Everything mechanical is derived on assembly, so the draft only asks for what needs
judgement:

| Derived, do not write | How |
|---|---|
| beat `order` | the order beats appear in the array |
| beat `requires` | each beat waits on the one before it |
| beat `setsFlag` | `arc:<beat id>` |
| quest `id` | the beat's id |
| npc `slot` | position in that site's `npcs` array |
| npc id | `npc:<siteId>:<slot>` |
| `spawn`, `bounds` | recomputed from the seed and duration |
| unwritten sites and regions | the deterministic fallback content |

## Shape

```jsonc
{
  "id": "drowned-archipelago",        // lower-case, digits, dashes. The filename.
  "seed": "drowned-archipelago",      // optional; defaults to the id
  "brief": {                          // what was asked for; kept with the world
    "premise": "a drowned archipelago run by debt-collectors",
    "storyline": "the player is hunting a sibling who joined the tithe-ships",
    "tone": "wry and salt-stained",
    "protagonist": "a debt-clerk who walked off the job",
    "avoid": "dragons",
    "duration": "short"               // MUST match the --duration you surveyed with
  },

  "title": "The Drowned Archipelago", // shown in the launcher
  "blurb": "Debt-collectors, rope, and a sibling who stopped writing.",

  "lore": {
    "title": "The Drowned Archipelago",
    "premise": "The tithe-ships came for the levy and the water never went back down.",
    "era": "the third year of the levy",
    "tone": "wry and salt-stained",
    "factions": ["The Tithe Office", "The Rope Guild"],
    "deities": []
  },

  "regions": [                        // optional; omitted ones get procedural names
    {
      "regionId": 123456,             // from the survey
      "name": "The Wet Reach",
      "blurb": "Low islands strung on a road that floods twice a day.",
      "tone": "wry and salt-stained",
      "culture": "Ropemakers and toll-dodgers, related to each other twice over.",
      "factionName": "The Rope Guild",
      "lore": ["The levy is counted in coils, not coin."],
      "ambient": ["Salt has got into your boots again.", "Somewhere a bell counts a tide."]
    }
  ],

  "sites": [                          // optional; omitted ones get procedural rosters
    {
      "siteId": 2150566345,           // from the survey — copy it exactly
      "name": "Thornwick",
      "shortName": "Thornwick",
      "description": "A wet little town that sells rope and asks no questions.",
      "walled": false,
      "structures": [                 // at most `buildingBudget` of them, best first
        { "kind": "inn", "size": "medium", "importance": 5,
          "name": "The Drowned Lamp", "signText": "Beds & Beer" },
        { "kind": "warehouse", "size": "large", "importance": 4, "name": "The Coil House" },
        { "kind": "house", "size": "small", "importance": 2 }
      ],
      "npcs": [                       // array order becomes their slot: 0, 1, 2...
        {
          "name": "Ilse Marrow",
          "role": "innkeeper",        // first letter becomes the map glyph
          "appearance": "Broad, sunburnt, missing two fingers on her left hand.",
          "persona": "Blunt but not unkind. Counts while she talks.",
          "disposition": 10,          // -100..100, optional, defaults to 0
          "placement": "doorstep",    // prefer one of that site's `likelyAnchors`
          "structureName": "The Drowned Lamp",   // optional; must match a structure name
          "knows": [
            "The toll clerk has not drawn a sober breath since the barge went down.",
            "Rope is worth more than silver this season."
          ]
        }
      ],
      "hooks": ["A barge went down in the narrows with the whole season's rope."]
    }
  ],

  "arc": {                            // optional; a scenario may be a place with no plot
    "title": "The Tithe",
    "premise": "Somebody has to pay for the rope, and the ledger says it is you.",
    "beats": [                        // written in the order they happen
      {
        "id": "meet-ilse",            // lower-case slug; becomes the flag and quest id
        "siteId": 2150566345,
        "npcSlot": 0,                 // index into that site's npcs
        "journal": "Ilse says the barge went down with every coil aboard.",
        "quest": {
          "name": "Find the season's rope",
          "description": "It went down in the narrows. Somebody must have salvaged it.",
          "objective": { "kind": "have", "target": "Coil of rope" }
        }
      },
      {
        "id": "the-clerk",
        "siteId": 2528282773,
        "npcSlot": 1,
        "journal": "The toll clerk has not been seen at the gate since.",
        // no quest: a beat that is only a revelation is good pacing
        "card": {                     // optional; a full screen, shown once
          "title": "The gate stands open",
          "subtitle": "and nobody is taking the toll",   // optional
          "sections": [               // 1-4 of them, each a heading and a paragraph
            {
              "heading": "What you find",
              "body": "The bar is up, the ledger is open to a page three weeks old, and the ink in the well has dried to a skin."
            }
          ]
        }
      }
    ],
    "ending": {                       // optional; one is assembled if you leave it out
      "title": "The hand you know",
      "subtitle": "read in the back room, by one lamp",
      "sections": [
        { "heading": "The ledger", "body": "Every figure is in your sister's hand." },
        { "heading": "And now", "body": "Nobody is waiting on you. The road is still there." }
      ]
    }
  },

  "content": {                        // optional; the world's own names and trades
    "id": "thornwick",
    "names": {
      "given": ["Ott", "Bevan", "Ilse"],        // LISTS REPLACE the defaults
      "family": ["Cordwright", "Tallow"],
      "heads": { "green": ["thorn", "cord"] },  // per mood: wet green cold dry high plain
      "tails": ["cross", "wait", "mere"]
    },
    "households": {                             // MAPS MERGE by key
      "house": { "count": [1, 3], "roles": ["feller", "sawyer", "child"] }
    },
    "appearance": { "feller": "Shoulders built by the work." },
    "talksAbout": { "feller": "which stands the wardens have marked" },
    "outdoorRoles": { "mill": { "role": "sawyer", "placement": "yard" } },
    "wanderers": [{ "role": "carter", "placement": "well" }],
    "lore": { "title": "…", "premise": "…", "era": "…", "tone": "…",
              "factions": ["…", "…"], "deities": ["…"] },
    "ambient": ["Somewhere off the track, an axe stops mid-stroke."]
  },

  "trees": [                          // optional; anyone omitted gets a real canned tree
    {
      "siteId": 2150566345,
      "npcSlot": 0,
      "entry": "hello",               // node a first meeting starts at
      "entryAfter": [                 // optional; used instead once the flag is set
        { "node": "hello-after-rope", "flag": "arc:meet-ilse" }
      ],
      "revisit": "again",             // optional; later meetings start here
      "nodes": [
        {
          "id": "hello",
          "speech": "You will be wanting the rope, then. Everyone is.",
          "choices": [
            { "text": "What happened to the barge?", "goto": "barge" },
            { "text": "Nothing. Good day.", "goto": null }
          ]
        },
        {
          "id": "barge",
          "speech": "Went down in the narrows. Here — this coil is all that floated.",
          "actions": [
            { "kind": "giveItem", "item": "Coil of rope",
              "description": "Tarred and heavy.", "quantity": 1,
              "questId": null, "questName": null, "note": null,
              "objectives": null, "key": null, "value": null }
          ],
          "choices": [{ "text": "Thank you.", "goto": null }]
        },
        {
          "id": "again",
          "speech": "Back again.",
          "choices": [
            { "text": "Just passing.", "goto": null },
            { "text": "About the clerk.", "goto": "barge", "requiresFlag": "arc:the-clerk" }
          ]
        },
        {
          "id": "hello-after-rope",
          "speech": "You found it, then. That will cost somebody their post.",
          "choices": [{ "text": "It will.", "goto": null }]
        }
      ]
    }
  ]
}
```

## Rules the assembler enforces

- `goto` must name a node in the same tree, or be `null` to end. A dangling one ends
  the conversation at runtime, which reads as a character with nothing to say — so
  it is rejected.
- Every tree needs a reachable way out: some node with no choices, or a `goto: null`.
- `kind` must be in `allowedStructureKinds` and `placement` in `allowedPlacements`;
  both are closed sets. Preferring a `placement` from the site's `likelyAnchors` is
  advisory — a mismatch relocates the person and warns, it does not fail.
- A beat's `journal` line is also its **clue**: it is pinned to the main quest pane as
  part of the running summary of the story, so a beat without one leaves a gap there.
  Write one on every beat.
- `content` is inlined into the artifact, so the scenario carries its own flavour
  with no file to install. Copy `assets/content/default.json` for the full shape, or
  `assets/content/thornwick.json` for a worked partial. Nothing in it can make a
  scenario unplayable — it decides names and trades, never passability or items.
- A trade you invent needs only a `households` entry; an unwritten `appearance` still
  produces a line. Write one anyway — it is the text the examine verb prints, so it
  is read more often than any dialogue.
- `arc.ending` is the last thing a finished story shows, once every beat is reached
  and every errand closed. Leave it out and one is assembled from your premise and the
  steps the player finished — so a scenario always ends rather than stopping — but a
  written one is how it gets a real last page.
- Do **not** point a beat's errand at the place that beat happens. `reach Harrowmere`
  on a beat anchored to somebody in Harrowmere completes the instant it is given. A
  final beat usually wants no errand at all.
- A `card` is for the turns a line of dialogue cannot carry: a revelation, a passage
  of time, the moment the errand becomes something else. It stops the game until it
  is read, so use two or three across a whole scenario, not one per beat. The game
  raises one of its own at the start — assembled from your lore, brief and arc
  premise — so a card on the first beat usually repeats it.
- A beat's `siteId` must be a site of this seed, and its `npcSlot` must exist in that
  site's `npcs`.
- A `reach` or `talk` objective is rewritten to the world's own spelling on assembly,
  so "green measure" becomes "The Green Measure". Names are matched on significant
  words, never on substrings — "Thorn" does **not** match "Thornwick", and a target
  nothing answers to is reported rather than silently kept.
- The first beat opens with nothing done, and each later one waits on its
  predecessor. That is automatic — you cannot get it wrong by writing.

## Actions

Dialogue actions use the same flat shape a live model emits, so `mapActions` lowers
them identically. Every field must be present; use `null` for the ones that do not
apply. Useful kinds: `giveItem`, `takeItem`, `adjustGold`, `setFlag`,
`adjustDisposition`, `recordJournal`, `heal`, `adjustReputation`, `buy`, `sell`.

Most conversations need none. Use one only when the character would really do it.

A `giveItem` action is the reliable way to satisfy a `have` objective. Validation
asks the engine's own question — `obtainableItems` — so a fetch quest also passes
when the item is on sale at a trader here, sitting in a container in one of the
buildings, or gatherable from the ground around the town. Writing the hand-over
explicitly is still the surest route, because it does not depend on a dice roll.
