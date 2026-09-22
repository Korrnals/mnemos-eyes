# Cortex Workspace — harness & standards research

- Status: **RESEARCH — input for the archcom** (owner directive 2026-09-22: unified interface
  for working with ANY agent harness). Branch `docs/cortex-harness-research`; do not merge.
- Author: `@GCW: Researcher`. Companion to `docs/cortex-workspace-design.md` (Product
  Architect). Feeds the `[FF]` facts file and the proposed **Standards** section (§5).
- Method: 3 Bathys deep-research legs (SearXNG + headless-browser distillation) + direct
  verification of primary sources (official spec pages, vendor docs, Google blog).
  All links checked 2026-09-22. Confidence marks: **[V]** = primary source verified,
  **[M]** = multiple secondary sources, **[FF]** = needs facts-file follow-up.

## 1. Executive summary

1. **The owner's hint ("vscode team has a protocol for remote harnesses") resolves to
   Agent Client Protocol (ACP)** — but it is **Zed's** protocol, not VS Code's. ACP
   (launched 2025-08-27 by Zed Industries, co-developed with Google for Gemini CLI) is
   **alive, neutral-governed, and the de-facto open standard** for editor↔agent
   communication as of 09.2026: 46 listed agents, JetBrains+Zed+Qt Creator native IDE
   clients, official Rust/TS SDKs at 1.0, agent registry, v1 continuously stabilized
   through Sep 2026, v2 draft published 2026-07-20. **[V]**
2. **VS Code/Microsoft has NO first-party open harness protocol.** VS Code bets on MCP
   inside agent mode + a closed-ish Chat Extension API (participants, LM tools, BYOM
   providers); Remote Tunnels is a transport, not an agent protocol; ACP in VS Code is
   community extensions only (open request microsoft/vscode#265496). Notably, **GitHub
   Copilot CLI itself added ACP support (public preview, 2026-01-28)** — Microsoft's own
   agent speaks ACP even though VS Code does not. **[V]**
3. **Ecosystem events that hit our matrix**: Gemini CLI consumer tiers were cut
   2026-06-18, successor = Antigravity CLI (`agy`, closed source, ACP-listed) **[V]**;
   Amazon Q CLI still has NO ACP (open FR) **[V]**; Claude Code and Codex participate
   via adapters only **[V]**; the Chinese segment (Qwen Code, Kimi CLI, GLM Agent,
   MiniMax, Qoder, Codebuddy) broadly speaks ACP **[V/M]**.
4. **Recommendation — integration strategy "A+C hybrid"**: adopt **ACP v1 as the
   protocol spine** of Cortex's agent-facing bridge (native ACP where it exists,
   adapters where it doesn't, all normalized to an ACP-shaped internal contract);
   **reject** an own protocol (B). ACP alone does NOT cover the read-only aggregation
   leg (design Variant B) — transcript stores stay per-harness. Details in §4.

## 2. Standards

### 2.1 Agent Client Protocol (ACP) — the core candidate

**What it is**: an open JSON-RPC 2.0 protocol between a *client* (editor/IDE/app) and a
*coding agent*, "LSP for agents": sessions, streaming updates, tool-call/plan/diff
rendering, permission requests, fs/terminal callbacks. Client spawns the agent as a
subprocess. Complements MCP (tools) rather than competing with it. **[V]**
Spec: <https://agentclientprotocol.com/> · repo (Apache-2.0):
<https://github.com/agentclientprotocol/agent-client-protocol>

**Timeline** (all **[V]** via [updates page](https://agentclientprotocol.com/updates.md),
[zed.dev/acp](https://zed.dev/acp), [Ry Walker research](https://rywalker.com/research/zed-agent-client-protocol)):

| Date | Event |
| --- | --- |
| 2025-08-27 | Launch + JetBrains×Zed interoperability announcement |
| 2025-09-03 / 2025-10-06 | Gemini CLI, then Codex available in Zed over ACP |
| 2025-10-24 | `clientInfo`/`agentInfo` implementation-info at initialize |
| 2025-12 | JetBrains IDEs ship ACP ("bring your own agent") — <https://www.jetbrains.com/acp/> |
| 2026-01-28 | ACP Registry co-launched with JetBrains (entries reflected in updates 2026-03-09) |
| 2026-02-04 → 09-17 | Continuous v1 stabilizations: configOptions (Feb 4), session/list + registry + sessionInfoUpdate (Mar 9), session/resume (Apr 22), session/close (Apr 23), logout (May 21), additionalDirectories (Jun 1), messageId + usage_update + session/delete (Jun 5), $/cancel_request (Jun 29), boolean configOptions (Jul 6), elicitation (Jul 22), tool-call names (Sep 17) |
| 2026-02-18 | Governance: Sergey Ignatov (JetBrains) becomes Lead Maintainer; repo in neutral `agentclientprotocol` org (GOVERNANCE.md, MAINTAINERS.md) |
| 2026-04-22 | Transports WG formed (JetBrains + Block/Goose) for remote transports (WebSocket/HTTP) |
| 2026-04-29 | ACP is the headline feature of Zed 1.0 **[M]** |
| 2026-06-25 | Rust + TypeScript SDKs reach 1.0.0 (Kotlin/Java/Python SDKs also official) |
| 2026-07-20 | **ACP v2 published as DRAFT** (beyond-turn updates + idle signaling, patch-by-stable-ID, structured diffs + git_patch, extensible permissions, `_`-prefixed unknown-enum tolerance) — [announcement](https://agentclientprotocol.com/announcements/acp-v2-draft.md), [migration](https://agentclientprotocol.com/protocol/v2/migration.md) |

**Transport**: v1 = **newline-delimited UTF-8 JSON-RPC over stdio only** (client spawns
agent; agent may not write anything but ACP messages to stdout). Remote agents
(HTTP/WebSocket) = **work in progress**: Streamable-HTTP/WS is an open
[RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport.md); the
protocol is transport-agnostic in principle (any bidirectional channel keeping JSON-RPC
framing + lifecycle is legal). **[V]** [v1 transports](https://agentclientprotocol.com/protocol/v1/transports.md)

**Who speaks it** ([official agents page](https://agentclientprotocol.com/get-started/agents.md) — 46 agents; [clients page](https://agentclientprotocol.com/get-started/clients.md)):

| Category | Entries (selection) |
| --- | --- |
| Native agents | Gemini CLI (`--acp`), **GitHub Copilot CLI (public preview, 2026-01-28)**, Goose, Cline, OpenCode (`opencode acp`), OpenHands, **Cursor CLI** (`cursor-agent acp`), Qwen Code, Kimi CLI, Kiro CLI, Qoder CLI, Junie (JetBrains), Factory Droid, Augment, Docker cagent, Mistral Vibe, Blackbox AI, fast-agent, OpenClaw, Hermes, crow-cli, Google Antigravity / Grok Build / GLM Agent / MiniMax Code (per [zed.dev/acp](https://zed.dev/acp)) |
| Via adapter | **Claude Agent** → [zed-industries/claude-agent-acp](https://github.com/zed-industries/claude-agent-acp); **Codex CLI** → [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp); **Pi** → [svkozak/pi-acp](https://github.com/svkozak/pi-acp); Bub, AgentPool |
| Native clients | **Zed**, **JetBrains IDEs**, Qt Creator plugin |
| VS Code | Community extensions only: ACP Client (formulahendry), ACP Patchbay, ACP Pro (Open VSX — works in Cursor/Windsurf/Trae), Multicoder, Exo; native support = open issue [microsoft/vscode#265496](https://github.com/microsoft/vscode/issues/265496) **[V/M]** |
| Other clients | Neovim (CodeCompanion, avante, agentic.nvim), Emacs (agent-shell), Sublime, Obsidian, **mobile: Happy, Agmente, Ferngeist, Runmote, VACP**; messaging bridges (Telegram-ACP, OpenACP, …); frameworks (fast-agent, LangChain Deep Agents, LlamaIndex, Mastra, Pydantic AI via ACP Kit — incl. **WS/HTTP bridge connectors**) |
| Harnesses as ACP *clients* | **Goose** (`GOOSE_PROVIDER=claude-acp\|codex-acp\|pi-acp\|amp-acp` — drives other harnesses as providers), **OpenHands** (runs Claude Code/Codex/Gemini CLI as interchangeable ACP backends), Devin (bidirectional ACP), Omnigent — per [arXiv survey 2609.00006](https://arxiv.org/pdf/2609.00006) **[V/M]** |

**Verdict: alive and winning.** Neutral org (Zed + JetBrains maintainers + Block/Google/
GitHub participants), monthly stabilizations, two IDE vendors native, CN-segment adoption,
and — decisive for us — *harness-driving-harness* usage already exists in production
(Goose, OpenHands). Naming note: do not confuse with IBM's Agent Communication Protocol
(merged into Google A2A, archived 2025-08) **[M]**. Also note: an ACP agent literally
named **"Cortex Code"** already exists ([zed.dev/acp](https://zed.dev/acp)) — check
naming collision for our Workspace.

### 2.2 VS Code / Microsoft — what is actually open

| Surface | What it is | Open to 3rd-party harnesses? |
| --- | --- | --- |
| Agent Mode + MCP | VS Code's agent mode standardizes on **MCP** (tools), not on any client-agent protocol **[M]** ([Morph analysis](https://www.morphllm.com/agent-client-protocol)) | MCP servers: yes; harness protocol: no |
| Chat Extension API | Chat participants, `LanguageModelTool`, `vscode.lm.selectChatModels`; **BYOM** via Language Model Chat Provider API ([VS Code blog 2025-10-22](https://code.visualstudio.com/blogs/2025/10/22/byom-extensions-preview)) | Extensions run *inside* VS Code; no external/headless surface for a remote client |
| Remote Tunnels | `code tunnel` + `vscode.dev/tunnel/…`, GitHub/MSA auth — a **transport** for VS Code remote sessions; no agent semantics ([docs](https://code.visualstudio.com/docs/remote/tunnels)) **[V]** | No — transport only |
| Copilot CLI | GitHub's terminal agent; **ACP public preview since 2026-01-28** **[M]** (GitHub changelog via [Morph](https://www.morphllm.com/agent-client-protocol), [danilchenko](https://www.danilchenko.dev/posts/agent-client-protocol/)) | Yes — via ACP |

**Conclusion**: there is no Microsoft "remote harness protocol" to adopt. The owner's
hint most plausibly maps to (a) ACP itself (Copilot CLI speaks it), or (b) VS Code Remote
Tunnels — a transport pattern our W4 loopback ingress already plays. For Cortex, the
VS Code-relevant fact is different: **VS Code Copilot-chat sessions are a non-ACP store**
→ they belong to the per-harness adapter tier (§4).

### 2.3 Other unification candidates (brief)

| Candidate | Layer | State 09.2026 | Relevance for Cortex |
| --- | --- | --- | --- |
| **A2A** (Google → Linux Foundation 2025-06-23; v1.0 + TCK/SDKs; 150+ orgs) | agent↔agent | Mature **[V/M]** ([LF announcement](https://www.linuxfoundation.org/)) | Different layer (mesh of agents); Gemini CLI had an A2A module. Watch only |
| **AG-UI** (CopilotKit) | agent→frontend events | Active; ACP Kit ships AG-UI bridges **[M]** | Overlaps ACP `session/update`; no harness-store semantics |
| **Apple LanguageModel** (WWDC26, Xcode 27) | model abstraction in Swift | New **[M]** | Not harness-level; ignore. (No Zed "LMP" exists — checked, dead end) |
| **MCP** | agent↔tools | Known/adopted already | Out of scope per brief |
| Harness-native RPC/API surfaces | per-harness | Claude Agent SDK (Python/TS; `-p --output-format json`; sessions resume/fork, external persistence, Managed Agents REST — [docs](https://code.claude.com/docs/en/agent-sdk/overview) **[V]**); opencode HTTP server (full session CRUD/fork/revert/share — [docs](https://opencode.ai/docs/server) **[V]**); `codex exec` + `codex exec resume <id>` **[M]**; Goose remote server | These are the adapter targets for strategy C |
| **Prior art for "cockpit over many harnesses"** | apps | [Orca](https://www.onorca.dev/) (agent IDE, fleets, phone approvals, MIT) **[M]**; Vibe Kanban; **Happy** (mobile ACP client for Claude Code — proves the phone→session case); OmniRoute (ACP proxy); ACP Kit (WS/HTTP bridges) | Validates demand; borrow patterns, don't depend |

## 3. Harness landscape (facts for the `[FF]` matrix)

Legend: store = where the harness itself persists sessions; resume = native continuation;
headless = non-interactive/remote-drive surface; ACP = agent-side support.

| Harness | Form | License/OSS | Session store | Resume/fork | Headless / remote-drive | ACP |
| --- | --- | --- | --- | --- | --- | --- |
| **Claude Code** | CLI+IDE ext | Proprietary (npm-dist); MIT clean-room rewrites exist post "2026-03 source leak" **[M]** | `~/.claude/projects/<encoded-cwd>/*.jsonl` **[V]** | `--continue`, `--resume [id]`, `/resume`; SDK resume/fork **[V]** | Agent SDK (Py/TS), `-p --output-format json`, stream-json; Managed Agents REST **[V]** | adapter ([claude-agent-acp](https://github.com/zed-industries/claude-agent-acp)) **[V]** |
| **OpenAI Codex CLI** | CLI (Rust) | Apache-2.0 **[V]** | `~/.codex/sessions` rollouts (JSONL) **[M]** | `codex exec resume <session-id>` **[M]** | `codex exec` (sandbox flags, approval bypass) **[M]** | adapter ([codex-acp](https://github.com/agentclientprotocol/codex-acp)) **[V]** |
| **Gemini CLI** | CLI | Apache-2.0 (repo alive); consumer tiers cut 2026-06-18 → **Antigravity CLI `agy`** (closed, ACP-listed) **[V]** ([Google blog](https://developers.googleblog.com/), [antigravity.google](https://antigravity.google/)) | `~/.gemini` checkpoints + `/chat save` **[FF]** | `/chat save|resume` **[FF]** | `gemini -p`; `--acp` flag **[M]** | native **[V]** |
| **Qwen Code** (Alibaba) | CLI (Gemini fork) | Apache-2.0 | inherits Gemini shapes **[FF]** | inherits **[FF]** | `-p` **[FF]** | native **[V]** |
| **opencode** | CLI/TUI/web | MIT; v2 out **[V/M]** | internal storage; full API access | fork/revert/share via API **[V]** | **best-in-class HTTP server** (`opencode serve`: sessions CRUD, `prompt_async`, permissions, share) + `opencode run` + `opencode acp` **[V]** | native **[V]** |
| **Cursor** | IDE + CLI | Proprietary | cloud + local **[FF]** | session/load via ACP **[V]** | Cursor CLI (2026-01) + Cloud Handoff (`&` prefix) **[M]**; `cursor-agent acp` (stdio JSON-RPC; modes agent/plan/ask; `cursor_login`) **[V]** ([docs](https://cursor.com/docs/cli/acp)) | native **[V]** |
| **Windsurf** (Cognition) | IDE | Proprietary | cloud + local **[FF]** | IDE-level | **no first-class headless CLI**; 2.0 Agent Command Center (local+cloud kanban) **[M]** | no (ACP Pro ext can run inside it) |
| **Cline** | VS Code/JetBrains ext | open source | ext globalStorage **[FF]** | UI-level | Cline CLI 2.0 headless CI/CD mode **[M]** | native **[V]** |
| **Roo Code** | VS Code ext | open source (Cline fork) | ext storage **[FF]** | UI-level | limited | not listed 09.2026 **[V]** |
| **aider** | CLI | Apache-2.0 | `.aider.chat.history.md` etc. **[FF]** | `--restore-chat-history` **[FF]** | `--message/--yes` scripting | "in progress" **[M]** |
| **Amazon Q CLI** | CLI | Apache-2.0 (aws repo) | conversation persistence **[M]** | yes (context) **[M]** | `-y`/CLI | **no** — open FR [aws/q-command-line-dev#2703](https://github.com/aws/q-command-line-dev/issues/2703) **[V]**; AWS's **Kiro CLI** does have ACP |
| **Goose** (Block) | CLI+desktop | Apache-2.0; docs point to Agentic AI Foundation/LF governance **[M]** | `~/.config/goose/sessions` **[FF]** | `goose session fork/resume` (native); **not yet through ACP providers** (ACP id ≠ goose id) **[V]** | `goose run -t`; remote server guide; **is itself an ACP client** (`GOOSE_PROVIDER=claude-acp…`) **[V]** | native **[V]** |
| **OpenHands** | CLI/web/SDK | open source | event-stream logs **[FF]** | SDK sessions | headless mode; **ACPAgent + ACP client/host** (runs other harnesses as backends) **[V/M]** | native **[V]** |
| **Devin-class** (Cognition Devin, Factory Droid) | cloud agent + API | Proprietary | cloud sessions (REST) **[FF]** | API-level **[FF]** | REST API (playbooks/sessions) **[FF]** | Devin: registry-listed, bidirectional ACP **[M]**; Droid: native **[V]** |
| **Zed agent** | editor | open editor | Zed-local | agent panel | ACP host (external agents) | host (client side) **[V]** |
| **CN segment** (Kimi CLI, GLM Agent, MiniMax Code, Qoder CLI, Codebuddy, TRAE) | CLI/IDE | mixed | varies **[FF]** | varies | varies | **ACP-listed** (except TRAE: runs ACP Pro ext) **[V/M]** |
| Others worth one line: **Crush** (Charm; FSL-1.1-MIT **[M]**), **Amp**, **Grok Build**, **OpenClaw**, **Hermes** (ACP server+client), **Pi** (minimal harness; own JSONL RPC, `pi-acp` adapter), **Docker cagent**, **Mistral Vibe** (ACP 0.10.1, fork/rewind over ACP), **Warp 2.0** (AGPL), **Auggie** (Augment) | | | | | | mostly ACP-listed **[V/M]** |

**Table-level takeaway**: every harness we might relay to either speaks ACP natively,
has an adapter, or exposes a headless CLI/API — the "relay" leg (design Variant A) is
implementable everywhere; the *store-readability* leg (design Variant B) is the one that
stays per-harness.

## 4. Synthesis for Cortex — integration strategies

Naming guard: below, **Strategy A/B/C = protocol choice** (this section); the design
paper's **Variant A/B/C = architecture** (relay/aggregator/hybrid). They compose.

### Strategy A — adopt ACP as the adapter layer (Cortex = ACP client)

Cortex's host bridge speaks ACP v1 to the agent side: native ACP agents (Gemini-lineage,
Qwen, Goose, opencode, Cursor CLI, Copilot CLI preview, Kimi/Kiro/Qoder…), adapters for
the rest (claude-agent-acp, codex-acp, pi-acp).

**What it gives us**
- Standardized session lifecycle that maps 1:1 onto the design's relay: `session/new`,
  `session/load`, `session/list` (Mar 2026), **`session/resume` (Apr 2026)**,
  `session/close`, `session/delete` — continuation without forking the store.
- Streaming (`session/update`), permissions (`session/request_permission` — maps
  directly onto our Tier-B confirm gates), modes, elicitation, usage/cost updates.
- Thin clients are legal: the Cursor docs' own minimal example advertises
  `fs.readTextFile:false, writeTextFile:false` — Cortex-as-view is a conforming client.
- SDKs at 1.0 (TS/Rust) + registry metadata for agent discovery on executors.
- Future remote transport (Streamable HTTP/WS RFD) aligns with W4 loopback ingress.

**What it does NOT give us (gaps vs the invariant)**
1. **Store ownership stays with the harness — which is what we want** — but ACP gives
   no *transcript federation*: history depth via `session/list` is agent-dependent;
   the read-only aggregation leg (design Variant B) remains per-harness file/API reads.
2. **stdio only** today → a bridge process per host is mandatory anyway (this matches,
   not hurts, the extend-the-poller recommendation).
3. **Adapter-level resume is uneven**: goose's own docs say fork/resume are not yet
   exposed through ACP providers, and ACP-session-id ≠ native-id — keep the
   (harness, host, native-id) namespace and an id-mapping table. `[FF: claude-agent-acp
   + codex-acp resume coverage]`
4. **Attach-to-live-foreign-session is not a first-class ACP scenario** (client spawns
   agent); live tailing rides on resume + update stream — consistent with our
   "own/relayed sessions only" v1 scope.
5. **v2 churn**: draft since 2026-07-20; gate behind version negotiation.

### Strategy B — own protocol, inspired by ACP

Rejected. The whole value of the layer is ecosystem gravity (46 agents, 2.5 IDE vendors,
CN segment) — an own protocol re-creates the N×M glue ACP already removed, costs spec
maintenance, and buys nothing: Cortex's differentiators (multi-host aggregation, mnemos
linkage, task binding, ownership tiers, presence) live **above** the client↔agent
protocol layer. Our inner contract can simply *mirror ACP shapes* (see A+C).

### Strategy C — per-harness adapters only

Floor, not ceiling. Still required for non-ACP stores (VS Code Copilot-chat, Windsurf,
Amazon Q CLI, aider, zcode `[FF]`) — but without an ACP-shaped normalization target each
adapter invents its own session/update/permission model, which is exactly the drift the
invariant forbids at the UX level.

### Recommendation: **A+C hybrid — "ACP as the spine, adapters as limbs"**

- Normalize the bridge's agent-facing interface to **ACP v1 shapes** (methods, update
  kinds, permission requests); speak **native ACP** where it exists; translate tier-3
  harnesses **into** those shapes.
- Design Variant C (aggregator + relay) stands unchanged: ACP powers the relay leg;
  store-readers power the visibility leg; the two never share state custody.
- Re-examine at: v2 stabilization, Streamable-HTTP/WS transport RFD landing (could
  replace bespoke W4 relay framing), adapter resume coverage.

## 5. Patch proposals for `cortex-workspace-design.md` (new "Standards" section)

1. **Adopt ACP v1** as the bridge's agent-facing contract; pin TS or Rust SDK 1.0.x;
   negotiate `protocolVersion`; track v2 behind a flag ([announcement](https://agentclientprotocol.com/announcements/acp-v2-draft.md)).
2. **Method mapping**: `session/new|load|list|resume|close|delete` → relay verbs;
   `session/update` → SSE `session.*` kinds (additive-only rule holds); 
   `session/request_permission` → Tier-B typed-confirm flow; `authenticate` where the
   agent requires it (Cursor `cursor_login` precedent).
3. **Agent tiers on executors**: T1 native (Qwen/Gemini-lineage, Goose, opencode, Cursor
   CLI, Copilot CLI preview, Kimi/Kiro/Qoder); T2 adapter (Claude Code, Codex, Pi);
   T3 custom (VS Code Copilot chat, Windsurf, Amazon Q CLI, aider, **zcode `[FF]`**).
4. **Session identity**: keep `(harness, host, native-id)`; add `acp_session_id ↔
   native_id` mapping (precedent: goose limitation).
5. **Discovery**: use ACP Registry metadata for executor-side agent config; don't fork it.
6. **Transport**: today stdio inside the host bridge (poller-family systemd unit);
   W4 loopback ingress stays transport-only; revisit when the HTTP/WS RFD stabilizes.
7. **Variant B unaffected**: ACP ≠ transcript federation; per-shape store readers stay.
8. **Naming**: check collision with the existing ACP agent "Cortex Code".
9. **`[FF]` additions**: adapter resume coverage (claude-agent-acp, codex-acp);
   zcode ACP-feasibility (or zcode→T3 adapter via its headless precedent);
   vscode/pi store readability; gemini-checkpoint/qwen store paths.
10. **Prior art to borrow**: Happy (mobile ACP client), Orca (phone approvals over
    agent fleets), goose ACP-providers (harness-drives-harness), ACP Kit (WS/HTTP bridges).

## 6. Sources (primary first)

- ACP: [site](https://agentclientprotocol.com/) · [updates](https://agentclientprotocol.com/updates.md) ·
  [agents](https://agentclientprotocol.com/get-started/agents.md) · [clients](https://agentclientprotocol.com/get-started/clients.md) ·
  [v2 announcement](https://agentclientprotocol.com/announcements/acp-v2-draft.md) ·
  [v1 transports](https://agentclientprotocol.com/protocol/v1/transports.md) ·
  [HTTP/WS RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport.md) ·
  [repo](https://github.com/agentclientprotocol/agent-client-protocol) ·
  [zed.dev/acp](https://zed.dev/acp) · [jetbrains.com/acp](https://www.jetbrains.com/acp/)
- Adapters: [claude-agent-acp](https://github.com/zed-industries/claude-agent-acp) ·
  [codex-acp](https://github.com/agentclientprotocol/codex-acp) · [pi-acp](https://github.com/svkozak/pi-acp)
- Vendor docs: [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) ·
  [opencode server](https://opencode.ai/docs/server) · [Cursor ACP](https://cursor.com/docs/cli/acp) ·
  [VS Code Remote Tunnels](https://code.visualstudio.com/docs/remote/tunnels) ·
  [VS Code BYOM](https://code.visualstudio.com/blogs/2025/10/22/byom-extensions-preview) ·
  [goose ACP providers](https://goose-docs.ai/docs/guides/acp-providers/)
- Events: [Gemini CLI → Antigravity (Google blog)](https://developers.googleblog.com/) ·
  [A2A → Linux Foundation](https://www.linuxfoundation.org/) ·
  [Amazon Q CLI ACP FR](https://github.com/aws/q-command-line-dev/issues/2703) ·
  [VS Code ACP issue](https://github.com/microsoft/vscode/issues/265496)
- Analysis (secondary): [arXiv 2609.00006](https://arxiv.org/pdf/2609.00006) ·
  [Morph: ACP explained](https://www.morphllm.com/agent-client-protocol) ·
  [Marc Nuri](https://blog.marcnuri.com/agent-client-protocol-acp-introduction) ·
  [Ry Walker](https://rywalker.com/research/zed-agent-client-protocol) ·
  [danilchenko.dev](https://www.danilchenko.dev/posts/agent-client-protocol/) ·
  [cleverhack landscape](https://cleverhack.com/ai-coding-landscape) ·
  [Orca](https://www.onorca.dev/)
