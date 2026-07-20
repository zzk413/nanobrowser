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
