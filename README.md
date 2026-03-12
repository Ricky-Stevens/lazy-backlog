# Lazy Backlog

**AI-powered Jira management with deep team intelligence**

[![npm version](https://img.shields.io/npm/v/lazy-backlog.svg)](https://www.npmjs.com/package/lazy-backlog)
[![CI](https://github.com/Ricky-Stevens/lazy-backlog/actions/workflows/ci.yml/badge.svg)](https://github.com/Ricky-Stevens/lazy-backlog/actions/workflows/ci.yml)
[![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Ricky-Stevens_lazy-backlog&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=Ricky-Stevens_lazy-backlog)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=Ricky-Stevens_lazy-backlog&metric=coverage)](https://sonarcloud.io/summary/new_code?id=Ricky-Stevens_lazy-backlog)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Lazy Backlog is an [MCP](https://modelcontextprotocol.io) server that connects your AI assistant to Jira and Confluence. It indexes your docs, learns your team's conventions from completed tickets, and uses that intelligence to generate rich Jira tickets with duplicate detection, smart field suggestions, and structured previews.

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

Then just ask: *"Set up my Jira project"* — the AI will prompt you for your project key, board ID, and Confluence spaces, then run `configure action=setup` to get everything ready.

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
| `JIRA_PROJECT_KEY` | No | Default Jira project key (e.g. `BP`) — can also be set via `configure` |
| `JIRA_BOARD_ID` | No | Default Jira board ID — required for sprint ops and board-scoped queries |
| `CONFLUENCE_SPACES` | No | Comma-separated space keys to index (e.g. `ENG,PRODUCT`) |
| `LAZY_BACKLOG_DB_PATH` | No | Custom path for the SQLite database (defaults to `.lazy-backlog/knowledge.db` in the working directory) |

Settings can also be saved to the local SQLite database via the `configure` tool, which is the recommended approach since setup also discovers your Jira schema, indexes Confluence, and learns team conventions.

---

## Tools

Lazy Backlog exposes **8 tools**. You don't need to memorise them — just describe what you want and your AI assistant will pick the right one.

### `configure` — Get Started

Run `setup` once to connect everything. It discovers your Jira schema, indexes your Confluence docs, and analyzes your team's completed tickets to learn conventions and build intelligence.

| Action | What it does |
|--------|-------------|
| `setup` | **Run this first.** Connects Jira + Confluence, learns team patterns |
| `set` | Save a single setting (project key, board ID, spaces) |
| `get` | Show current config and what's been set up |

> *"Set up my Jira project BP with board 266 and index ENG and PRODUCT spaces"*

---

### `insights` — Team Intelligence & Analytics

Your team's profile, built from real data. `team-profile` reads from stored analysis (no API calls) — the rest pull live sprint data.

| Action | What it does |
|--------|-------------|
| `team-profile` | Who owns what, estimation accuracy, description patterns, rework rates, conventions |
| `epic-progress` | Epic completion breakdown — done, in progress, to do, story points |
| `velocity` | Velocity trends across past sprints, with optional bug rate and scope change |
| `retro` | Retrospective data — scope creep, carry-over, cycle time, time-in-status |

> *"Show me the team profile"*
> *"How's epic BP-100 looking?"*
> *"Prepare retro data for our last sprint"*

---

### `issues` — Create & Manage Tickets

Create, update, search, and decompose Jira issues. **Creates always preview first** — you see a rich card with KB context, smart defaults, duplicate detection, and team conventions before anything hits Jira.

| Action | What it does |
|--------|-------------|
| `get` | Fetch full issue details (single or bulk) |
| `create` | Create a ticket — shows preview first, set `confirmed=true` to submit |
| `bulk-create` | Create multiple tickets — same preview flow |
| `update` | Change fields, transition status, assign, rank, or link |
| `search` | JQL search (auto-scoped to your board/project) |
| `decompose` | Break an epic into child stories using KB context |

The preview card includes:
- **Smart defaults** — suggested assignee, points, priority, labels (with confidence levels)
- **Team conventions** — how the ticket aligns with your team's patterns
- **KB context** — matching docs and relevant sections
- **Duplicates** — similar existing tickets with similarity scores

> *"Create a task for migrating to OAuth2"* — review preview — *"Looks good, confirm"*

---

### `bugs` — Find & Triage Bugs

Discover untriaged bugs, score report quality, and prioritize with team convention awareness.

| Action | What it does |
|--------|-------------|
| `find-bugs` | List untriaged bugs by date range (7d, 30d, 90d) |
| `search` | JQL search (auto-enforces type=Bug + board scope) |
| `assess` | Score bug report completeness, auto-comment on incomplete ones |
| `triage` | Prioritize — infers severity, recommends sprint, suggests trade-offs |

> *"Find bugs from the last week and triage them"*

---

### `backlog` — Manage the Backlog

View, search, and reorder backlog items. Can flag duplicate items across your backlog.

| Action | What it does |
|--------|-------------|
| `list` | Show backlog items, optionally detect duplicates |
| `search` | JQL search (auto-enforces `sprint is EMPTY` + board scope) |
| `rank` | Move items — `top`, `bottom`, or relative to another issue |

> *"Show me the backlog and check for duplicates"*

---

### `sprints` — Sprint Management

Create sprints, move issues, check health, and manage goals.

| Action | What it does |
|--------|-------------|
| `list` | Show sprints (active + future by default, or filter by state) |
| `get` | Sprint details with issues by status and assignee |
| `create` | Create a new sprint with optional goal and dates |
| `move-issues` | Assign issues to a sprint |
| `health` | Active sprint health — blockers, stale items, progress, capacity |
| `goal` | Read or set the sprint goal |

> *"How's the current sprint going?"*
> *"Move BP-42 and BP-43 into the next sprint"*

---

### `knowledge` — Search Your Docs

Search and explore your indexed knowledge base. Content comes from Confluence today, with the architecture ready for additional sources.

| Action | What it does |
|--------|-------------|
| `search` | Full-text search across all indexed content |
| `stats` | KB overview — page counts by type and source |
| `get-page` | Retrieve full page content |
| `stale-docs` | Find pages not updated in N days |
| `what-changed` | Show pages indexed since a date |

> *"Search docs for authentication"*
> *"Are there any stale docs we should update?"*

---

### `confluence` — Index Confluence

Spider Confluence spaces into the knowledge base. To search indexed content, use `knowledge`.

| Action | What it does |
|--------|-------------|
| `spider` | Crawl and index pages (incremental — only re-indexes changed pages) |
| `list-spaces` | Show available Confluence spaces |

> *"Re-index the engineering docs"*

---

## Example Workflows

### First-Time Setup

> *"Set up my Jira project and index our engineering docs"*

The AI asks for your project key, board ID, and Confluence spaces, then runs setup. Everything — schema discovery, doc indexing, team analysis — happens in one call.

### Sprint Planning

> *"Help me plan the next sprint"*

The AI checks velocity trends, reviews current sprint health, pulls up the prioritized backlog, and helps you move issues into the next sprint.

### Ticket Creation

> *"Create tickets for migrating to the new payment gateway"*

Returns a rich preview with KB context, smart defaults, and duplicate detection. Review it, then confirm to create.

### Sprint Retrospective

> *"Prepare data for our sprint retrospective"*

Generates scope creep analysis, carry-over items, cycle time breakdowns, and velocity trends.

---

## Development

```bash
npm install          # Install dependencies
npm run check        # Typecheck + lint + test (all at once)
npm run typecheck    # TypeScript strict mode
npm run lint         # Biome linter
npm test             # Vitest
npm run build        # Compile to dist/
```

---

## License

[MIT](LICENSE)
