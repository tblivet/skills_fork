# How the report looks

`report.js` writes the whole of this into the page as one `<style>` block. Nothing is fetched, so
the report opens with no network and reads the same in a year. Change a value here and change it
there, or this file becomes a description of something that no longer exists.

## The one idea

**The reader is deciding whether to trust the campaign**, not admiring it. So the page leads with
how much was actually covered, not with a score, and every claim sits next to the thing that
backs it. Nothing is styled to look reassuring.

## Colour

| Token | Light | Used for |
| --- | --- | --- |
| `--ink` | `#1d1d1f` | text |
| `--muted` | `#6b6b70` | labels, captions, anything secondary |
| `--line` | `#e3e3e6` | the only border in the system |
| `--bg` | `#fff` | the page |
| `--panel` | `#f6f6f8` | cards, table headings, findings |
| `--ok` | `#1d7a46` | settled and holding |
| `--bad` | `#c0233c` | settled and not holding, and blocker |
| `--look` | `#8a5a00` | waiting for a person, and major |
| `--flat` | `#6b6b70` | not covered, and minor |

Every one is redefined for a dark screen, and again under an explicit dark choice, so the page
follows the reader's setting in both directions. `body` paints its own background: a transparent
page borrows whatever is behind it and stops being legible.

**Waiting for a person is not a warning colour by accident.** It is the amber of something
unfinished, because that is what it is, and a report where half the checklist sits in amber is
telling the truth about itself.

## Type and space

The reader's own interface face, reached through the system stack so nothing is downloaded.
Every length in `rem`, so a reader who has set a larger default gets it.

Sections are separated by a rule and generous space above the heading, never by a box. The only
boxes are the five headline cards, the findings, and the warnings, which earn one because they
interrupt.

## Layout

One column, at most `74rem`, with a gutter that never disappears. Everything reflows at phone
width: the cards, the environment list and the finding panels all wrap to one column, and only
the proof-of-test table scrolls sideways, inside its own frame. The page itself never scrolls
sideways at any width, which is checked the same way the campaign checks the theme.

## What it must never do

* Show a single percentage. Points and cells are different units and mixing them into one figure
  is how a partial campaign starts looking complete.
* Colour a partly covered point green, or fold it into the settled count.
* Show a finding without the evidence beside it.
* Load anything from outside itself.
