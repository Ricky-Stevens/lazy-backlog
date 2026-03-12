#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { KnowledgeBase } from "./lib/db.js";
import { registerBacklogTool } from "./tools/backlog.js";
import { registerBugsTool } from "./tools/bugs.js";
import { registerConfigureTool } from "./tools/configure.js";
import { registerConfluenceTool } from "./tools/confluence.js";
import { registerIssuesTool } from "./tools/issues.js";
import { registerKnowledgeTool } from "./tools/knowledge.js";
import { registerSprintsTool } from "./tools/sprints.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };
const server = new McpServer({ name: "lazy-backlog", version: pkg.version }, { capabilities: { logging: {} } });

// Lazy-init knowledge base
let kb: KnowledgeBase | null = null;
function getKb(): KnowledgeBase {
  kb ??= new KnowledgeBase(process.env.LAZY_BACKLOG_DB_PATH || join(process.cwd(), ".lazy-backlog", "knowledge.db"));
  return kb;
}

// Register consolidated tools (7 tools with action-based routing)
registerConfigureTool(server, getKb);
registerConfluenceTool(server, getKb);
registerKnowledgeTool(server, getKb);
registerBacklogTool(server, getKb);
registerBugsTool(server, getKb);
registerIssuesTool(server, getKb);
registerSprintsTool(server, getKb);

// Graceful shutdown
function shutdown() {
  console.error("Lazy Backlog shutting down…");
  if (kb) {
    kb.close();
    kb = null;
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Lazy Backlog MCP Server running on stdio");
}

try {
  await main();
} catch (error) {
  console.error("Fatal:", error);
  process.exit(1);
}
