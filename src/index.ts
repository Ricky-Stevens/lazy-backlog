#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { KnowledgeBase } from "./lib/db.js";
import { registerContextTools } from "./tools/context.js";
import { registerSpiderTools } from "./tools/spider.js";
import { registerTicketTools } from "./tools/tickets.js";

const server = new McpServer({ name: "lazy-backlog", version: "0.1.0" }, { capabilities: { logging: {} } });

// Lazy-init knowledge base
let kb: KnowledgeBase | null = null;
function getKb(): KnowledgeBase {
  kb ??= new KnowledgeBase();
  return kb;
}

// Register tool groups
registerSpiderTools(server, getKb);
registerContextTools(server, getKb);
registerTicketTools(server, getKb);

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
