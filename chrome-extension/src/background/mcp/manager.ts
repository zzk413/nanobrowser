import { MCPClient } from './client';
import type { MCPTool, MCPServerConfig } from './types';
import { createLogger } from '@src/background/log';

const logger = createLogger('MCPManager');

const DEFAULT_SERVERS: MCPServerConfig[] = [{ url: 'http://localhost:8000' }];

export class MCPManager {
  private static instance: MCPManager;
  private clients: MCPClient[] = [];
  private tools: MCPTool[] = [];
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  static getInstance(): MCPManager {
    if (!MCPManager.instance) {
      MCPManager.instance = new MCPManager();
    }
    return MCPManager.instance;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    for (const config of DEFAULT_SERVERS) {
      try {
        const client = new MCPClient(config.url);
        await client.connect();
        const tools = await client.listTools();
        this.tools.push(...tools);
        this.clients.push(client);
        logger.info(`Connected to MCP server at ${config.url}, found ${tools.length} tools`);
      } catch (error) {
        logger.warning(
          `Failed to connect to MCP server at ${config.url}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.initialized = true;
  }

  getTools(): MCPTool[] {
    return this.tools;
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    for (const client of this.clients) {
      try {
        return await client.callTool(name, args);
      } catch {
        continue;
      }
    }
    throw new Error(`MCP tool "${name}" not found`);
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.clients.map(c => c.disconnect()));
    this.clients = [];
    this.tools = [];
    this.initialized = false;
    this.initPromise = null;
  }
}
