# Nanobrowser MCP Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MCP server support to nanobrowser's backend so agents can discover and invoke external tools from MCP servers over HTTP.

**Architecture:** An `MCPClient` wraps `@modelcontextprotocol/sdk` with `StreamableHTTPClientTransport` to connect to hardcoded `localhost:8000`. An `MCPManager` singleton handles init and tool aggregation. Discovered tools are converted to `Action` instances and registered in `NavigatorActionRegistry`, with tool descriptions injected into the Planner's system prompt.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, Zod, Chrome extension service worker.

---

### Task 1: Add `@modelcontextprotocol/sdk` dependency

**Files:**
- Modify: `chrome-extension/package.json`

- [ ] **Step 1: Add `@modelcontextprotocol/sdk` to dependencies**

Edit `chrome-extension/package.json`, adding `"@modelcontextprotocol/sdk"` to the `dependencies` block:

```json
"dependencies": {
    "@extension/i18n": "workspace:*",
    "@extension/shared": "workspace:*",
    "@extension/storage": "workspace:*",
    "@langchain/anthropic": "0.3.33",
    "@langchain/cerebras": "0.0.4",
    "@langchain/core": "0.3.79",
    "@langchain/deepseek": "0.1.0",
    "@langchain/google-genai": "0.2.18",
    "@langchain/groq": "0.2.4",
    "@langchain/ollama": "0.2.4",
    "@langchain/openai": "0.6.16",
    "@langchain/xai": "^0.1.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "jsonrepair": "^3.13.1",
    ...
```

- [ ] **Step 2: Install the dependency**

Run: `pnpm install`
Workdir: `nanobrowser/`

Expected: `@modelcontextprotocol/sdk` resolves and installs successfully.

- [ ] **Step 3: Commit**

```bash
git add chrome-extension/package.json pnpm-lock.yaml
git commit -m "deps: add @modelcontextprotocol/sdk for MCP integration"
```

---

### Task 2: Create `mcp/types.ts` — types and JSON Schema → Zod converter

**Files:**
- Create: `chrome-extension/src/background/mcp/types.ts`

- [ ] **Step 1: Create `mcp/types.ts`**

```typescript
import { z } from 'zod';

export interface MCPServerConfig {
  url: string;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, { type: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
}

function buildZodProp(prop: { type: string; description?: string; enum?: string[] }): z.ZodType {
  let zodType: z.ZodType;
  switch (prop.type) {
    case 'string':
      zodType = prop.enum ? z.enum(prop.enum as [string, ...string[]]) : z.string();
      break;
    case 'number':
      zodType = z.number();
      break;
    case 'integer':
      zodType = z.number().int();
      break;
    case 'boolean':
      zodType = z.boolean();
      break;
    default:
      zodType = z.any();
  }
  if (prop.description) zodType = zodType.describe(prop.description);
  return zodType;
}

export function jsonSchemaToZod(
  schema: MCPTool['inputSchema'],
): z.ZodType {
  if (schema.type !== 'object' || !schema.properties) {
    return z.object({});
  }
  const required = schema.required || [];
  const shape: Record<string, z.ZodType> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    let zodType = buildZodProp(prop);
    if (!required.includes(key)) zodType = zodType.optional();
    shape[key] = zodType;
  }
  return z.object(shape);
}

export function buildMCPToolsDescription(tools: MCPTool[]): string {
  if (tools.length === 0) return '';
  const lines = tools.map(t => {
    const schema = t.inputSchema;
    const props = schema.properties
      ? Object.entries(schema.properties)
          .map(([k, p]) => `  ${k}: ${p.type}${schema.required?.includes(k) ? ' (required)' : ''}`)
          .join('\n')
      : '  none';
    return `- ${t.name}: ${t.description}\n  Input:\n${props}`;
  });
  return `## Available External (MCP) Tools\n${lines.join('\n')}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add chrome-extension/src/background/mcp/types.ts
git commit -m "feat: add MCP types and JSON Schema to Zod converter"
```

---

### Task 3: Create `mcp/client.ts` — MCP client wrapper

**Files:**
- Create: `chrome-extension/src/background/mcp/client.ts`

- [ ] **Step 1: Create `mcp/client.ts`**

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MCPTool } from './types';
import { createLogger } from '@src/background/log';

const logger = createLogger('MCPClient');

export class MCPClient {
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  private connected = false;

  constructor(url: string) {
    this.transport = new StreamableHTTPClientTransport(new URL(url));
    this.client = new Client(
      { name: 'nanobrowser', version: '1.0.0' },
      { capabilities: {} },
    );
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.client.listTools();
    return result.tools.map(t => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema as MCPTool['inputSchema'],
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.client.callTool({ name, arguments: args });
    if (result.isError) {
      const errText = result.content
        ?.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map(c => c.text)
        .join('\n') || 'Tool call failed';
      throw new Error(errText);
    }
    return result.content
      ?.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map(c => c.text)
      .join('\n') || '';
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
```

- [ ] **Step 2: Commit**

```bash
git add chrome-extension/src/background/mcp/client.ts
git commit -m "feat: add MCP client wrapper"
```

---

### Task 4: Create `mcp/manager.ts` — MCP manager singleton

**Files:**
- Create: `chrome-extension/src/background/mcp/manager.ts`

- [ ] **Step 1: Create `mcp/manager.ts`**

```typescript
import { MCPClient } from './client';
import type { MCPTool, MCPServerConfig } from './types';
import { createLogger } from '@src/background/log';

const logger = createLogger('MCPManager');

const DEFAULT_SERVERS: MCPServerConfig[] = [
  { url: 'http://localhost:8000' },
];

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
```

- [ ] **Step 2: Commit**

```bash
git add chrome-extension/src/background/mcp/manager.ts
git commit -m "feat: add MCP manager singleton"
```

---

### Task 5: Integrate MCP into NavigatorActionRegistry and prompts

**Files:**
- Modify: `chrome-extension/src/background/agent/agents/navigator.ts`
- Modify: `chrome-extension/src/background/agent/agent/prompts/planner.ts`
- Modify: `chrome-extension/src/background/agent/prompts/templates/navigator.ts`
- Modify: `chrome-extension/src/background/agent/prompts/templates/planner.ts`

- [ ] **Step 1: Add `registerMCPTool` to `NavigatorActionRegistry`**

In `agent/agents/navigator.ts`, add these imports at the top (after existing imports):

```typescript
import type { MCPTool, jsonSchemaToZod } from '../../mcp/types';
import { MCPManager } from '../../mcp/manager';
import { ActionResult } from '../types';
```

Wait — `ActionResult` is already imported. And the imports need to be relative. Let me adjust.

Add these imports in `agent/agents/navigator.ts` after line 31:

```typescript
import type { MCPTool } from '../../mcp/types';
import { jsonSchemaToZod } from '../../mcp/types';
import { MCPManager } from '../../mcp/manager';
import type { ActionSchema } from '../actions/schemas';
```

Actually, `ActionSchema` is already defined in `actions/schemas.ts`. And `Action` and `ActionResult` are already imported. Let me just add:

```typescript
import type { MCPTool } from '../../mcp/types';
import { jsonSchemaToZod } from '../../mcp/types';
import { MCPManager } from '../../mcp/manager';
```

Now, modify `NavigatorActionRegistry` to accept `context` and add `registerMCPTool`:

```typescript
export class NavigatorActionRegistry {
  private actions: Record<string, Action> = {};
  private context: AgentContext | null = null;

  constructor(actions: Action[], context?: AgentContext) {
    if (context) this.context = context;
    for (const action of actions) {
      this.registerAction(action);
    }
  }

  registerAction(action: Action): void {
    this.actions[action.name()] = action;
  }

  unregisterAction(name: string): void {
    delete this.actions[name];
  }

  getAction(name: string): Action | undefined {
    return this.actions[name];
  }

  registerMCPTool(tool: MCPTool): void {
    if (!this.context) {
      throw new Error('Cannot register MCP tool without AgentContext');
    }
    const context = this.context;
    const zodSchema = jsonSchemaToZod(tool.inputSchema);
    const actionSchema: ActionSchema = {
      name: tool.name,
      description: `[MCP] ${tool.description}`,
      schema: zodSchema,
    };
    const action = new Action(
      async (input: unknown) => {
        const inputRecord = (input || {}) as Record<string, unknown>;
        context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, `Calling MCP tool: ${tool.name}`);
        try {
          const result = await MCPManager.getInstance().executeTool(tool.name, inputRecord);
          context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, result);
          return new ActionResult({
            extractedContent: result,
            includeInMemory: true,
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, `MCP tool ${tool.name}: ${errorMsg}`);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }
      },
      actionSchema,
      false,
    );
    this.registerAction(action);
  }

  setupModelOutputSchema(): z.ZodType {
    const actionSchema = buildDynamicActionSchema(Object.values(this.actions));
    return z.object({
      current_state: agentBrainSchema,
      action: z.array(actionSchema),
    });
  }
}
```

Wait, `Actors`, `ExecutionState`, `Action`, `ActionResult`, `agentBrainSchema`, and `buildDynamicActionSchema` are already imported in navigator.ts. And `ActionSchema` comes from `../actions/schemas`. Let me double-check what's already imported:

Current imports:
```typescript
import { z } from 'zod';
import { BaseAgent, type BaseAgentOptions, type ExtraAgentOptions } from './base';
import { createLogger } from '@src/background/log';
import { ActionResult, type AgentOutput } from '../types';
import type { Action } from '../actions/builder';
import { buildDynamicActionSchema } from '../actions/builder';
import { agentBrainSchema } from '../types';
import { type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { Actors, ExecutionState } from '../event/types';
```

So `Action` is only imported as a type. I need the class too. And `ActionSchema` needs to be imported from `../actions/schemas`.

Also, I need `ActionResult` as a class (it's already imported), and `Actors`/`ExecutionState` are already imported.

Let me also add the imports:
```typescript
import { Action } from '../actions/builder';
```

Wait, `Action` is already imported as a type only. Let me change: let me import Action class from `../actions/builder` (not just type).

Actually, looking at the existing code, the `Action` import in navigator.ts is:
```typescript
import type { Action } from '../actions/builder';
```

This is a type-only import. But in my new code, I need to construct an `Action` instance. So I need to import `Action` as a value. Let me change it to:
```typescript
import { Action } from '../actions/builder';
```

And also import `ActionSchema`:
```typescript
import type { ActionSchema } from '../actions/schemas';
```

Wait, `ActionSchema` is an interface, so I should use `import type`.

Let me also add MCP imports:
```typescript
import type { MCPTool } from '../../mcp/types';
import { jsonSchemaToZod } from '../../mcp/types';
import { MCPManager } from '../../mcp/manager';
```

And change `import type { Action }` to `import { Action }`:
```typescript
import { Action } from '../actions/builder';
```

Actually wait - I need to also make sure `buildDynamicActionSchema` is still imported (it's already imported). And `ActionResult` is already imported as a value.

Let me be precise about the import changes:

Current at line 1-6:
```
import { z } from 'zod';
import { BaseAgent, type BaseAgentOptions, type ExtraAgentOptions } from './base';
import { createLogger } from '@src/background/log';
import { ActionResult, type AgentOutput } from '../types';
import type { Action } from '../actions/builder';
import { buildDynamicActionSchema } from '../actions/builder';
```

New:
```
import { z } from 'zod';
import { BaseAgent, type BaseAgentOptions, type ExtraAgentOptions } from './base';
import { createLogger } from '@src/background/log';
import { ActionResult, type AgentOutput } from '../types';
import { Action } from '../actions/builder';
import { buildDynamicActionSchema } from '../actions/builder';
import type { ActionSchema } from '../actions/schemas';
import type { MCPTool } from '../../mcp/types';
import { jsonSchemaToZod } from '../../mcp/types';
import { MCPManager } from '../../mcp/manager';
```

OK, this is getting complex. Let me simplify the plan writing. Instead of showing every import, I'll show the new method body and note what imports to add. Let me restructure the plan steps.

Actually, for the plan, I should show the complete code changes clearly. Let me organize the steps better.

For step 1, I'll show:
1. The new imports to add
2. The modified `NavigatorActionRegistry` class with the new `registerMCPTool` method

Let me write this more carefully.

- [ ] **Step 1: Add `registerMCPTool` to `NavigatorActionRegistry`**

In `agent/agents/navigator.ts`:

a) Change the import line on line 5 from:
```typescript
import type { Action } from '../actions/builder';
```
to:
```typescript
import { Action } from '../actions/builder';
```

b) Add these imports after existing imports:
```typescript
import type { ActionSchema } from '../actions/schemas';
import type { MCPTool } from '../../mcp/types';
import { jsonSchemaToZod } from '../../mcp/types';
import { MCPManager } from '../../mcp/manager';
```

c) Modify the class constructor and add `registerMCPTool` method. Replace lines 41-69 with:

Actually, let me be more surgical. Let me just show what to add and what to modify.

OK let me just write the full plan with concrete code changes. I'll be explicit.

This is getting very long and complex in my head. Let me just write it out and be done with it.<｜end▁of▁thinking｜>I realize this plan is getting complex. Let me write it out fully and precisely. This will be a substantial document.

<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="write">
<｜｜DSML｜｜parameter name="content" string="true"># Nanobrowser MCP Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MCP server support to nanobrowser's backend so agents can discover and invoke external tools from MCP servers over HTTP (hardcoded `localhost:8000`).

**Architecture:** An `MCPClient` wraps `@modelcontextprotocol/sdk` with `StreamableHTTPClientTransport`. An `MCPManager` singleton manages connections and tool aggregation. Discovered tools are converted to `Action` instances via `jsonSchemaToZod()` and registered in `NavigatorActionRegistry`. The Planner prompt gets injected MCP tool descriptions so it can reason about them in plans. The Navigator sees them through its structured output schema automatically.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, Zod, LangChain, Chrome extension service worker.

---

### Task 1: Add `@modelcontextprotocol/sdk` dependency

**Files:**
- Modify: `chrome-extension/package.json`

- [ ] **Step 1: Add the dependency**

Edit `chrome-extension/package.json`, insert `"@modelcontextprotocol/sdk": "^1.0.0"` after `"@langchain/xai"` line:

```json
    "@langchain/xai": "^0.1.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "jsonrepair": "^3.13.1",
```

- [ ] **Step 2: Install**

Run: `pnpm install` (workdir: `nanobrowser/`)

Expected: `@modelcontextprotocol/sdk` resolves and installs.

- [ ] **Step 3: Commit**

```bash
git add chrome-extension/package.json pnpm-lock.yaml
git commit -m "deps: add @modelcontextprotocol/sdk for MCP integration"
```

---

### Task 2: Create `mcp/types.ts` — types, JSON Schema → Zod converter, and prompt description builder

**Files:**
- Create: `chrome-extension/src/background/mcp/types.ts`

- [ ] **Step 1: Create the file**

```typescript
import { z } from 'zod';

export interface MCPServerConfig {
  url: string;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, { type: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
}

function buildZodProp(prop: { type: string; description?: string; enum?: string[] }): z.ZodType {
  let zodType: z.ZodType;
  switch (prop.type) {
    case 'string':
      zodType = prop.enum ? z.enum(prop.enum as [string, ...string[]]) : z.string();
      break;
    case 'number':
      zodType = z.number();
      break;
    case 'integer':
      zodType = z.number().int();
      break;
    case 'boolean':
      zodType = z.boolean();
      break;
    default:
      zodType = z.any();
  }
  if (prop.description) zodType = zodType.describe(prop.description);
  return zodType;
}

export function jsonSchemaToZod(schema: MCPTool['inputSchema']): z.ZodType {
  if (schema.type !== 'object' || !schema.properties) {
    return z.object({});
  }
  const required = schema.required || [];
  const shape: Record<string, z.ZodType> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    let zodType = buildZodProp(prop);
    if (!required.includes(key)) zodType = zodType.optional();
    shape[key] = zodType;
  }
  return z.object(shape);
}

export function buildMCPToolsDescription(tools: MCPTool[]): string {
  if (tools.length === 0) return '';
  const lines = tools.map(t => {
    const schema = t.inputSchema;
    const props = schema.properties
      ? Object.entries(schema.properties)
          .map(([k, p]) => `  ${k}: ${p.type}${schema.required?.includes(k) ? ' (required)' : ''}`)
          .join('\n')
      : '  none';
    return `- ${t.name}: ${t.description}\n  Input:\n${props}`;
  });
  return `## Available External (MCP) Tools\n${lines.join('\n')}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add chrome-extension/src/background/mcp/types.ts
git commit -m "feat: add MCP types, JSON Schema to Zod converter, and prompt builder"
```

---

### Task 3: Create `mcp/client.ts` — MCP SDK client wrapper

**Files:**
- Create: `chrome-extension/src/background/mcp/client.ts`

- [ ] **Step 1: Create the file**

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MCPTool } from './types';
import { createLogger } from '@src/background/log';

const logger = createLogger('MCPClient');

export class MCPClient {
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  private connected = false;

  constructor(url: string) {
    this.transport = new StreamableHTTPClientTransport(new URL(url));
    this.client = new Client(
      { name: 'nanobrowser', version: '1.0.0' },
      { capabilities: {} },
    );
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.client.listTools();
    return result.tools.map(t => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema as MCPTool['inputSchema'],
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.client.callTool({ name, arguments: args });
    if (result.isError) {
      const errText = result.content
        ?.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map(c => c.text)
        .join('\n') || 'Tool call failed';
      throw new Error(errText);
    }
    return result.content
      ?.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map(c => c.text)
      .join('\n') || '';
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
```

- [ ] **Step 2: Commit**

```bash
git add chrome-extension/src/background/mcp/client.ts
git commit -m "feat: add MCP client wrapper with StreamableHTTP transport"
```

---

### Task 4: Create `mcp/manager.ts` — MCP manager singleton

**Files:**
- Create: `chrome-extension/src/background/mcp/manager.ts`

- [ ] **Step 1: Create the file**

```typescript
import { MCPClient } from './client';
import type { MCPTool, MCPServerConfig } from './types';
import { createLogger } from '@src/background/log';

const logger = createLogger('MCPManager');

const DEFAULT_SERVERS: MCPServerConfig[] = [
  { url: 'http://localhost:8000' },
];

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
```

- [ ] **Step 2: Commit**

```bash
git add chrome-extension/src/background/mcp/manager.ts
git commit -m "feat: add MCP manager singleton"
```

---

### Task 5: Integrate MCP tools into NavigatorActionRegistry

**Files:**
- Modify: `chrome-extension/src/background/agent/agents/navigator.ts`

- [ ] **Step 1: Update imports**

In `navigator.ts`, change line 5 from:
```typescript
import type { Action } from '../actions/builder';
```
to:
```typescript
import { Action } from '../actions/builder';
```

Add these imports after the existing imports (after line 31, before `const logger = ...`):
```typescript
import type { ActionSchema } from '../actions/schemas';
import type { MCPTool } from '../../mcp/types';
import { jsonSchemaToZod } from '../../mcp/types';
import { MCPManager } from '../../mcp/manager';
```

- [ ] **Step 2: Modify NavigatorActionRegistry class**

Replace the existing `NavigatorActionRegistry` class (lines 41-69) with this updated version:

```typescript
export class NavigatorActionRegistry {
  private actions: Record<string, Action> = {};
  private context: AgentContext | null = null;

  constructor(actions: Action[], context?: AgentContext) {
    if (context) this.context = context;
    for (const action of actions) {
      this.registerAction(action);
    }
  }

  registerAction(action: Action): void {
    this.actions[action.name()] = action;
  }

  unregisterAction(name: string): void {
    delete this.actions[name];
  }

  getAction(name: string): Action | undefined {
    return this.actions[name];
  }

  registerMCPTool(tool: MCPTool): void {
    if (!this.context) {
      throw new Error('Cannot register MCP tool without AgentContext');
    }
    const context = this.context;
    const zodSchema = jsonSchemaToZod(tool.inputSchema);
    const actionSchema: ActionSchema = {
      name: tool.name,
      description: `[MCP] ${tool.description}`,
      schema: zodSchema,
    };
    const action = new Action(
      async (input: unknown) => {
        const inputRecord = (input || {}) as Record<string, unknown>;
        context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, `MCP: ${tool.name}`);
        try {
          const result = await MCPManager.getInstance().executeTool(tool.name, inputRecord);
          context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, `MCP: ${tool.name} returned ${result}`);
          return new ActionResult({
            extractedContent: result,
            includeInMemory: true,
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, `MCP: ${tool.name} failed: ${errorMsg}`);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }
      },
      actionSchema,
      false,
    );
    this.registerAction(action);
  }

  setupModelOutputSchema(): z.ZodType {
    const actionSchema = buildDynamicActionSchema(Object.values(this.actions));
    return z.object({
      current_state: agentBrainSchema,
      action: z.array(actionSchema),
    });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add chrome-extension/src/background/agent/agents/navigator.ts
git commit -m "feat: add MCP tool support to NavigatorActionRegistry"
```

---

### Task 6: Inject MCP tool descriptions into Planner prompt

**Files:**
- Modify: `chrome-extension/src/background/agent/prompts/planner.ts`
- Modify: `chrome-extension/src/background/agent/prompts/templates/planner.ts`

- [ ] **Step 1: Add `{{mcp_tools}}` placeholder to planner template**

In `agent/prompts/templates/planner.ts`, add this line to the end of the template string (before the closing backtick, after line 84):

Add after `  ` (line 84, before closing backtick on line 85):
```
{{mcp_tools}}
```

- [ ] **Step 2: Modify `PlannerPrompt` class to accept MCP description**

Replace the entire `agent/prompts/planner.ts` file with:

```typescript
/* eslint-disable @typescript-eslint/no-unused-vars */
import { BasePrompt } from './base';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { AgentContext } from '@src/background/agent/types';
import { plannerSystemPromptTemplate } from './templates/planner';

export class PlannerPrompt extends BasePrompt {
  private systemMessage: SystemMessage;

  constructor(mcpToolsDescription?: string) {
    super();
    const formattedPrompt = plannerSystemPromptTemplate
      .replace('{{mcp_tools}}', mcpToolsDescription || '')
      .trim();
    this.systemMessage = new SystemMessage(formattedPrompt);
  }

  getSystemMessage(): SystemMessage {
    return this.systemMessage;
  }

  async getUserMessage(context: AgentContext): Promise<HumanMessage> {
    return new HumanMessage('');
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add chrome-extension/src/background/agent/prompts/planner.ts chrome-extension/src/background/agent/prompts/templates/planner.ts
git commit -m "feat: inject MCP tool descriptions into Planner prompt"
```

---

### Task 7: Wire MCP tools through Executor

**Files:**
- Modify: `chrome-extension/src/background/agent/executor.ts`

- [ ] **Step 1: Update imports and interface**

In `executor.ts`, add this import after the existing imports (after line 27):
```typescript
import type { MCPTool } from '../mcp/types';
```

In the `ExecutorExtraArgs` interface (lines 31-36), add two new optional fields:

```typescript
export interface ExecutorExtraArgs {
  plannerLLM?: BaseChatModel;
  extractorLLM?: BaseChatModel;
  mcpTools?: MCPTool[];
  mcpToolsDescription?: string;
  agentOptions?: Partial<AgentOptions>;
  generalSettings?: GeneralSettingsConfig;
}
```

- [ ] **Step 2: Modify Executor constructor**

In the constructor (around lines 68-69), modify the prompt and registry creation:

Change:
```typescript
    this.plannerPrompt = new PlannerPrompt();
```
to:
```typescript
    this.plannerPrompt = new PlannerPrompt(extraArgs?.mcpToolsDescription);
```

And after line 72:
```typescript
    const navigatorActionRegistry = new NavigatorActionRegistry(actionBuilder.buildDefaultActions());
```
Change to:
```typescript
    const navigatorActionRegistry = new NavigatorActionRegistry(
      actionBuilder.buildDefaultActions(),
      context,
    );

    // Register MCP tools
    if (extraArgs?.mcpTools) {
      for (const tool of extraArgs.mcpTools) {
        navigatorActionRegistry.registerMCPTool(tool);
      }
    }
```

- [ ] **Step 3: Commit**

```bash
git add chrome-extension/src/background/agent/executor.ts
git commit -m "feat: wire MCP tools through Executor"
```

---

### Task 8: Initialize MCPManager and wire into setupExecutor

**Files:**
- Modify: `chrome-extension/src/background/index.ts`

- [ ] **Step 1: Add imports**

In `index.ts`, add after the existing imports (after line 20):
```typescript
import { MCPManager } from './mcp/manager';
import { buildMCPToolsDescription } from './mcp/types';
```

- [ ] **Step 2: Init MCPManager on startup**

After the `logger.info('background loaded');` line (line 55), add:
```typescript
MCPManager.getInstance().init().catch(error => {
  logger.warning('MCP manager init failed (non-fatal):', error instanceof Error ? error.message : String(error));
});
```

- [ ] **Step 3: Pass MCP tools to setupExecutor**

In the `setupExecutor` function, after the `const generalSettings = ...` block (after line 321), add:

```typescript
  const mcpManager = MCPManager.getInstance();
  const mcpTools = mcpManager.getTools();
  const mcpToolsDescription = buildMCPToolsDescription(mcpTools);
```

Then modify lines 322-333, changing:
```typescript
  const executor = new Executor(task, taskId, browserContext, navigatorLLM, {
    plannerLLM: plannerLLM ?? navigatorLLM,
    agentOptions: {
      maxSteps: generalSettings.maxSteps,
      ...
    },
    generalSettings: generalSettings,
  });
```
to:
```typescript
  const executor = new Executor(task, taskId, browserContext, navigatorLLM, {
    plannerLLM: plannerLLM ?? navigatorLLM,
    mcpTools: mcpTools.length > 0 ? mcpTools : undefined,
    mcpToolsDescription: mcpToolsDescription || undefined,
    agentOptions: {
      maxSteps: generalSettings.maxSteps,
      ...
    },
    generalSettings: generalSettings,
  });
```

- [ ] **Step 4: Commit**

```bash
git add chrome-extension/src/background/index.ts
git commit -m "feat: initialize MCPManager and wire tools into setupExecutor"
```

---

### Task 9: Update Python MCP server to use HTTP transport

**Files:**
- Modify: `mcp_hello/server.py` (at jobbot root)

- [ ] **Step 1: Change transport to HTTP**

In `mcp_hello/server.py`, change line 13 from:
```python
    mcp.run(transport="stdio")
```
to:
```python
    mcp.run(transport="streamable-http")
```

- [ ] **Step 2: Commit**

```bash
git add mcp_hello/server.py
git commit -m "feat: switch MCP server to HTTP transport for nanobrowser"
```

---

### Task 10: Verify end-to-end

- [ ] **Step 1: Start the Python MCP server**

Run: `uv run mcp_hello/server.py`

Expected: Server starts on `http://localhost:8000`.

- [ ] **Step 2: Build the extension**

Run: `pnpm build` (workdir: `nanobrowser/chrome-extension/`)

- [ ] **Step 3: Run type check**

Run: `pnpm type-check` (workdir: `nanobrowser/chrome-extension/`)

Expected: No TypeScript errors.

- [ ] **Step 4: Run existing tests**

Run: `pnpm test` (workdir: `nanobrowser/chrome-extension/`)

Expected: All tests pass (MCP server not running = no MCP tools, but shouldn't break anything).
