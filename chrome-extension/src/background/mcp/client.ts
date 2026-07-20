import { Client } from '@modelcontextprotocol/sdk/client/index';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types';
import type { MCPTool } from './types';
import { createLogger } from '@src/background/log';

const logger = createLogger('MCPClient');

interface TextContent {
  type: 'text';
  text: string;
}

export class MCPClient {
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  private connected = false;

  constructor(url: string) {
    this.transport = new StreamableHTTPClientTransport(new URL(url));
    this.client = new Client({ name: 'nanobrowser', version: '1.0.0' }, { capabilities: {} });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.client.listTools();
    return result.tools.map((t: Tool) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema as MCPTool['inputSchema'],
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.client.callTool({ name, arguments: args });
    const content = (result as CallToolResult).content;
    if (result.isError) {
      const errText =
        content
          ?.filter((c): c is TextContent => c.type === 'text')
          .map((c: TextContent) => c.text)
          .join('\n') || 'Tool call failed';
      throw new Error(errText);
    }
    return (
      content
        ?.filter((c): c is TextContent => c.type === 'text')
        .map((c: TextContent) => c.text)
        .join('\n') || ''
    );
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.client.close();
    } catch (e) {
      logger.warning(`Error closing MCP client: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.connected = false;
  }
}
