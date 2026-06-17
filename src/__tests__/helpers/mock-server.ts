import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type ToolCallback = (
  params: Record<string, unknown>,
) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

interface ToolMetadata {
  description: string;
  inputSchema: unknown;
}

/**
 * Mock McpServer that captures tool registrations.
 * Call `getTool(name)` to get the registered callback, or
 * `getToolMetadata(name)` to inspect the description + schema.
 */
export function createMockServer() {
  const tools = new Map<string, ToolCallback>();
  const metadata = new Map<string, ToolMetadata>();

  const server = {
    tool: (_name: string, desc: string, _schema: unknown, callback?: ToolCallback) => {
      // Handle overloaded signatures: (name, desc, schema, callback) or (name, desc, callback)
      if (typeof _schema === "function") {
        tools.set(_name, _schema as unknown as ToolCallback);
        metadata.set(_name, { description: desc, inputSchema: undefined });
      } else if (callback) {
        tools.set(_name, callback);
        metadata.set(_name, { description: desc, inputSchema: _schema });
      }
    },
    registerTool: (_name: string, config: { description: string; inputSchema: unknown }, callback: ToolCallback) => {
      tools.set(_name, callback);
      metadata.set(_name, { description: config.description, inputSchema: config.inputSchema });
    },
  } as unknown as McpServer;

  return {
    server,
    getTool: (name: string) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool "${name}" not registered`);
      return tool;
    },
    getToolMetadata: (name: string): ToolMetadata => {
      const meta = metadata.get(name);
      if (!meta) throw new Error(`Tool "${name}" not registered`);
      return meta;
    },
    toolNames: () => [...tools.keys()],
  };
}
