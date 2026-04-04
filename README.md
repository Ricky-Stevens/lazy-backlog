# Lazy Backlog

**AI-powered Jira intelligence. Not just CRUD — deep insight.**

[![npm version](https://img.shields.io/npm/v/lazy-backlog.svg)](https://www.npmjs.com/package/lazy-backlog)
[![CI](https://github.com/Ricky-Stevens/lazy-backlog/actions/workflows/ci.yml/badge.svg)](https://github.com/Ricky-Stevens/lazy-backlog/actions/workflows/ci.yml)
[![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Ricky-Stevens_lazy-backlog&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=Ricky-Stevens_lazy-backlog)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=Ricky-Stevens_lazy-backlog&metric=coverage)](https://sonarcloud.io/summary/new_code?id=Ricky-Stevens_lazy-backlog)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Lazy Backlog is an [MCP](https://modelcontextprotocol.io) server that turns your AI assistant into a Jira power user. It indexes your Confluence docs, learns your team's patterns from completed tickets, and uses that intelligence to give Product Owners, Scrum Masters, and Engineers the deep insight they need — without manually collecting data or making the LLM guess.

Ask a simple question, get back analysis built from hundreds of historical tickets, team patterns, velocity data, and quality scores. The complexity is all internal.

---

## What Makes This Different

| You ask | What happens internally |
|---------|------------------------|
| *"Create a ticket for OAuth migration"* | Searches KB for context, suggests assignee/points/labels from team patterns, detects duplicates, finds similar resolved work with typical effort range, scaffolds AC from your team's format |
| *"How's the sprint going?"* | Health score, blocker aging, WIP limit warnings, per-person workload balance, stale item detection — one call |
| *"Prepare my standup"* | Per-person digest: completed, started, blocked since yesterday. Aging blockers flagged. New items added mid-sprint highlighted |
| *"Run my retro"* | Velocity trends, cycle time (P50/P75/P90), scope creep %, carryover analysis (chronic slippers flagged), estimation accuracy, workload distribution, sprint-over-sprint comparison |
| *"Help me plan next sprint"* | Velocity average, risk-adjusted capacity, carryover detection, greedy bin-packing of backlog items, per-assignee workload balance, overcommit warnings |
| *"Triage this bug"* | Completeness scoring, severity inference from keywords, sprint recommendation, team convention check, component rework rate warning, recent bug pattern detection |
| *"Show me the backlog"* | Per-item quality flags (orphaned, stale, unestimated, thin), duplicate clusters, aging analysis, health summary |

Every response includes contextual next-step suggestions so the LLM knows what to call next without memorising all the tools.

---

## Installation & Setup

Requires [Node.js](https://nodejs.org) 18+ and an [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens).

### Claude Code

```bash
claude mcp add lazy-backlog \
  -e ATLASSIAN_SITE_URL=https://your-site.atlassian.net \
  -e ATLASSIAN_EMAIL=you@company.com \
  -e ATLASSIAN_API_TOKEN=your-api-token \
  -- npx -y lazy-backlog
```

Then just ask: *"Set up my Jira project"* — the AI will prompt you for your project key, board ID, and Confluence spaces, then run setup to get everything ready.

<details>
<summary>Claude Desktop</summary>

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lazy-backlog": {
      "command": "npx",
      "args": ["-y", "lazy-backlog"],
      "env": {
        "ATLASSIAN_SITE_URL": "https://your-site.atlassian.net",
        "ATLASSIAN_EMAIL": "you@company.com",
        "ATLASSIAN_API_TOKEN": "your-api-token",
        "JIRA_PROJECT_KEY": "BP",
        "JIRA_BOARD_ID": "266",
        "CONFLUENCE_SPACES": "ENG,PRODUCT"
      }
    }
  }
}
```

</details>

<details>
<summary>Cursor / Windsurf / Other MCP Clients</summary>

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "lazy-backlog": {
      "command": "npx",
      "args": ["-y", "lazy-backlog"],
      "env": {
        "ATLASSIAN_SITE_URL": "https://your-site.atlassian.net",
        "ATLASSIAN_EMAIL": "you@company.com",
        "ATLASSIAN_API_TOKEN": "your-api-token",
        "JIRA_PROJECT_KEY": "BP",
        "JIRA_BOARD_ID": "266",
        "CONFLUENCE_SPACES": "ENG,PRODUCT"
      }
    }
  }
}
```

</details>

<details>
<summary>From Source</summary>

```bash
git clone https://github.com/Ricky-Stevens/lazy-backlog.git
cd lazy-backlog
npm install
npm run build
```

Then point your MCP client at the local build:

```json
{
  "mcpServers": {
    "lazy-backlog": {
      "command": "node",
      "args": ["/path/to/lazy-backlog/dist/index.js"],
      "env": {
        "ATLASSIAN_SITE_URL": "https://your-site.atlassian.net",
        "ATLASSIAN_EMAIL": "you@company.com",
        "ATLASSIAN_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

</details>

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ATLASSIAN_SITE_URL` | Yes | Your Atlassian site URL (e.g. `https://acme.atlassian.net`) |
| `ATLASSIAN_EMAIL` | Yes | Atlassian account email |
| `ATLASSIAN_API_TOKEN` | Yes | [API token](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `JIRA_PROJECT_KEY` | No | Default project key (e.g. `BP`) — can also be set via `configure` |
| `JIRA_BOARD_ID` | No | Default board ID — required for sprint ops and board-scoped queries |
| `CONFLUENCE_SPACES` | No | Comma-separated space keys to index (e.g. `ENG,PRODUCT`) |
| `LAZY_BACKLOG_DB_PATH` | No | Custom path for SQLite database (defaults to `.lazy-backlog/knowledge.db`) |

Settings can also be saved via `configure setup`, which is the recommended approach since it also discovers your Jira schema, indexes Confluence, and learns team conventions.

---

## Tools

8 tools, 24 actions. You don't need to memorise them — just describe what you want and the AI picks the right one.

### `configure` — Get Started

Run `setup` once to connect everything. It discovers your Jira schema, indexes Confluence docs, analyzes completed tickets to learn conventions, and reports on data quality.

| Action | What it does |
|--------|-------------|
| `setup` | **Run this first.** Connects Jira + Confluence, learns team patterns. Returns data quality report with pass rates and top weaknesses. |
| `set` | Save a single setting |
| `get` | Show config status with setup freshness indicator and re-run recommendations |

> *"Set up my Jira project BP with board 266 and index ENG and PRODUCT spaces"*

---

### `insights` — Team Intelligence & Analytics

The intelligence hub. Every action returns deep analysis, not just raw data.

| Action | What it does |
|--------|-------------|
| `team-profile` | Who owns what, estimation accuracy, description patterns, rework rates, conventions. Flags anomalies: single points of failure, slow components. Zero API calls — reads stored analysis. |
| `epic-progress` | Completion stats with velocity-based forecast and confidence intervals. Detects blocker chains across epic children. |
| `retro` | Auto-detects the right sprint. Returns velocity trends, cycle time (P50/P75/P90), scope creep, carryover (chronic slippers flagged), estimation accuracy, workload distribution, sprint-over-sprint comparison vs 3-sprint average. |
| `plan` | Sprint planning assistant. Computes risk-adjusted capacity from velocity + historical carryover rate. Greedy bin-packing of backlog items with assignee suggestions from ownership data. Overcommit and low-capacity warnings. |

> *"Show me the team profile"*
> *"How's epic BP-100 looking?"*
> *"Run my retro"*
> *"Help me plan next sprint"*

---

### `issues` — Create & Manage Tickets

Create, update, search, and decompose Jira issues. **Creates always preview first** — you see a rich card with everything before anything hits Jira.

| Action | What it does |
|--------|-------------|
| `get` | Full issue details with cycle time context vs team averages. Flags at-risk items exceeding P75 cycle time. |
| `create` | Single ticket, bulk (pass `tickets` array), or epic decomposition (pass `epicKey`). Preview includes smart defaults, team conventions, KB context, duplicates, and similar resolved issues with typical effort range. |
| `update` | Modify fields, transition status, assign, rank, link, remove links. Shows enrichment suggestions for missing fields. On status transition to Done: shows impact ripple (unblocked issues + epic progress delta). |
| `search` | Universal JQL search (auto-scoped to project). Results include analytics: status breakdown, average age, priority distribution, unassigned count. |

> *"Create a task for migrating to OAuth2"* — review preview — *"Looks good, confirm"*
> *"Search for open bugs in the payments component"*

---

### `bugs` — Triage Pipeline

Complete bug assessment in one call. No more bouncing between find, assess, and triage.

| Action | What it does |
|--------|-------------|
| `triage` | Scores completeness (steps to reproduce, expected/actual, environment). Infers severity from keywords. Recommends sprint placement. Evaluates team conventions. Warns about high-rework components. Detects bug patterns (3rd bug in 'payments' this month — systemic issue?). Optionally auto-applies with `autoUpdate=true`. |

> *"Triage BP-45 and BP-67"*

For bug searches, use `issues search` with `type = Bug` JQL.

---

### `backlog` — Board Backlog with Health Intelligence

Every backlog view is a health check.

| Action | What it does |
|--------|-------------|
| `list` | Backlog items with per-item quality flags (orphaned, stale, unestimated, thin descriptions). Always-on duplicate detection. Aging analysis: items bucketed by age with stale item warnings. Health summary footer. |
| `rank` | Reorder items with impact preview: shows issue context, story points, and what % of team velocity this item would consume if pulled into the next sprint. |

> *"Show me the backlog"*
> *"Move BP-42 to the top"*

For JQL-filtered queries, use `issues search` with `sprint is EMPTY`.

---

### `sprints` — Sprint Management

Context-adaptive sprint views that give you the right information for the right moment.

| Action | What it does |
|--------|-------------|
| `list` | Sprints with quick health indicators for active sprints (completion %, days left, SP progress) |
| `get` | **Context-adaptive.** Active sprint: full dashboard with health, blockers, WIP limit warnings, per-assignee workload. Pass `since=24h` for standup digest (per-person completed/started/blocked). Closed sprint: release notes grouped by type (features, bugs, tech debt), carryover, metrics. |
| `create` | New sprint with optional goal. Returns capacity pre-calculation from team velocity. |
| `update` | Set goal (with alignment check — what % of sprint items relate to the goal), rename, modify dates. |
| `move-issues` | Assign issues to sprint with capacity impact analysis. Warns on overcommitment vs team velocity. |

> *"How's the current sprint going?"*
> *"Prepare my standup"*
> *"What did we ship last sprint?"*
> *"Move BP-42 and BP-43 into the next sprint"*

---

### `knowledge` — Search & Explore Your Docs

Source-agnostic knowledge base with built-in intelligence.

| Action | What it does |
|--------|-------------|
| `search` | Full-text search across all indexed content. Results include intelligence: type/source/age breakdown, staleness warnings. |
| `stats` | KB dashboard: counts, context summary (ADRs, designs, specs), recent changes, stale docs, health indicator, coverage gap detection (undocumented components, missing ADRs/runbooks). |
| `get-page` | Full page content with freshness indicator, related pages, and Jira ticket references. |

> *"Search docs for authentication"*
> *"How's the knowledge base looking?"*

---

### `confluence` — Index Confluence

Spider Confluence spaces into the knowledge base. To search indexed content, use `knowledge`.

| Action | What it does |
|--------|-------------|
| `spider` | Crawl and index pages (incremental — only re-indexes changed content). Returns quality report: content depth, type distribution, pages needing classification review. |
| `list-spaces` | Show available Confluence spaces |

> *"Re-index the engineering docs"*

---

## Example Workflows

### First-Time Setup

> *"Set up my Jira project and index our engineering docs"*

The AI asks for your project key, board ID, and Confluence spaces, then runs setup. Schema discovery, doc indexing, team analysis — one call. Returns a data quality report showing your team's strengths and areas for improvement.

### Sprint Planning

> *"Help me plan the next sprint"*

Returns risk-adjusted capacity (factoring historical carryover and estimation bias), recommends backlog items that fit, suggests assignees from ownership data, warns on overcommitment.

### Daily Standup

> *"Prepare my standup"*

Per-person digest: what was completed, started, or blocked since yesterday. Aging blockers flagged. New items added mid-sprint highlighted. No manual Jira trawling needed.

### Ticket Creation

> *"Create tickets for migrating to the new payment gateway"*

Rich preview with KB context, smart defaults from team patterns, duplicate detection, similar resolved work with typical effort range, and acceptance criteria scaffolded from your team's actual template format. Review it, then confirm.

### Sprint Retrospective

> *"Run my retro"*

Velocity trends, cycle time analysis, scope creep quantification, chronic carryover detection, estimation accuracy, workload balance assessment, and sprint-over-sprint comparison — all in one call.

### Bug Triage

> *"Triage the latest bugs"*

Complete pipeline per bug: completeness scoring, severity inference, sprint recommendation, team convention evaluation, component rework rate warnings, and pattern detection (is this component seeing a spike?).

---

## Development

```bash
npm install          # Install dependencies
npm run check        # Typecheck + lint + test (all at once)
npm run typecheck    # TypeScript strict mode
npm run lint         # Biome linter
npm test             # Vitest (900+ tests)
npm run build        # Compile to dist/
```

---

## Why Not Atlassian Rovo?

Atlassian has Rovo, and it may well catch up over time. But right now, there's a fundamental difference in approach.

**Rovo is CRUD with a chat interface.** It can create tickets, search issues, and answer questions about your Jira data. It's a natural language wrapper around the Atlassian API. Ask it to create a ticket and it creates a ticket. Ask it about your sprint and it shows you the sprint board.

**Lazy Backlog is an intelligence layer.** It doesn't just read and write Jira — it learns your team's patterns from completed tickets, indexes your documentation, and uses that context to give you insight you didn't ask for but actually need:

- Rovo creates a ticket. Lazy Backlog creates a ticket *and* tells you that 3 similar tickets were resolved at 3-5 SP over 4-6 days, suggests the right assignee based on component ownership, scaffolds acceptance criteria from your team's actual format, and warns you about duplicates.
- Rovo shows you the sprint. Lazy Backlog shows you the sprint *and* flags that Alice has 4 items in progress (WIP limit exceeded), the payments component has had 3 bugs this month (systemic issue?), and you're overcommitted by 18% against your velocity.
- Rovo runs a search. Lazy Backlog runs a search *and* gives you the status breakdown, average age, priority distribution, and notes that 3 results are unassigned.

The value isn't in the CRUD operations — any tool can do those. The value is in the intelligence that helps Product Owners, Scrum Masters, and Engineers make better decisions without manually collecting data or asking the right questions. Lazy Backlog does the heavy lifting internally and surfaces what matters.

Rovo will likely get smarter. But the bar for "good enough" in agile intelligence is high, and the open-source community can move fast. Contributions welcome.

---

## License

[MIT](LICENSE)
