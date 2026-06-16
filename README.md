# mnemos-eyes

> _«Взгляд в себя — в свои мысли.»_ — the eyes of Mnemos, gazing into the well of memory.

**mnemos-eyes** is the graphical companion to [**mnemos**](../mnemos) — a long-term
memory engine for AI agents. Where `mnemos` is the well (storage, search, MCP,
provenance, traces), `mnemos-eyes` is the **eye that looks into it**: a beautiful,
calm, lore-driven interface to browse, search, and understand everything the
memory holds.

This repository is a **separate project** from `mnemos`. It consumes the
`mnemos` HTTP API (and, later, the local store directly via a native shell).

---

## Status

🟡 **Design phase** — no application code yet. We are recording decisions and
the design vision first. See [`docs/CHARTER.md`](docs/CHARTER.md) for the agreed
scope, stack, and roadmap.

---

## The metaphor

- **mnemos** = _Mnemosyne_, Greek titaness of memory, mother of the Muses.
- **eyes** = the gaze that recollects — _anamnesis_, the act of looking inward.
- The UI's central motif is an **eye / iris / well**: the search focus is the
  pupil; memories surface from depth; in idle the interface quietly "breathes".

---

## What it is (and is not)

| It **is** | It is **not** |
| --- | --- |
| A viewer & explorer for mnemos memory | A second backend / a fork of mnemos |
| Search (FTS + semantic), provenance, tags, clusters, A2A sessions, traces | An agent runtime or an LLM client |
| Web-first, with a planned native desktop + mobile shell | A rebuild of the old `ai-brain` prototype |
| Local-first, privacy-respecting | A cloud SaaS |

---

## Quick links

- 📜 [Project Charter](docs/CHARTER.md) — scope, decisions, stack, roadmap
- 🎨 [Design Brief](docs/design-brief.md) — lore, mood, visual direction
- 🗂️ [Decisions log](docs/decisions/) — ADR-style records

---

## Ecosystem

```text
mnemos        → the memory engine (storage, API, MCP, traces)   [../mnemos]
mnemos-eyes   → the GUI that looks into the memory  (this repo)
```
