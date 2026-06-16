# mnemos-eyes — Design Brief

> Seed for the design system. Full design tokens, components, and motion specs
> are owned by `@GCW: Senior Frontend Developer` (`docs/design-system.md`, TBD).
> This brief fixes the **creative direction** agreed with the user.

---

## 1. The core metaphor

**"Взгляд в себя — в свои мысли."** _(A gaze into oneself — into one's own thoughts.)_

`mnemos-eyes` is the **eye of Mnemosyne** looking into the **well of memory**:

- The **iris / pupil** is the focal element — the search focus.
- **Memories surface from depth** — items rise out of darkness, with subtle
  parallax / depth.
- In idle, the interface **quietly breathes / blinks** — alive, not noisy.

---

## 2. Mood

| Axis | Direction |
| --- | --- |
| Emotion | Calm, contemplative, deep, a little reverent. |
| Energy | Low ambient motion; the UI is _still water_ that ripples on interaction. |
| Density | Generous whitespace; one clear focus per view. |
| Voice | Quiet, precise, no hype. |

**Anti-goals:** dashboard-clutter, neon "AI" gradients, constant motion, GitHub-clone look.

---

## 3. Visual seeds (to be refined into tokens)

- **Theme:** "obsidian well" — deep dark base (nods to mnemos's Obsidian vault),
  optional light mode.
- **Accent / iris:** either **Mnemosyne gold/amber** or **deep well teal/cyan** —
  Frontend Developer to A/B and pick.
- **Depth:** layered surfaces, soft shadows, faint inner glow around the "pupil".
- **Typography:** a calm humanist sans for UI; a readable serif or mono for
  memory _content_ (the "scroll" feel).
- **Motion:** ≤ 1 ambient animation (breathing iris); interaction ripples;
  respect `prefers-reduced-motion`.

---

## 4. Signature moments (where the lore shows)

1. **Empty state / dashboard hero:** a deep, expressive eye / iris-well.
2. **Search:** typing focuses the pupil; results surface from depth.
3. **Memory detail:** content presented as a "scroll" / page from the well.
4. **Idle:** slow breathing / occasional blink.

---

## 5. Hard constraints

- **Accessibility:** WCAG 2.2 AA (contrast, focus, reduced-motion) — non-negotiable.
- **Performance:** motion must never cost interactivity; budget owned by Frontend Developer.
- **Non-distracting:** beauty serves comprehension; if an effect competes with
  reading memory, it loses.

---

## 6. Prior art to mine (not copy)

`../ai-brain/src/ai_brain/web/static/app.css` has a usable **dark/light
CSS-variable scaffold** and an IA map (14 views). Reuse the _idea_ of a token
system and the feature inventory; discard the GitHub-clone aesthetic.
