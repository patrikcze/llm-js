import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";

// ===========================================================================
// Tool contract
//
// Every tool the agent can call implements `Tool`. The harness guarantees:
//   - `run` only receives arguments that passed validation against `parameters`.
//   - Tools with risk "write" or "destructive" are only run after the permission
//     policy allowed them. When the policy asks a human, the harness first calls
//     `describe` so the human sees exactly what will happen.
//   - `run` must respect `ctx.signal`.
//   - Recoverable failures are thrown as `ToolError` (message shown to the model).
//     Any other exception is treated as a bug and reported as an internal error.
//   - The returned string is what the model sees. Keep it compact and self-describing.
//     A tool may instead return { text, images }: the images are shown to the model right
//     after the tool results (requires a vision-capable model).
// ===========================================================================

/** How dangerous a tool is. Drives the permission policy. */
/**
 * How dangerous a tool is. Drives the permission policy:
 *   read: runs freely · write: changes files in the workspace · destructive: deletes ·
 *   execute: runs arbitrary programs (asked in every mode except "auto").
 */
export type ToolRisk = "read" | "write" | "destructive" | "execute";

export interface ToolContext {
  /** Absolute path the filesystem tools are confined to. */
  workspace: string;
  /** Aborted when the user cancels the current run (Ctrl+C). */
  signal: AbortSignal;
}

/** What a side-effecting tool is about to do, shown to the human for approval. */
export interface ActionDescription {
  /** One line, e.g. "Edit src/app.ts (1 replacement)". */
  summary: string;
  /** Optional detail: file contents, a diff, ... */
  preview?: string;
}

/** Subset of JSON Schema the harness validates. */
export interface JSONSchema {
  type?: "object" | "string" | "integer" | "number" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean;
}

/** `Out` narrows the result type for tools that only return text. */
export interface Tool<Args = any, Out extends string | ToolOutput = string | ToolOutput> {
  /** snake_case, unique within an agent. */
  name: string;
  /** Tells the model when and how to use the tool. */
  description: string;
  /** JSON Schema of the arguments object. Must be `type: "object"`. */
  parameters: JSONSchema & { type: "object" };
  risk: ToolRisk;
  /**
   * Required when risk is not "read". Checks the arguments (throwing ToolError if the call
   * cannot succeed) and describes the effect. Must not change anything.
   */
  describe?(args: Args, ctx: ToolContext): Promise<ActionDescription>;
  run(args: Args, ctx: ToolContext): Promise<Out>;
}

/** An image for the model: base64 bytes plus their media type. */
export interface ImageData {
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
}

/** Rich tool result: text for the tool message, images shown to the model afterwards. */
export interface ToolOutput {
  text: string;
  images?: ImageData[];
}

/** A failure the model should read and recover from (bad path, not found, declined, ...). */
export class ToolError extends Error {
  override name = "ToolError";
}

export function toOpenAITool(tool: Tool): ChatCompletionFunctionTool {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters as unknown as Record<string, unknown> },
  };
}

/** Checks a tool definition against the contract. Throws on the first violation. */
export function assertValidTool(tool: Tool): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)) throw new Error(`Tool name "${tool.name}" must be snake_case`);
  if (!tool.description?.trim()) throw new Error(`Tool ${tool.name} needs a description`);
  if (tool.parameters?.type !== "object") throw new Error(`Tool ${tool.name}: parameters must be an object schema`);
  if (!["read", "write", "destructive", "execute"].includes(tool.risk)) throw new Error(`Tool ${tool.name}: invalid risk "${tool.risk}"`);
  if (typeof tool.run !== "function") throw new Error(`Tool ${tool.name}: run must be a function`);
  if (tool.risk !== "read" && typeof tool.describe !== "function") {
    throw new Error(`Tool ${tool.name}: risk "${tool.risk}" requires describe()`);
  }
  for (const r of tool.parameters.required ?? []) {
    if (!tool.parameters.properties?.[r]) throw new Error(`Tool ${tool.name}: required "${r}" is not in properties`);
  }
}

/**
 * Validates `value` against `schema`. Returns a list of human readable problems (empty = valid).
 * Small on purpose: covers what tool schemas use, so local models get precise feedback.
 */
export function validateArgs(schema: JSONSchema, value: unknown, at = "arguments"): string[] {
  const errors: string[] = [];
  const t = schema.type;
  if (t === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${at} must be an object`];
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) {
      if (obj[r] === undefined || obj[r] === null) errors.push(`${at}.${r} is required`);
    }
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k];
      if (!sub) {
        if (schema.additionalProperties === false) errors.push(`${at}.${k} is not an allowed property`);
        continue;
      }
      if (v === undefined || v === null) continue;
      errors.push(...validateArgs(sub, v, `${at}.${k}`));
    }
    return errors;
  }
  if (t === "string" && typeof value !== "string") errors.push(`${at} must be a string`);
  if (t === "boolean" && typeof value !== "boolean") errors.push(`${at} must be a boolean`);
  if (t === "number" && (typeof value !== "number" || !Number.isFinite(value))) errors.push(`${at} must be a number`);
  if (t === "integer" && !Number.isInteger(value)) errors.push(`${at} must be an integer`);
  if (t === "array") {
    if (!Array.isArray(value)) errors.push(`${at} must be an array`);
    else if (schema.items) {
      for (const [i, v] of value.entries()) errors.push(...validateArgs(schema.items, v, `${at}[${i}]`));
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at} must be <= ${schema.maximum}`);
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at} must be one of ${JSON.stringify(schema.enum)}`);
  return errors;
}

/**
 * Local models often send "5" for an integer or "true" for a boolean. Coerce those
 * obvious cases before validating, so the model is not punished for formatting.
 */
export function coerceArgs(schema: JSONSchema, value: unknown): unknown {
  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      out[k] = sub ? coerceArgs(sub, v) : v;
    }
    return out;
  }
  if (typeof value === "string") {
    if ((schema.type === "integer" || schema.type === "number") && value.trim() !== "" && !Number.isNaN(Number(value))) {
      return Number(value);
    }
    if (schema.type === "boolean" && (value === "true" || value === "false")) return value === "true";
  }
  return value;
}

/** Keeps tool output within budget, telling the model how to see the rest. */
export function truncate(text: string, max: number, hint = ""): string {
  if (text.length <= max) return text;
  const omitted = text.length - max;
  return `${text.slice(0, max)}\n\n[... truncated ${omitted} characters.${hint ? ` ${hint}` : ""}]`;
}
