# Pixel renderer + HUD restructure — working plan

Branch `quadrant-render`, in the worktree `.claude/worktrees/quadrant-render`,
rebased onto `origin/main` at `2323f6a`. 899 tests pass, typecheck and lint clean.

---

## 1. Facts that were expensive to establish

These were each found the hard way. None should be re-derived.

### Ink cannot lay out astral-plane characters beside anything

A kitty placeholder is `U+10EEEE` — a surrogate pair, so **one display column but
two UTF-16 code units**. Ink measures with `string-width` (correct) but slices by
code unit when compositing, so a placeholder row loses half its cells.

It only happens when something shares the row. Measured across five layouts
(`src/ui/ink-astral.test.tsx`):

| layout | placeholders rendered |
| --- | --- |
| bare text | 20 / 20 |
| explicit width on the box | 20 / 20 |
| width on an outer box only | 20 / 20 |
| **flexGrow column + sibling** | **15 / 20** |
| full width, no sibling | 20 / 20 |

**Consequences, and the reason for this whole restructure:**

- The map must own its rows. A side panel beside it halves the placeholder grid
  and the panel gets composited into the hole — the smearing seen on screen.
- Anything that must appear *over* the map has to be **composited into the frame**
  (the `Cell` grid or the pixel buffer), never laid out as an Ink sibling.
- Full-frame views (reader, card) have no map on screen, so they are unaffected.

### Escape sequences

- Always `""`. Never a raw control byte in source: one shipped with **no
  escape at all** (`stdout.write("[16t[14t")`), printed as text, and the test
  meant to catch it asserted the same typo so it passed.
- An APC graphics escape measures ~24+ columns to `string-width`, so image data
  can never go inside a `<Text>`. Ink's `Transform` does not save this — it
  bypasses layout, not row composition.

### kitty protocol details already settled

- Image is written **straight to the stream** during render (not an effect: Ink
  writes its frame from `resetAfterCommit`, which runs *before* layout effects).
- **Delete before every upload** (`a=d,d=I`) in the *same string*. `a=T` creates a
  placement; a fixed `p=` does not make a second one replace the first, so
  without the delete, copies stack up across the terminal.
- Placeholders: one **row** diacritic to anchor each row, then bare continuation.
  The diacritic table is deliberately only 64 entries — enough for rows, never
  enough for columns, and wrong values fail silently.
- Cell size is measured at startup via `CSI 16 t` (+ `CSI 14 t` fallback) before
  Ink takes stdin. Ghostty answers `16t`: `<ESC>[6;42;19t` → 19×42 px.
  `CELL_PX=WxH` overrides.

### Verification without a human in the loop

```
npm run capture      # script(1) gives a real PTY at 163x37, runs the game 6s
npm run analyze      # parses the bytes: graphics commands, tiles per row, widths
```

`src/tools/analyze-capture.ts` found the halving in one pass after four rounds of
misreading screenshots. **Use it before asking for a screenshot.** It cannot tell
you how the terminal *drew* something — that still needs eyes.

Also: `npm run kitty-geometry`, `npm run kitty-check`, `npm run pixel-shot`.

---

## 2. Where the code stands

- `src/ui/render/sprite.ts` — sprites are **procedures over the unit square**, so
  `TILE_PX` (16) is a free choice. Density glyphs blend flat rather than dither
  (dithering made grass into static). Sprites key off terrain/decor **id** where
  the glyph is ambiguous (`▒` is both roof shingle and bush).
- `src/ui/render/raster.ts` — `Cell[][]` → RGB buffer. Both renderers consume the
  same `composeScene` output, which is why one overlay can serve both.
- `src/ui/render/kitty.ts`, `mode.ts` — protocol and mode resolution. Glyphs are
  the permanent floor; detection is conservative and every failure ends in glyphs.
- `src/ui/viewport.tsx` — dispatches `GlyphViewport` / `KittyViewport`.
- Main already added `panels/reader.tsx` (full-frame lists) and
  `panels/primitives.tsx` (Rule, Field, Prose, ScrollList, Bullet).

---

## 3. Target layout

```
┌───────────────────────────────────────────────────────────┐
│ TOP BAR: place · clock/day · light · weather · ground      │  full width, own rows
├───────────────────────────────────────────────────────────┤
│                                                            │
│  MAP — full width, owns every one of its rows              │
│                                            ┌────────────┐  │
│                                            │  minimap   │  │  composited INTO the
│                                            └────────────┘  │  frame, not a sibling
├───────────────────────────────────────────────────────────┤
│ DIALOGUE / LOOKING                                         │
├───────────────────────────────────────────────────────────┤
│ KEY BAR                                                    │
└───────────────────────────────────────────────────────────┘
```

Full-frame views replace everything above the key bar:

- **Reader** (inventory / quests / journal) — one border style
- **Card / story** — a *different* border style

---

## 4. Design decisions

**Minimap is composited, with no legend.** Shared pure data, two painters:

- `minimapCells(state, w, h) → MiniCell[][]` — pure, no React. Colour + glyph per
  chunk. Extracted from today's `panels/minimap.tsx`.
- Glyph mode: paint into the **expanded** `Cell[][]` (cell space, after
  `expandScene`) so it is not stretched 2× by `TILE_WIDTH`.
- Kitty mode: paint into the **RGB buffer** after `rasterScene`, a few pixels per
  chunk — so it gets real pixels rather than upscaled glyphs.

**Full-frame, not floating popups.** A bordered box floating over the map is a
sibling on those rows and would reintroduce the halving. Full-frame sidesteps it,
and the map is not visible underneath anyway.

**Two border styles**, both from Box Drawing (already allowlisted by
`glyph-safety.ts`, single-width everywhere):

- Reader: heavy `┏━┓` — "you are in a mode, press ESC"
- Card/story: rounded/double `╭─╮` or `╔═╗` — "the game is telling you something"

**Both modes throughout.** The top bar, reader, card and key bar are ordinary Ink
text and identical in both. Only the minimap needs two painters, sharing one
source of truth.

---

## 5. Steps

Each step ends green: `npx tsc --noEmit`, `npx vitest run`, biome clean.

1. **Extract minimap data.** `src/ui/render/minimap-data.ts` exporting
   `MiniCell` and `minimapCells(state, w, h)`. Port the biome/settlement/quest
   logic out of `panels/minimap.tsx` verbatim. Unit tests: player at centre, only
   discovered chunks drawn, quest marks win over settlements.

2. **Composite it — glyph mode.** `overlayMinimap(cells, mini, {corner})` in
   `src/ui/render/overlay.ts`, painting into `Cell[][]` with a one-cell border.
   Wire into `GlyphViewport` after `expandScene`. Test: minimap cells land in the
   bottom-right, map cells elsewhere untouched.

3. **Composite it — kitty mode.** `paintMinimap(frame, mini, {corner, scale})`
   painting into the RGB buffer after `rasterScene`. Wire into `KittyViewport`.
   Test via `pixel-shot` PNG (I can read it back and check the corner).

4. **Top bar.** `src/ui/panels/top-bar.tsx` — place name, clock + day + light,
   weather, ground summary, position. Full width, fixed height (1–2 rows), lifted
   from `MapTab` in `side-panel.tsx`.

5. **Remove the side panel.** Delete `SidePanel`, its `SIDE_PANEL_WIDTH`, and the
   `map`/`world` tabs' condensed views. Map becomes full width. `PanelTab` moves
   to `hud-state.ts` and narrows to the three list tabs. Update `route-key.ts`
   and `key-bar.tsx` for the new tab set. **This is the step that fixes kitty.**

6. **Borders.** `Frame` in `primitives.tsx` taking a style
   (`"reader" | "card"`), wrapping `Reader` and `CardScreen`.

7. **Verify.** `npm run capture && npm run analyze` — expect tiles per row to be
   a **single constant** equal to the map width, and one upload with one delete.
   Then `npm run pixel-shot` to check the minimap corner. Then a screenshot.

8. **Goldens and screenshots.** `test/goldens/*` and `docs/screens/*.svg` will
   move; regenerate (`npm run screens`) and eyeball the diff.

---

## 6. Risks

- **`route-key.ts` / `hud-state.ts` churn.** Main just reworked these (`f3e14dc`);
  narrowing `PanelTab` touches both plus their tests. Do step 5 in one commit.
- **Minimap in kitty mode is on a per-frame path.** It is painted into the buffer
  every frame; keep it cheap (a few hundred pixels).
- **Per-frame cost.** Delete + re-upload re-sends 30–45KB even when the scene is
  unchanged, cancelling the memoisation win. If it feels sluggish, delete only
  when geometry changes and re-send pixel data alone. Not yet measured in-game.
- **The tileset is still a first pass.** ~20 id-based sprites over glyph
  fallbacks. Worth its own round once the layout is settled.
- **Ink could fix the astral bug.** `ink-astral.test.tsx` will start failing if it
  does, at which point a floating minimap becomes possible again.
