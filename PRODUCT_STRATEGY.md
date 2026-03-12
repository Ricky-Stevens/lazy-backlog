# Lazy Backlog — Product Strategy & Roadmap

## Executive Summary

Lazy Backlog occupies a unique position in the 2026 AI-assisted project management landscape: it's the **only MCP server that combines local knowledge indexing, team convention learning, and context-grounded ticket generation**. This document dissects the product's features, identifies target personas, maps the competitive landscape, and proposes a prioritized roadmap to lock in defensible advantages.

---

## 1. Feature Audit (Current State — v0.3.0)

| Tool | Actions | Intelligence Level |
|------|---------|-------------------|
| **configure** | setup, discover-jira, learn-team | Team convention mining from historical tickets |
| **confluence** | spider, search, get-page, list-spaces, stats, stale-docs, what-changed | Local FTS5 indexing, page classification, section-level search |
| **issues** | get, create, bulk-create, update, search, epic-progress, decompose | Context-grounded generation, team rules injection, preview+confirm flow |
| **bugs** | find-bugs, search, assess, triage | Completeness scoring (0-100%), severity inference, auto-commenting |
| **backlog** | list, search, rank | Board-scoped queries, JQL enforcement, drag-and-drop ranking |
| **sprints** | list, get, create, move-issues, velocity, health, retro, goal | Linear regression velocity trending, cycle time percentiles, capacity planning |

### What's Working Well
- **Context-grounded generation**: Confluence context is automatically retrieved and injected into ticket previews — tickets reference real ADRs, designs, and specs
- **Human-in-the-loop**: Preview → confirm flow prevents accidental mutations
- **Team rules flywheel**: learn-team → extract patterns → inject into future tickets → tickets get better over time
- **Sprint intelligence**: Velocity trending with linear regression, P50/P75/P90 cycle times, capacity per assignee
- **Local-first privacy**: All indexing in SQLite, no data leaves the machine beyond Atlassian API calls

---

## 2. Target Personas

### Persona 1: "The Overwhelmed Engineering Lead" (PRIMARY)
- **Role**: Tech Lead / EM, team of 5-15 engineers
- **Pain**: 30-40% of time on ticket admin — writing tickets, grooming, planning, retros
- **Behavior**: Uses Claude Code/Desktop daily, deep Confluence knowledge, hates PM ceremony
- **Value prop**: *"Write tickets as good as you would, in 10% of the time, grounded in your actual docs"*
- **Activation**: `learn-team` → sees conventions reflected in generated tickets → "this actually sounds like us"

### Persona 2: "The Solo Product Manager" (SECONDARY)
- **Role**: PM at a startup or small team, owns Jira + Confluence
- **Pain**: Context-switching between doc research and ticket creation; tickets lack technical depth
- **Behavior**: Reads ADRs and specs, manually translates to work items
- **Value prop**: *"Your docs become your tickets — context-aware generation that sounds like your team"*
- **Activation**: `spider` → `search` → sees Confluence context in ticket previews → "it already found the design doc"

### Persona 3: "The Scrum Master / Delivery Lead" (EMERGING)
- **Role**: Scrum Master, Agile Coach, Delivery Manager
- **Pain**: Sprint ceremonies are time-consuming, retros lack data, velocity reporting is manual
- **Behavior**: Runs planning, standups, retros — wants data-driven facilitation
- **Value prop**: *"Data-driven ceremonies — velocity trends, health scoring, AI-generated retro insights in 60 seconds"*
- **Activation**: `velocity` → `health` → `retro` — sees actionable insights without spreadsheet wrangling

### Persona 4: "The Developer Who Hates Jira" (LATENT)
- **Role**: IC developer, avoids Jira's UI at all costs
- **Pain**: Context-switching from IDE to browser; Jira's UI is hostile
- **Behavior**: Wants to stay in terminal/IDE, never open a browser tab for Jira
- **Value prop**: *"Never leave your editor — create, update, search tickets from your AI assistant"*
- **Activation**: Uses Claude Code → discovers they can create tickets mid-conversation → never opens Jira again

---

## 3. Competitive Landscape

| Competitor | Type | Strengths | Weaknesses vs Lazy Backlog |
|------------|------|-----------|---------------------------|
| **Atlassian Rovo MCP** | Official, cloud-hosted | Managed, OAuth 2.1, first-party trust | CRUD-only, no intelligence layer, no local indexing, cloud-only (privacy concern) |
| **sooperset/mcp-atlassian** | OSS, self-hosted | Cloud + Server/DC support, mature CRUD | No analytics, no context-grounded generation, no team learning |
| **CData MCP for Jira** | Commercial | Multi-system connectivity | Generic connector, no Jira-specific intelligence |
| **Figflow** | SaaS | Figma→stories (design-driven) | Limited to design context, not docs/code, pay-per-use |
| **StoriesOnBoard** | SaaS ($11+/mo) | Story mapping, roadmaps | No MCP integration, no local indexing, separate SaaS |
| **ClickUp AI** | Platform | All-in-one PM | Requires platform migration, not Jira-compatible |
| **Zenhub** | SaaS | GitHub-native, good reporting | GitHub-only, no Confluence integration |
| **Parabol** | SaaS | Retro facilitation, meeting AI | Single-purpose, no ticket generation |

### Key Insight
The market splits into two camps:
1. **CRUD connectors** (Atlassian MCP, sooperset, CData) — move data but add no intelligence
2. **Context-unaware generators** (Figflow, StoriesOnBoard) — generate tickets but without YOUR docs/conventions

**Lazy Backlog is the only tool that bridges both**: it connects to Jira/Confluence AND adds an intelligence layer (local RAG, team rules, analytics). This is the moat.

---

## 4. Unique Selling Propositions (USPs)

### USP 1: Context-Grounded Generation (STRONGEST MOAT)
**What**: Every ticket is generated with relevant Confluence context — ADRs, designs, specs, runbooks — automatically retrieved via FTS5 search and injected into the preview.

**Why it matters**: Generic AI ticket generators produce generic tickets. Lazy Backlog produces tickets that reference *your actual architecture decisions and design documents*.

**How to lock it in**:
- Expand beyond Confluence: index GitHub wikis, Notion pages, Google Docs, Slack threads
- Add source attribution: "This ticket references ADR-042 (last updated 3 days ago)"
- Surface freshness warnings: "The referenced design doc hasn't been updated in 90 days"

### USP 2: Team Convention Learning (UNIQUE — NO COMPETITOR HAS THIS)
**What**: `learn-team` mines completed tickets to extract naming patterns, label conventions, story point distributions, component usage, and sprint composition patterns. These become rules injected into future ticket generation.

**Why it matters**: It's not just AI-generated tickets — it's tickets that *sound like your team wrote them*. This is the "uncanny valley" breaker for AI adoption.

**How to lock it in**:
- Make rules visible: show a "Team Conventions" summary users can review and edit
- Add confidence indicators: "Naming convention detected with 92% confidence from 47 tickets"
- Support per-issue-type rules: "Bugs always include environment; Stories always include AC"
- Track rule drift: "Your team stopped using the `backend` label 3 sprints ago"

### USP 3: Local-First Privacy
**What**: All indexing happens in local SQLite. No data leaves the machine beyond standard Atlassian API calls.

**Why it matters**: Enterprise security teams block cloud-hosted AI tools. Atlassian's Rovo MCP proxies data through their infrastructure. Lazy Backlog keeps everything local.

**How to lock it in**:
- Market explicitly: "Your docs never leave your machine"
- Add data sovereignty documentation
- Consider SOC 2 alignment documentation (even for OSS, this signals trust)

### USP 4: MCP-Native Intelligence Layer
**What**: Not just a CRUD connector — it adds analytics, learning, and generation on top of standard Jira/Confluence operations.

**Why it matters**: Works with Claude Code, Claude Desktop, Cursor, Windsurf, and any future MCP client. Not locked to one AI vendor.

**How to lock it in**:
- Position as "the intelligence layer for Atlassian in the MCP ecosystem"
- Ensure compatibility with every major MCP client as they emerge
- Build MCP-specific features (resource endpoints, prompt templates) that leverage the protocol's full capabilities

---

## 5. Recommended Improvements

### Quick Tweaks (Low effort, high impact)

**A. Duplicate Detection in Create Flow**
Before creating any ticket, automatically search the backlog for semantic duplicates. Surface "This looks similar to BP-234: [summary]" in the preview. Prevents the #1 backlog hygiene problem.

**B. Guided Onboarding Wizard**
Merge `setup` + `discover-jira` into a single guided flow that auto-discovers boards, spaces, and schema. Reduce time-to-first-ticket from ~5 minutes to ~90 seconds.

**C. Structured Preview Cards**
Current previews are text-heavy walls. Structure as scannable cards: Summary | Type | Points | Labels on one line, Description below, Confluence References as a collapsible section.

**D. Update Diff View**
When updating an existing ticket, show what changed (old → new) in the preview. Makes the confirm step meaningful for updates, not just creates.

**E. Decompose → Bulk-Create Pipeline**
Wire `decompose` output directly into `bulk-create` input. Currently these are separate actions that require manual bridging. Make "decompose this epic into tickets and create them all" a single conversation flow.

---

## 6. New Feature Proposals (Prioritized)

### Tier 1 — Lock-in Moves (Do Now)

#### 1.1 Smart Decomposition Engine
**Persona**: Engineering Lead, Product Manager
**What**: Given an epic description or PRD, automatically decompose into a tree of stories + tasks + sub-tasks, each with:
- Context from relevant Confluence docs
- Team convention-compliant naming, labels, and sizing
- Acceptance criteria generated from spec documents
- Parent-child relationships pre-wired

**Why**: This is the killer workflow. PRD → Epic → Stories → Tasks in one conversation. No competitor does context-grounded decomposition.

#### 1.2 Duplicate & Overlap Detection
**Persona**: All personas
**What**: Before any ticket creation, run FTS5 search + keyword extraction against the existing backlog. Surface matches with similarity confidence.
**Why**: 20-30% of backlog items are duplicates in most orgs. Preventing this at creation time is 10x more valuable than detecting it later.

#### 1.3 Team Rules Dashboard
**Persona**: Engineering Lead, Scrum Master
**What**: Make learned conventions visible, reviewable, and editable. Show confidence scores, sample sizes, and trend data. Let users approve/reject/modify rules.
**Why**: Black-box AI adoption stalls. Transparency builds trust. This is also highly demo-able for adoption.

### Tier 2 — Differentiation Moves (Next Quarter)

#### 2.1 Sprint Planning Assistant
**Persona**: Engineering Lead, Scrum Master
**What**: "Plan my next sprint" — analyze velocity trend, team capacity (PTO-aware), backlog priority ranking, and dependency chains → recommend optimal sprint contents with justification.
**Why**: The data already exists (velocity, capacity, backlog ranking). This just needs orchestration into a recommendation engine.

#### 2.2 Acceptance Criteria Generator
**Persona**: Product Manager, Developer
**What**: Given a ticket summary and context, generate structured AC using Confluence specs as source material. Apply team conventions (e.g., "always include performance criteria for API endpoints").
**Why**: The #1 complaint about developer-written tickets is missing/weak AC. This closes that gap.

#### 2.3 Sprint Changelog Digest
**Persona**: Scrum Master, Engineering Lead
**What**: Auto-generate a stakeholder-friendly sprint summary: what shipped, who did what, what carried over, what was descoped. Cross-reference with Confluence updates during the sprint.
**Why**: Every team wastes 30-60 min per sprint on status updates. This replaces that entirely.

### Tier 3 — Moat Builders (Medium-term)

#### 3.1 Multi-Source Knowledge Indexing
**Persona**: All personas
**What**: Expand beyond Confluence to index GitHub wikis, Notion, Google Docs, Slack threads (via MCP composability).
**Why**: Not every team uses Confluence. Multi-source indexing makes the product viable for 3x more teams.

#### 3.2 Codebase Context Integration
**Persona**: Engineering Lead, Developer
**What**: When creating technical tickets, reference actual code files, functions, and modules. "Refactor the auth middleware" → ticket links to `src/middleware/auth.ts`, references ADR-15.
**Why**: This is where MCP shines — the AI assistant already has code context via other MCP servers or file access. Bridge it into ticket generation.

#### 3.3 Dependency Mapping & Critical Path
**Persona**: Engineering Lead, Scrum Master
**What**: Surface blocked-by/blocks relationships. Warn when sprint planning creates dependency conflicts. Show critical path for epics.
**Why**: Dependency hell is the #1 cause of sprint failure. Making it visible at planning time prevents it.

#### 3.4 Workload Balancing Recommendations
**Persona**: Engineering Lead, Scrum Master
**What**: Analyze per-assignee load across sprints. Surface overloaded team members. Recommend reassignments based on individual velocity history.
**Why**: The capacity report already calculates per-assignee stats — extending to recommendations is a natural evolution.

---

## 7. Positioning & Go-to-Market

### Tagline
> **"Your docs write your tickets."**

### Positioning Statement
Lazy Backlog is the intelligence layer between your documentation and your Jira board. It learns how your team writes tickets, grounds every ticket in your actual docs, and turns sprint ceremonies from time sinks into one-minute conversations.

### Differentiation Matrix

```
                    Local Indexing    Team Learning    Analytics    Context-Grounded
Lazy Backlog        ✅               ✅               ✅           ✅
Atlassian Rovo      ❌ (cloud)       ❌               ❌           ❌
sooperset           ❌               ❌               ❌           ❌
Figflow             ❌               ❌               ❌           ⚠️ (design only)
StoriesOnBoard      ❌               ❌               ❌           ❌
```

### Adoption Wedge Strategy
1. **Enter via Developer persona** (lowest friction — `npx -y lazy-backlog`, done)
2. **Expand to Engineering Lead** (they see the developer using it → try team rules + analytics)
3. **Land Scrum Master** (velocity + retro features pull them in during ceremonies)
4. **Capture PM** (context-grounded generation replaces their manual workflow)

---

## 8. Metrics to Track

| Metric | What it measures | Target |
|--------|-----------------|--------|
| Time-to-first-ticket | Onboarding friction | < 3 minutes |
| Tickets created per session | Engagement depth | > 3 |
| Preview→Confirm rate | Trust in generation quality | > 80% |
| Team rules adoption | Stickiness / lock-in | > 50% of active users run learn-team |
| Duplicate detection saves | Tangible value delivery | Track "similar ticket found" events |
| Sprint ceremony time reduction | Core value prop | Self-reported, target 50% reduction |

---

*Generated 2026-03-12 — Lazy Backlog Product Strategy v1*
