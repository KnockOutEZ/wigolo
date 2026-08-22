# Wigolo Studio — Design System

Authoritative spec for building Wigolo Studio UI. Derived from `Wigolo Studio UI.dc.html`
(14 hi-fi screens) and `Wigolo Studio Wireframes.dc.html` (48 frames).

**Rule zero:** if a value is not in this document, do not invent it — find the nearest
token here and use it. New features get built from existing primitives. If a genuinely
new primitive is needed, add it to this file in the same pass as the code.

---

## 1. Product laws (they constrain the UI, not just the copy)

These are architectural facts. UI that contradicts them is wrong even if it looks good.

1. **The run is the unit.** A run = task + transcript + tab group + action log + pending
   decisions. It lives in the daemon and outlives every UI. Screens are views of runs, not
   of "chats" or "agents". Always show the run id (e.g. `7fq2`).
2. **One driver at a time.** `cli · sdk · api · studio · human`. Show the current driver
   explicitly. Never render two drivers as simultaneously active.
3. **A tab belongs to exactly one run.** The user's own tabs are a separate group and are
   invisible to every agent. Never mix them in one list.
4. **Capabilities, not brands.** UI reads `push · narrate · reasoning · interrupt · resume ·
   identity`. Never branch layout on "is this Claude Code". Brand names appear only as
   labels of a connection the user made.
5. **Pull transports queue.** For MCP/shell-out drivers every user message has a delivery
   state (queued → delivered at step N → acknowledged). Never imply instant delivery.
6. **Marks are the shared address space.** Numbered DOM marks. The same number appears on
   the page, in chat, in the terminal, in the replay and in the audit log.
7. **Approvals are anchored to the element** they concern, and answerable from either
   surface. Never a centred system modal.
8. **The terminal is a designed surface.** No plugin exists, so tool-result text *is* UI.
   Terminal blocks are rendered as first-class components, not decoration.
9. **Everything is local and inspectable.** Cost, tokens, what left the machine, file paths.
   Show them; do not hide them behind a settings page.
10. **A fresh profile with the panel closed is an ordinary Chromium browser.** AI is one
    extra verb on an existing surface, never a new resident surface.

---

## 2. Two style registers

| | Wireframes | Hi-fi UI |
|---|---|---|
| File | `Wigolo Studio Wireframes.dc.html` | `Wigolo Studio UI.dc.html` |
| Purpose | exploring/spec'ing flows | what gets built |
| Look | paper, ink hairlines, hand notes | pure black, hairline geometry, thin type |
| Ship code from | never | always |

Build product code from the **hi-fi** register (§3–§6). The wireframe register (§7) is only
for adding new exploratory frames to the wireframe doc.

---

## 3. Tokens — hi-fi (the product)

### Surfaces
```
--bg              #000        page, window body
--surface-panel   #060606     side rails, panels
--surface-tile    #080808     cards inside a dark region
--surface-term    #070707     terminal blocks
--surface-page    #fff        rendered web content only (never chrome)
```

### Lines
```
--hair            rgba(255,255,255,.12)   card & window borders
--hair-soft       rgba(255,255,255,.08)   internal dividers
--hair-faint      rgba(255,255,255,.07)   page-placeholder outlines
--hair-dash       rgba(255,255,255,.14)   dashed secondary containers
```
All borders are exactly **1px**. No 2px borders, no double borders.

### Text (white at fixed alphas — do not invent new ones)
```
.95  primary heading in a card        .5   muted mono
.85  emphasis body                    .42  mono default
.72  body                             .36  micro-caps label
.62  secondary body                   .3   timestamps, hints
.5   labels                           .24  placeholder text in page mocks
```

### Accents — only two, and each means one thing
```
--agent        oklch(0.8 0.06 250)     agent identity, agent-caused state
--agent-text   oklch(0.88 0.04 250)
--agent-tint   oklch(0.8 0.06 250 / .06 … .10)
--agent-edge   oklch(0.8 0.06 250 / .40 … .50)

--attention        oklch(0.78 0.09 60)   ONLY "needs you" / blocked / risky
--attention-text   oklch(0.84 0.08 60)
--attention-tint   oklch(0.78 0.09 60 / .06 … .10)
--attention-edge   oklch(0.78 0.09 60 / .45 … .50)
```
Secondary agent hues (for distinguishing several agents at a glance) rotate hue only:
`oklch(0.8 0.06 200)`, `oklch(0.8 0.06 300)`. Never change L or C.

**Forbidden:** green/red semantic pairs, more than two accent families, gradients as
decoration, colored text on colored fill.

### Type
```
--sans   'Helvetica Neue', Helvetica, Arial, sans-serif   weights 300 / 400 / 500 only
--mono   ui-monospace, Menlo, monospace                   weights 400 / 500
--serif  Georgia, 'Times New Roman', serif                ONLY inside rendered web content
```
Scale (px / line-height / tracking):
```
display     300 40 / 1.18  -.015em    page title
stat        300 30 / 1      0         big numbers ($0.42, 171, 3)
page-h1     400 24 / 1.25  -.01em     serif, inside mocked web pages
card-title  400 13 / 1      .08em     screen label
body        400 12.5 / 1.45 0         default copy
body-sm     400 12 / 1.4    0         dense rows
pill        400 11 / 1      0         sans pill label
pill-mono   400 10.5 / 1    0         mono pill / chrome label
mono-body   400 10.5 / 1.5-1.7 0      machine facts, terminal
micro-caps  500 9 / 1       .2em      UPPERCASE section label
chrome-caps 400 11 / 1      .14em     UPPERCASE window title
wordmark    300 22 / 1      .34em     UPPERCASE "wigolo studio"
```
**Mono is for machine facts** — ids, paths, counts, costs, timestamps, code, selectors,
keyboard hints. **Sans is for human language.** Never mix within one phrase.

Copy: sentence case everywhere except micro-caps labels. No emoji. No exclamation marks.
Numbers are concrete (`$0.18`, `7/12`, `2.1s`), never "some" or "a few".

### Radii
```
18  window / large framed screen
14  large card, popover
12  standard card, terminal block
10-11  inner box, small card
8   icon button, input, small chip container
6   segment in a lane/bar
999 pill
```

### Spacing
```
40  page gutter (horizontal)
88  gap between screen sections
16  grid gap between cards, card group gap
14  card padding
13  dashed-card padding
10  default vertical stack gap
9   tight stack gap
7-8 chip/pill row gap (use 5-7 for dense rows)
```
Rhythm rule: **cards are 14 padding / 10 gap; grids are 16 gap.** Do not improvise.

### Elevation
```
window     0 24px 80px rgba(0,0,0,.9)
dark popover  0 22px 50px rgba(0,0,0,.85)
light popover (over rendered page) 0 18px 44px rgba(0,0,0,.22)
```
No other shadows. No glows.

### Textures
```
page-hatch  repeating-linear-gradient(135deg,
              rgba(255,255,255,.035) 0 9px, rgba(255,255,255,0) 9px 18px)
```
Used to indicate *mocked live web content* inside a dark frame. Never as decoration.

Radial wash for a hero/empty state, at most once per screen:
`radial-gradient(120% 90% at 50% -10%, rgba(255,255,255,.09) 0%, rgba(255,255,255,0) 58%)`

---

## 4. Components (hi-fi) — the full inventory

Build from these. Each is inline-styled; there is no CSS class layer.

**`window`** — `1px --hair`, radius 18, `overflow:hidden`, background `#000`, window
shadow. Children: `titlebar` → optional `tabstrip` → optional `urlbar` → body.

**`titlebar`** — three 9px hollow circles (`1px rgba(255,255,255,.28)`), then a
`chrome-caps` title, then right-aligned pill cluster. Padding `12px 16px`, bottom
`1px --hair-soft`.

**`tabstrip`** — tab = `1px` border, radius 8, padding `6px 11px`, 5px identity dot, label
`400 11 sans`. Active: border `.3` + background `rgba(255,255,255,.05)`. Inactive: border
`.1`, text `.55-.6`.

**`tab-group`** — the strip is grouped by owning run, and each group is labelled with that run's
short id: a `pill-mono` chip, `1px` hairline, radius 999, padding `2px 6px`, `white-space:nowrap`,
at the head of its group. The id is the same string REST, the event stream, the replay and the
audit log carry — one shared address space, so it renders verbatim: no truncation, no case change,
no accent. The focused run's chip takes the primary text role; the others stay at the mono-muted
one. The chip never shrinks — a crowded strip eats tab titles first. The human's own tabs are one
group by absence and carry **no** chip: there is no run to name.

**`urlbar`** — pill input `1px rgba(255,255,255,.14)`, radius 999, padding `7px 15px`,
`pill-mono` text at `.62`, background `rgba(255,255,255,.03)`. Nav glyphs are 24-28px
`icon-button`s. Right side: mono chips, then at most one white action.

**`icon-button`** — 28px square, radius 8, `1px .14` (`.55` when active), glyph `11 mono`.

**`pill` (4 variants only)**
- `action-primary` — white fill, `#000` text, `500 11 sans`, padding `6px 14px`.
  **Reserved for control transfer and consent**: Take control, Allow, Resolve, Send,
  Import, Write the change, Publish, Continue in studio.
- `action` — `1px .2`, text `.85`, padding `6px 13px`.
- `attention` — `1px --attention`, text `--attention-text`. Only for the risky/blocking path.
- `meta` — `1px .14`, `pill-mono` at `.5`, padding `5px 11px`. Machine facts and toggles.

Every pill has `white-space:nowrap`. Pill rows always `flex-wrap:wrap` with `gap:5-7px`.
Never let a pill shrink.

**`card`** — `1px --hair`, radius 12, padding 14, `flex column gap:10`. Accent border only
when the card *is* the agent's or the attention state.

**`dashed-card`** — same but `1px dashed --hair-dash`, radius 12, padding 13. Use for
secondary/explanatory content, never for primary actions.

**`micro-label`** — `micro-caps` at `.36`. One per card maximum.

**`stat`** — `stat` type in `#fff` + a `body-sm` `.45` caption beside it, right-aligned meta.

**`identity-ring`** — 16px hollow circle, `1px` in the agent hue. This is how an agent is
identified. **Never a vendor logo.**

**`identity-dot`** — 5px filled circle in the agent hue, for dense rows and tabs.

**`mark`** — min-width 17px, height 17px, padding `0 4px`, radius 5, `1px --agent`,
background `#000`, label `500 9.5 mono` in `--agent-text`. Positioned `-9px/-9px` from its
target's top-left. Attention variant swaps to the attention hue.

**`highlight`** (element the agent is acting on) — `1px --agent` + `--agent-tint`, radius 10.

**`ghost-cursor`** — CSS triangle in `--agent` rotated `-18deg`, plus a solid `--agent`
label chip with `#000` text at `500 9.5 mono`.

**`lane`** — height 36 (16 for compact), 3px gaps, segments radius 6, `1px` edge + tint by
role, label `10.5 mono`, `white-space:nowrap`, `overflow:hidden`. Roles: agent (blue), human
(amber), studio (white `.45`/`.1`), inert (`.1` border, transparent). **Sizing law:** every
segment label must fit — shorten the label (`7fq2`, not `7fq2 $0.18`) rather than growing
the flex ratio.

**`progress`** — 4px track `rgba(255,255,255,.12)` radius 2, fill `--agent`. Bar-chart
variant: 2px-gap columns, filled `--agent`, remainder `rgba(255,255,255,.14)`.

**`terminal`** — `1px .14`, radius 12, padding `13px 14px`, background `--surface-term`,
`400 10.5/1.7 mono` at `.78`. Line roles: default `.78`, dim `.34`, agent-result
`--agent-text`, human/approval `--attention-text`. Always include the footer convention:
`— run 7fq2 · driver you · tab 1 —`, then queued messages / page-changed / cost / watch link.

**`page-mock`** — hatched region for live web content. Placeholder blocks are
`1px --hair-faint`, radius 9, centred `micro` label at `.24` uppercase `.14em`.

**`rendered-page`** — when a screen must show real web content, switch to `#fff`, serif
headings, `rgba(0,0,0,.1)` text lines, and light-popover shadows. Selection artefacts get
`#cfe0f7` highlights. This is the only place light styling is allowed.

**`side-rail`** — width 300-330, `1px --hair-soft` left border, `--surface-panel`,
padding `20px 18px`, `flex column gap:16`. Bottom cluster uses `margin-top:auto`.

**`composer`** — `1px .14`, radius 11, padding `11px 12px`, `rgba(255,255,255,.02)`,
placeholder `body` at `.3`, then a wrapping row of meta pills that state the delivery
promise ("delivered instantly" vs "delivers on next browser call").

**`menu-bar item`** — the one surface the OS draws, not us: the tray/menu-bar entry that exists
so a run nobody is watching is still discoverable. Glyph is `identity-ring` as a **monochrome
template image**, tinted by the OS, so one asset serves both registers. Text to its right is the
live run count and nothing else. Its menu is: a disabled count line ("2 runs, 1 needs you"), a
separator, then one checkbox row per run — `id · task`, ticked while the run is being watched,
clicking toggles promote/demote. No colour is available here, so "needs you" is said in words
(`— needs you`) rather than in amber, and the dock badge carries the attention instead. Truncate
the task; the label-fitting law applies to a menu the same as to a lane.

**`annotation-footer`** — after a screen: a wrapping row, `gap:26`, of
`mono` `.34` lines each starting `→ `. Two maximum. This is where design rationale lives.

---

## 5. Layout

- Section max-width **1480px**, gutter **40px**, `padding-bottom: 88px`.
- Screen header: `micro-caps` number + `card-title` title, `margin-bottom:18`.
- Card grids: `display:grid` with `1fr` tracks and `gap:16`, `align-items:start`.
  Common: `1fr 1fr`, `1fr 1fr 1fr`, `1.15fr 1fr`, `1.2fr 1fr`.
- **Always `min-width:0` on grid/flex children that contain text.**
- Use flex/grid + `gap` for every group. Never margins between siblings, never inline
  whitespace as spacing.
- Two-column app layout: content `flex:1` + `side-rail` fixed width.
- Long labels: either `white-space:nowrap` on an unshrinkable chip, or let the row wrap.
  Never allow `overflow:hidden` to clip a real label.

---

## 6. Interaction & state vocabulary

| State | How it reads |
|---|---|
| agent driving | blue identity + "X has the wheel" pill + ghost cursor |
| about to act | highlight + a telegraph beat ("about to click · 0.9s") |
| needs you | amber border + amber pill, anchored to the element, with auto-deny timer |
| blocked | amber, pinned at the exact element, with a "Do it for me" escape |
| queued (pull driver) | meta pill "queued" + "Deliver now →" escalation after 30s |
| human turn | amber lane segment; agent gets `interrupted: human took control` |
| uncertain | confidence number + question anchored to the candidate elements |
| headless | no chrome, a `▷` glyph, and a "Promote to visible" action |

Keyboard layer (state it in UI, don't hide it): `⌥` marks · drag lasso · `⌘⏎` command
selection · `@` mention · `⌘⇧D` take control · hold `⌥` drive one action · `⌥⇧V` voice ·
`⌘K` command bar · `⌘S` sidebar · `Esc` exit direct mode.

---

## 7. Tokens — wireframe register (only for the wireframe doc)

```
paper #f0eee9 · card #fff · ink #1a1a1a · line #b9b4aa · fill #e2dfd8 / #cdc9c0
blue #2a78d6 (agent) · blue-ink #1d4e8f · blue-tint #e7f0fb
orange #c96a1f (needs you) · orange-ink #a85414 · orange-tint #fbeee2
type IBM Plex Mono 400/500/600 at 9-12px · notes Caveat 600 14px in blue/orange
borders 1.5px · radii 5-8 · hatch 135deg #fbfaf7/#f3f1ec at 7px
```
Structure: `.dv-turn` section per turn (newest first) → `.dv-sub` group label →
`.dv-opts` row → `.dv-opt` with a stable `{turn}{letter}` id badge → `.dv-card`.
Reuse the existing classes (`.win .tl .tabs .url .body .view .rail .box .dash .ph .btn
.chip .row .col .note .hd .sm .mk .bar .seg .grid2 .grid3 .step .tick .kbd .lasso .pin`).
Never introduce a new class without adding it to the `<helmet>` block.

---

## 8. Adding a new feature — checklist

1. **Which existing surface owns it?** Toolbar has exactly four AI affordances (mic, `≡`
   read, `◗` listen, panel). Everything else lives behind `⌘K`, a selection, a keyboard
   gesture, or an existing screen. Adding resident chrome requires removing some.
2. **Is it a verb?** If a human can do it to a selection, register it in the shared verb
   registry so agents can call it too — and vice versa. One registry, two callers.
3. **Does it produce a run?** Anything that touches the web must create a run so it appears
   in fleet, records a replay, and obeys guardrails.
4. **What does the terminal see?** If a pull driver is involved, define the tool-result text
   and footer additions.
5. **Delivery + driver:** does it change who is driving, or queue behind someone?
6. **Trust surface:** does it need a guardrail entry, a fence, a redaction, an approval, or
   a site-profile record?
7. **Cost:** state the token/currency cost where the user can see it.
8. **Build with §4 components only.** No new colors, radii, shadows, or font sizes.
9. **Wireframe first** (new `.dv-opt` in the newest turn), then hi-fi.
10. **Check the label-fitting law** — lanes, segments and pills must not clip.

---

## 9. Hard nos

- New accent colors, or amber used for anything but "needs you".
- Vendor logos as agent identity.
- Emoji, gradients-as-decoration, drop shadows beyond §3, rounded-card-with-left-border.
- A second omnibox; an injected per-site "Ask X" bubble; a content feed.
- Two active drivers; mixing the user's tabs with an agent's tabs.
- Implying instant delivery on a pull transport.
- A centred system modal for an approval.
- Inventing a font size or spacing value not in §3.
- Green/red status colors.
- Hiding cost, token use, or what left the machine.

---

## 10. Paste into your repo's `CLAUDE.md`

```md
## Design system — read before writing UI
`DESIGN_SYSTEM.md` at the repo root is authoritative. Before writing or changing any UI:
1. Use only its tokens (§3) and components (§4). Never invent a color, radius, shadow,
   font size or spacing value.
2. Obey the product laws (§1): run-centric, one driver at a time, one run per tab,
   capabilities-not-brands, pull transports queue, marks as shared address space,
   element-anchored approvals, terminal-as-UI, local and inspectable.
3. White-filled buttons are reserved for control transfer and consent. Amber is reserved
   for "needs you". Agents are identified by a colored ring, never a logo.
4. Mono for machine facts, sans for human language, serif only inside rendered web content.
5. Both themes come from one token layer (§11). Never hard-code `rgba(255,255,255,…)` or
   `#000` in a component; resolve against tokens so light and dark share the component.
6. Run the §8 checklist for any new feature, and honour the §9 hard nos.
7. If something genuinely new is needed, add it to `DESIGN_SYSTEM.md` in the same commit.
Reference implementations: `Wigolo Studio UI.dc.html` (14 screens),
`Wigolo Studio Wireframes.dc.html` (48 frames).
```


---

## 11. Light register

Same system, re-anchored. **Geometry, type, spacing, radii, components and product laws are
identical** — only the ground and the accent lightness change. Never fork a component for a
theme; swap tokens.

Reference: `Wigolo Studio UI - Light.dc.html`, `Wigolo Design System - Light.dc.html`.

### Surfaces
```
--bg              #f6f5f2     page ground (warm, never pure white)
--surface-window  #fff        window/card body
--surface-panel   #f4f3ef     side rails, panels
--surface-tile    #fff        cards inside a panel
--surface-mock    #eeece7     "as shipped" mock of a cluttered page
--surface-term    #16171b     terminal blocks — STAY DARK
--surface-page    #fff        rendered web content
```

### Lines & text — invert the alpha channel, do not reuse the numbers
```
hair       rgba(0,0,0,.14)     hair-soft  rgba(0,0,0,.10)
hair-faint rgba(0,0,0,.09)     hair-dash  rgba(0,0,0,.16)

text: .88 primary · .8 emphasis · .68 body · .6 secondary · .5 label
      .46 mono · .42 micro-caps · .38 hint · .3 placeholder
```
Ink is `rgba(0,0,0,α)` and `#141414` for the strongest text — never `#000`.

### Accents — same hues, lower lightness
```
--agent          oklch(0.5 0.13 250)     --agent-text   oklch(0.4 0.14 250)
--attention      oklch(0.58 0.15 52)     --attention-text oklch(0.45 0.15 48)
tints .06–.10 · edges .40–.50 (unchanged)
secondary agent hues: oklch(0.5 0.11 200) · oklch(0.5 0.13 300)
```

### Inversions to remember
- **action-primary pill** becomes `#141414` fill with `#fff` text. Still reserved for
  control transfer and consent.
- **ghost-cursor label**: agent-hue fill with `#fff` text.
- **mark**: white background, agent-hue border and label.
- **Terminals invert back:** dark `#16171b` ground, text `rgba(255,255,255,.82)`, dim
  `rgba(255,255,255,.42)`, agent lines `oklch(0.84 0.08 250)`, human/approval lines
  `oklch(0.84 0.09 60)`. This is deliberate — machine output keeps one appearance in both
  themes, and it gives the light UI a needed anchor.

### Elevation & texture
```
window        0 18px 46px rgba(0,0,0,.10)
dark popover  0 16px 38px rgba(0,0,0,.14)
page popover  0 14px 34px rgba(0,0,0,.16)
page-hatch    repeating-linear-gradient(135deg,
                rgba(0,0,0,.045) 0 9px, rgba(0,0,0,0) 9px 18px)
hero wash     radial-gradient(120% 90% at 50% -10%,
                rgba(0,0,0,.055) 0%, rgba(0,0,0,0) 58%)
```

### Implementation note
Express both registers as one token layer (CSS custom properties or a theme object) and
resolve components against it. A component that hard-codes `rgba(255,255,255,…)` or `#000`
is a bug in either theme.
