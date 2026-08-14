# What reviewing found

The first review of the first world found four things, and none of them was a broken file.
`craft check` was clean and `craft playtest` reached the end throughout. That is the argument
for the review pass existing: the checks prove a world *works*, and nothing else asks whether
it is worth playing.

## The opening card said "unstated"

`craft new` stubbed the world's era and tone with the word "unstated", and `openingCard` uses
the era as its subtitle. So the first screen of the game — before the player has done anything
— had a placeholder on it, which reads as a bug rather than as something unwritten.

**The rule.** Fill in the lore before anything else: the era, the tone, the factions, the
world's own title and premise as distinct from the story's. `craft new` leaves them empty now
rather than stubbed, and empty is invisible where a placeholder is not.

## One person in the street

Wenthollow is a village of ten roofs. It had two people in it and one of them was indoors, so
walking into the town showed a single letter standing by a well.

Two named people is enough for a *story* and nowhere near enough for a *place*. Three or four
in the open, sharing words with `--like`, costs two commands and is the difference between a
village and a diagram.

**The rule.** After the story works, go back and populate. Count the letters on the map: if a
town of ten roofs has fewer than three, it is not finished.

## An indoor character cannot be walked to

`goto npc:S:N` could not find the miller, because somebody indoors resolves only while the
player is standing in their building. That is correct behaviour and the message did not say so.

Worth knowing while authoring: a person indoors is *found*, not *approached*. The player has to
work out which building, and something has to tell them. Bran talks about the millrace, and the
seal turns up in the millrace, so the mill is worth going into — that connection is what makes
an indoor character work rather than hide.

## The reviewer must not read the files first

The strongest thing about the review pass is that the reviewer does not know where anything is.
An author cannot un-know where they put the ledger, so they are the worst possible judge of
whether anything told the player about it. Keep that separation: the reviewer plays, reports,
and does not fix.
