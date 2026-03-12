# Lazy Backlog

**AI-powered Jira management with deep team intelligence**

[![npm version](https://img.shields.io/npm/v/lazy-backlog.svg)](https://www.npmjs.com/package/lazy-backlog)
[![CI](https://github.com/Ricky-Stevens/lazy-backlog/actions/workflows/ci.yml/badge.svg)](https://github.com/Ricky-Stevens/lazy-backlog/actions/workflows/ci.yml)
[![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Ricky-Stevens_lazy-backlog&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=Ricky-Stevens_lazy-backlog)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=Ricky-Stevens_lazy-backlog&metric=coverage)](https://sonarcloud.io/summary/new_code?id=Ricky-Stevens_lazy-backlog)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Lazy Backlog is an [MCP](https://modelcontextprotocol.io) server that connects your AI assistant to Jira and a source-agnostic knowledge base. It indexes content from Confluence (with future support for GitHub, Google Docs, SharePoint), learns your team's conventions from completed tickets, and uses that intelligence to generate rich, well-grounded Jira tickets with duplicate detection, smart field suggestions, and structured preview cards.

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

### Claude Desktop

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

### Cursor / Windsurf / Other MCP Clients

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

### From Source

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

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ATLASSIAN_SITE_URL` | Yes | Your Atlassian site URL (e.g. `https://acme.atlassian.net`) |
| `ATLASSIAN_EMAIL` | Yes | Atlassian account email |
| `ATLASSIAN_API_TOKEN` | Yes | [API token](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `JIRA_PROJECT_KEY` | No | Default Jira project key (e.g. `BP`) — can also be set via `configure` |
| `JIRA_BOARD_ID` | No | Default Jira board ID — required for sprint ops and board-scoped queries |
| `CONFLUENCE_SPACES` | No | Comma-separated space keys to index (e.g. `ENG,PRODUCT`) |

Settings can also be saved to the local SQLite database via the `configure` tool, which is the recommended approach since setup also discovers your Jira schema, indexes Confluence, and learns team conventions.

---

## Tool Reference

Lazy Backlog exposes **7 tools**, each with multiple actions. The tools cross-reference each other so the AI knows which tool to use for any given request.

### 1. `configure` — Setup & Configuration

One-stop setup for your project. The `setup` action discovers your Jira schema (issue types, fields, priorities), spiders Confluence spaces, and learns team conventions and deep insights from existing tickets — all in one call.

| Action | Description | Key Params |
|--------|-------------|------------|
| `setup` | **Run this first.** Discovers Jira schema, spiders Confluence, learns team patterns + deep insights | `projectKey`, `boardId`, `spaceKeys`, `maxDepth`, `maxTickets` |
| `set` | Save individual settings | `jiraProjectKey`, `jiraBoardId`, `confluenceSpaces`, `rootPageIds` |
| `get` | Show current config and setup status | — |

**Example:** *"Set up my Jira project"* → AI asks for project key, board ID, Confluence spaces, then calls `configure action=setup`

---

### 2. `knowledge` — Knowledge Base (Source-Agnostic)

Search and explore your indexed knowledge base. Content is indexed from Confluence (and future sources like GitHub, Google Docs, SharePoint) into a unified SQLite FTS5 store.

| Action | Description | Key Params |
|--------|-------------|------------|
| `search` | Full-text search across all indexed content | `query`, `pageType`, `spaceKey`, `source`, `limit`, `summarize` |
| `stats` | KB overview — page counts by type and source | — |
| `get-page` | Retrieve full page content from the KB | `pageId` |
| `stale-docs` | Find pages not updated in N days | `staleDays` |
| `what-changed` | Show pages indexed since a date | `since` |

Page types: `adr`, `design`, `runbook`, `meeting`, `spec`, `other`

**Example:** *"Search docs for OAuth2"* → `knowledge action=search query="OAuth2"`

---

### 3. `confluence` — Confluence Source Connector

Spider and index Confluence content into the knowledge base. To search or browse indexed content, use the `knowledge` tool.

| Action | Description | Key Params |
|--------|-------------|------------|
| `spider` | Crawl and index Confluence pages into the KB | `spaceKey`, `rootPageId`, `maxDepth`, `maxConcurrency`, `includeLabels`, `excludeLabels`, `force` |
| `list-spaces` | Show available Confluence spaces | — |

**Example:** *"Re-index the engineering docs"* → `confluence action=spider spaceKey="ENG"`

---

### 4. `issues` — Issue CRUD & Planning

Create, read, update, and search Jira issues. **All creates use a preview-first flow** — the first call returns a structured preview card with KB context, team intelligence (smart defaults, estimation context, risk signals), duplicate detection, and team conventions. Set `confirmed=true` to submit.

| Action | Description | Key Params |
|--------|-------------|------------|
| `get` | Fetch full issue details (description, comments, links, metadata) | `issueKey` |
| `create` | Create a single issue (preview first, then `confirmed=true`) | `summary`, `description`, `issueType`, `priority`, `labels`, `storyPoints`, `parentKey`, `components`, `namedFields`, `confirmed` |
| `bulk-create` | Create multiple issues (preview first, then `confirmed=true`) | `tickets` (array), `confirmed` |
| `update` | Modify fields, transition status, assign, rank, or link issues | `issueKey`, `summary`, `description`, `priority`, `status`, `assignee`, `links`, `rankBefore`, `rankAfter` |
| `search` | Query issues via JQL (auto-scoped to configured board/project) | `jql`, `maxResults` |
| `epic-progress` | Show epic completion stats (done/in-progress/todo breakdown) | `epicKey` |
| `decompose` | Break an epic into suggested child stories using KB context + team conventions | `epicKey`, `spaceKey` |

#### Preview Card Contents

When you create or bulk-create, the preview includes:

- **Field table** — Summary, type, priority, points, labels, components
- **Description** — Full formatted content
- **Team Intelligence** — Smart defaults (suggested assignee, points, priority, labels with confidence), estimation context (cycle time predictions), description template guidance, risk signals (rework rates)
- **Team Conventions** — Applied/warning/info table showing how the ticket aligns with team patterns
- **Knowledge Base Context** — Matching docs and relevant sections from your indexed content
- **Potential Duplicates** — Similar existing tickets with Jaccard similarity scores

**Example:** *"Create a task for migrating to OAuth2"* → returns rich preview → *"Looks good, confirm"* → `confirmed=true`

---

### 5. `bugs` — Bug Discovery & Triage

Find, assess, and triage bugs. Search auto-enforces `type=Bug` and scopes to your configured board. Triage evaluates team conventions for label/component suggestions.

| Action | Description | Key Params |
|--------|-------------|------------|
| `find-bugs` | List untriaged bugs by date range | `dateRange` (`7d`/`30d`/`90d`), `component`, `jql`, `maxResults` |
| `search` | Query bugs via JQL (auto-enforces `type=Bug` + board scope) | `jql`, `maxResults` |
| `assess` | Score bug report completeness (0-100%) and auto-comment on incomplete bugs | `issueKeys`, `autoComment` |
| `triage` | Prioritize a bug — infers severity, recommends sprint, suggests trade-offs, evaluates team conventions | `issueKeys`, `severity`, `autoUpdate`, `autoAssign` |

**Example:** *"Find bugs from the last week"* → `bugs action=find-bugs dateRange="7d"`

---

### 6. `backlog` — Backlog Management

List, search, and rank backlog items. All queries are board-scoped via the Agile API. Optionally detect duplicate items in the backlog.

| Action | Description | Key Params |
|--------|-------------|------------|
| `list` | Show the board's backlog items | `maxResults`, `detectDuplicates` |
| `search` | Query backlog items via JQL (auto-enforces `sprint is EMPTY` + board scope) | `jql`, `maxResults` |
| `rank` | Reorder backlog items — `top`/`bottom` or precise `rankBefore`/`rankAfter` | `issueKey`, `position`, `rankBefore`, `rankAfter` |

**Example:** *"Show me the backlog and check for duplicates"* → `backlog action=list detectDuplicates=true`

---

### 7. `sprints` — Sprint Management & Analytics

Manage sprints, track velocity, monitor health, and generate retrospective data.

| Action | Description | Key Params |
|--------|-------------|------------|
| `list` | Show sprints (active + future by default) | `state` (`active`, `future`, `closed`) |
| `get` | Sprint details with issues grouped by status and assignee | `sprintId` |
| `create` | Create a new sprint | `name`, `goal`, `startDate`, `endDate` |
| `move-issues` | Assign issues to a sprint | `sprintId`, `issueKeys` |
| `velocity` | Team velocity trends with optional bug rate and scope change metrics | `sprintCount`, `trendMetrics` |
| `health` | Active sprint health: blockers, stale items, progress, capacity | `sprintId`, `staleDays` |
| `retro` | Retrospective data: scope creep, carry-over, cycle time, bug ratio | `sprintId`, `sprintCount` |
| `goal` | Read or set sprint goal | `sprintId`, `goal` |

Health assessment levels: `[OK]`, `[WARNING]`, `[CRITICAL]`

**Example:** *"How's the current sprint going?"* → `sprints action=health`

---

## Key Features

### Team Intelligence

During setup, Lazy Backlog analyzes your completed tickets and learns:

- **Estimation patterns** — Cycle time per issue type, points-to-days ratios, estimation accuracy
- **Component ownership** — Who works on what, with percentages and avg cycle times
- **Description templates** — Your team's heading patterns, acceptance criteria format, section structure
- **Label & priority patterns** — Co-occurrence graphs, priority distributions by type
- **Rework rates** — Which components have high reopen rates (risk signals)
- **Naming conventions** — Verb-first summaries, word count patterns
- **Story point scales** — Fibonacci validation, team median by issue type

This intelligence is surfaced as **smart defaults** in ticket creation previews — suggested assignee, points, priority, labels — each with a confidence level and the data behind it.

### Duplicate Detection

Create flows automatically check for similar existing tickets using Jaccard similarity on tokenized summaries. The backlog tool can also flag potential duplicates across your entire backlog with `detectDuplicates=true`.

### Source-Agnostic Knowledge Base

Content is indexed from Confluence today, with the architecture ready for additional sources (GitHub READMEs, Google Docs, SharePoint). Every indexed page tracks its source, and the `knowledge` tool provides unified search across all sources.

---

## Example Workflows

### First-Time Setup

> *"Set up my Jira project and index our engineering docs"*

The AI will ask for your project key, board ID, and Confluence spaces, then run:

1. **`configure action=setup`** — Discovers Jira schema, spiders Confluence, learns team patterns + deep insights
2. **`knowledge action=stats`** — Verify KB stats (page counts by type and source)

---

### Sprint Planning

> *"Help me plan the next sprint"*

1. **`sprints action=velocity`** — Review velocity trends over the last 5 sprints
2. **`sprints action=health`** — Check current sprint progress and capacity
3. **`backlog action=list`** — Review prioritized backlog items
4. **`sprints action=move-issues`** — Assign selected issues to the next sprint

---

### Ticket Creation with Context

> *"Create tickets for migrating to the new payment gateway"*

1. **`issues action=create summary="Migrate payment processing to Stripe v2"`** — Returns a structured preview with KB context, team intelligence, conventions, and duplicate check
2. Review the preview — it shows smart defaults (suggested assignee, points, priority), matching docs, and potential duplicates
3. **`issues action=create ... confirmed=true`** — Submit to Jira

For multiple tickets:
1. **`issues action=bulk-create tickets=[...]`** — Preview all tickets with shared intelligence
2. **`issues action=bulk-create tickets=[...] confirmed=true`** — Create them all

---

### Bug Triage Session

> *"Let's triage the recent bugs"*

1. **`bugs action=find-bugs dateRange="7d"`** — Find bugs from the last week
2. **`bugs action=assess issueKeys=[...]`** — Score completeness; auto-comments on incomplete bugs
3. **`bugs action=triage issueKeys=["BP-101"] autoAssign=true`** — Prioritize and assign to sprint (includes team convention evaluation)

---

### Backlog Grooming

> *"Review the backlog and check for duplicates"*

1. **`backlog action=list detectDuplicates=true`** — View backlog items with duplicate detection
2. **`backlog action=search jql="priority = High"`** — Find high-priority items
3. **`backlog action=rank issueKey="BP-42" position="top"`** — Move critical items to the top

---

### Sprint Retrospective

> *"Prepare data for our sprint retrospective"*

1. **`sprints action=retro`** — Full retrospective data: scope creep, carry-over, cycle time, bug ratio
2. **`sprints action=velocity trendMetrics=["velocity","bugRate","scopeChange"]`** — Multi-metric trend analysis

---

### Knowledge Base Review

> *"Are there any stale docs we should update?"*

1. **`knowledge action=stale-docs staleDays=90`** — Find pages not updated in 90+ days
2. **`knowledge action=what-changed since="2025-01-01"`** — See recently indexed changes
3. **`knowledge action=search query="authentication" pageType="adr"`** — Search within a document type

---

## Architecture

```
                    +-----------+
                    | MCP Client|
                    | (Claude,  |
                    |  Cursor,  |
                    |  etc.)    |
                    +-----+-----+
                          |
                   JSON-RPC (stdio)
                          |
                    +-----v-----+
                    | MCP Server|
                    | (7 tools) |
                    +-----+-----+
                          |
            +-------------+-------------+
            |             |             |
    +-------v------+ +---v---+ +------v------+
    | Source        | | Jira  | | SQLite FTS5 |
    | Connectors   | | REST  | | Knowledge   |
    | (Confluence,  | | v3 +  | | Base +      |
    |  future:      | | Agile | | Team        |
    |  GitHub, etc.)| | v1    | | Insights    |
    +--------------+ +-------+ +-------------+
```

### Operational Modes

- **Knowledge-only** — Spider and search docs without any Jira config.
- **Jira-only** — Create and manage tickets, sprints, and analytics without a knowledge base.
- **Combined** (recommended) — Full power: index docs, ground tickets in context, leverage team intelligence, manage sprints, and triage bugs.

### Data Flow

```
Source Connectors  -->  Extract & Classify  -->  Index (SQLite FTS5)
                                                       |
Team Analysis  -->  Quality Score  -->  Extract Rules + Deep Insights
                                                       |
                                                       v
                                            Create (structured preview)
                                            - Smart defaults
                                            - KB context
                                            - Duplicate detection
                                            - Team conventions
                                                       |
                                                       v
                                            Confirm (Jira API)
```

All indexed data is stored locally in `.lazy-backlog/knowledge.db`. No data is sent to third-party services beyond Atlassian's own APIs.

---

## Development

```bash
# Install dependencies
npm install

# Run all checks (typecheck + lint + test)
npm run check

# Individual commands
npm run typecheck    # TypeScript strict mode checking
npm run lint         # Biome linter
npm run lint:fix     # Auto-fix lint issues
npm test             # Run tests via vitest

# Build for publishing
npm run build        # Compile TypeScript to dist/
```

### Project Structure

```
src/
  index.ts                    -- MCP server entry point (7 tools)
  tools/
    configure.ts              -- Project setup (setup, set, get)
    knowledge.ts              -- Source-agnostic KB (search, stats, get-page, stale-docs, what-changed)
    confluence.ts             -- Confluence connector (spider, list-spaces)
    preview-builder.ts        -- Structured preview cards (single + bulk)
    issues.ts                 -- Jira CRUD + planning (get, create, bulk-create, update, search, epic-progress, decompose)
      issues-helpers.ts       -- Shared helpers, KB context retrieval
      issues-create.ts        -- Create + bulk-create with previews, duplicates, conventions
      issues-get.ts           -- Get + search handlers
    bugs.ts                   -- Bug workflows (find-bugs, search, assess, triage)
    backlog.ts                -- Backlog management (list, search, rank, detectDuplicates)
    sprints.ts                -- Sprint management + analytics (list, get, create, move-issues, velocity, health, retro, goal)
  lib/
    confluence.ts             -- Confluence REST API v2 client
    jira.ts                   -- Jira REST API v3 + Agile v1 client + schema discovery
    db.ts                     -- SQLite + FTS5 knowledge base (source-aware, STRICT tables)
    indexer.ts                -- Spider + content extraction + page classification
    chunker.ts                -- Markdown-aware section chunking (remark AST)
    analytics.ts              -- Velocity, capacity, and sprint health computations
    duplicate-detect.ts       -- Jaccard similarity duplicate detection
    team-rules.ts             -- Convention validation: quality scoring, pattern extraction
    team-insights.ts          -- Deep analysis: estimation, ownership, templates, patterns
    team-insights-suggest.ts  -- Smart defaults, description scaffolding
    config.ts                 -- Config resolution (env vars + SQLite)
  config/
    schema.ts                 -- Zod validation schemas
```

---

## License

[MIT](LICENSE)
