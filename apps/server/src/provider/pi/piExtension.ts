/**
 * piExtension — the pi extension T3 Code loads into every pi session with
 * `-e <path>`. It is shipped as a string and materialized into the state
 * directory at driver creation so the server bundle needs no asset step and
 * the user's `~/.pi/agent` is never touched.
 *
 * Two jobs:
 *   1. Approval gate. `tool_call` handlers consult `T3_PI_RUNTIME_MODE` and
 *      ask T3 through `ctx.ui.select` (an `extension_ui_request` on stdout in
 *      RPC mode) before running commands and file changes.
 *   2. T3 MCP bridge. When `T3_MCP_URL` and `T3_MCP_BEARER_TOKEN` are set,
 *      every tool on T3's MCP server is registered as a pi tool that forwards
 *      `tools/call` over HTTP, so pi gets the preview toolkit like the other
 *      providers.
 *
 * The select title is a JSON envelope `{ t3: "approval", ... }` so the
 * adapter can tell T3's own requests apart from any other extension's UI.
 *
 * @module provider/pi/piExtension
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const T3_PI_RUNTIME_MODE_ENV = "T3_PI_RUNTIME_MODE";
export const T3_PI_MCP_URL_ENV = "T3_MCP_URL";
export const T3_PI_MCP_TOKEN_ENV = "T3_MCP_BEARER_TOKEN";
export const T3_PI_APPROVAL_MARKER = "t3-approval";
/** Emitted by the user's `ask_user` extension through `ctx.ui.select` in RPC mode. */
export const T3_PI_QUESTION_MARKER = "t3-question";
/** Follow-up `ctx.ui.input` the extension raises after the user picks "write my own". */
export const T3_PI_QUESTION_CUSTOM_MARKER = "t3-question-custom";
/** Sentinel select value meaning "the user typed a custom answer". */
export const T3_PI_QUESTION_OTHER_VALUE = "__t3_other__";
export const T3_PI_EXTENSION_FILE_NAME = "t3-code.ts";
/** Every `t3-code` MCP tool is registered in pi under this prefix. */
export const T3_PI_MCP_TOOL_PREFIX = "t3_";
/**
 * Attached to `t3_preview_status` so pi appends them to its Guidelines section
 * only while the bridge is up. Mirrors the Codex browser block: the steer away
 * from other browsers must never appear when the tools are absent.
 */
export const T3_PI_BROWSER_GUIDELINES = [
  "The t3_preview_* tools are the T3 Code collaborative browser shared with the user. Prefer them for browser navigation, inspection, interaction, screenshots, and recordings.",
  "For browser work, call t3_preview_status first. If no automation-capable preview is attached, call t3_preview_open before concluding the browser is unavailable, then use t3_preview_navigate, t3_preview_snapshot, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.",
  "Do not switch to Chrome, standalone Playwright, or agent-browser merely because the preview is initially closed or a first t3_preview_* call fails. Use another browser only when the user asks for one or t3_preview_open returns an explicit unsupported or unavailable error.",
] as const;

export const T3_PI_APPROVAL_OPTIONS = ["accept", "acceptForSession", "decline"] as const;

export interface T3PiApprovalEnvelope {
  readonly t3: typeof T3_PI_APPROVAL_MARKER;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

export function parseT3PiApprovalEnvelope(title: unknown): T3PiApprovalEnvelope | undefined {
  if (typeof title !== "string" || !title.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(title);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { t3?: unknown }).t3 === T3_PI_APPROVAL_MARKER &&
      typeof (parsed as { toolCallId?: unknown }).toolCallId === "string" &&
      typeof (parsed as { toolName?: unknown }).toolName === "string"
    ) {
      return parsed as T3PiApprovalEnvelope;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export interface T3PiQuestionOption {
  readonly label: string;
  readonly description?: string;
}

export type T3PiQuestionEnvelope =
  | {
      readonly t3: typeof T3_PI_QUESTION_MARKER;
      readonly question: string;
      readonly options: ReadonlyArray<T3PiQuestionOption>;
    }
  | { readonly t3: typeof T3_PI_QUESTION_CUSTOM_MARKER; readonly question: string };

export function parseT3PiQuestionEnvelope(title: unknown): T3PiQuestionEnvelope | undefined {
  if (typeof title !== "string" || !title.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(title);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.question !== "string" || record.question.trim().length === 0) return undefined;
  if (record.t3 === T3_PI_QUESTION_CUSTOM_MARKER) {
    return { t3: T3_PI_QUESTION_CUSTOM_MARKER, question: record.question };
  }
  if (record.t3 !== T3_PI_QUESTION_MARKER || !Array.isArray(record.options)) return undefined;
  const options: Array<T3PiQuestionOption> = [];
  for (const entry of record.options) {
    if (typeof entry !== "object" || entry === null) continue;
    const option = entry as Record<string, unknown>;
    if (typeof option.label !== "string" || option.label.trim().length === 0) continue;
    options.push({
      label: option.label,
      ...(typeof option.description === "string" && option.description.trim().length > 0
        ? { description: option.description }
        : {}),
    });
  }
  if (options.length === 0) return undefined;
  return { t3: T3_PI_QUESTION_MARKER, question: record.question, options };
}

export const T3_PI_EXTENSION_SOURCE = String.raw`// Generated by T3 Code. Do not edit; it is rewritten on every server start.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RUNTIME_MODE_ENV = ${JSON.stringify(T3_PI_RUNTIME_MODE_ENV)};
const MCP_URL_ENV = ${JSON.stringify(T3_PI_MCP_URL_ENV)};
const MCP_TOKEN_ENV = ${JSON.stringify(T3_PI_MCP_TOKEN_ENV)};
const MCP_TOOL_PREFIX = ${JSON.stringify(T3_PI_MCP_TOOL_PREFIX)};
const BROWSER_GUIDELINES = ${JSON.stringify(T3_PI_BROWSER_GUIDELINES)};
const APPROVAL_MARKER = ${JSON.stringify(T3_PI_APPROVAL_MARKER)};
const OPTIONS = ${JSON.stringify(T3_PI_APPROVAL_OPTIONS)};
const FILE_CHANGE_TOOLS = new Set(["edit", "write"]);
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

type Json = Record<string, unknown>;

function stableKey(toolName: string, input: unknown): string {
  try {
    return toolName + ":" + JSON.stringify(input);
  } catch {
    return toolName + ":" + String(input);
  }
}

function firstSentence(text: string): string {
  const end = text.search(/\.\s/);
  return end === -1 ? text : text.slice(0, end + 1);
}

function needsApproval(toolName: string): boolean {
  const mode = process.env[RUNTIME_MODE_ENV] ?? "full-access";
  if (mode === "full-access") return false;
  if (READ_ONLY_TOOLS.has(toolName)) return false;
  if (mode === "auto-accept-edits" && FILE_CHANGE_TOOLS.has(toolName)) return false;
  return true;
}

async function mcpRequest(url: string, token: string, body: Json, sessionId: string | undefined) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: "Bearer " + token,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const nextSessionId = response.headers.get("mcp-session-id") ?? sessionId;
  if (response.status === 202 || response.status === 204) {
    return { result: undefined, sessionId: nextSessionId };
  }
  if (!response.ok) {
    throw new Error("T3 MCP request failed with status " + response.status);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  let message: Json | undefined;
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const parsed = JSON.parse(line.slice(5).trim()) as Json;
      if (parsed && "id" in parsed && parsed.id === body.id) {
        message = parsed;
      }
    }
  } else if (text.trim().length > 0) {
    message = JSON.parse(text) as Json;
  }
  if (message && "error" in message && message.error) {
    const error = message.error as { message?: string };
    throw new Error(error.message ?? "T3 MCP request failed.");
  }
  return { result: message ? (message.result as Json | undefined) : undefined, sessionId: nextSessionId };
}

export default async function (pi: ExtensionAPI) {
  const approvedForSession = new Set<string>();

  pi.on("tool_call", async (event, ctx) => {
    if (!needsApproval(event.toolName)) return undefined;
    const key = stableKey(event.toolName, event.input);
    if (approvedForSession.has(key)) return undefined;
    if (!ctx.hasUI) {
      return { block: true, reason: "T3 Code could not ask for approval." };
    }
    const title = JSON.stringify({
      t3: APPROVAL_MARKER,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
    });
    const choice = await ctx.ui.select(title, [...OPTIONS]);
    if (choice === "acceptForSession") {
      approvedForSession.add(key);
      return undefined;
    }
    if (choice === "accept") return undefined;
    return { block: true, reason: "Declined by the user in T3 Code." };
  });

  const url = process.env[MCP_URL_ENV];
  const token = process.env[MCP_TOKEN_ENV];
  if (!url || !token) return;

  let sessionId: string | undefined;
  let nextId = 1;
  try {
    const init = await mcpRequest(
      url,
      token,
      {
        jsonrpc: "2.0",
        id: nextId++,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t3-code-pi", version: "0.0.0" },
        },
      },
      undefined,
    );
    sessionId = init.sessionId;
    await mcpRequest(url, token, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
    const list = await mcpRequest(
      url,
      token,
      { jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} },
      sessionId,
    );
    sessionId = list.sessionId;
    const tools = Array.isArray(list.result?.tools) ? (list.result!.tools as Array<Json>) : [];
    for (const tool of tools) {
      const name = typeof tool.name === "string" ? tool.name : undefined;
      if (!name) continue;
      const description = typeof tool.description === "string" ? tool.description : name;
      pi.registerTool({
        name: MCP_TOOL_PREFIX + name,
        label: typeof tool.title === "string" ? tool.title : name,
        description,
        // One line in the system prompt's "Available tools"; the full
        // description still ships with the tool schema.
        promptSnippet: firstSentence(description),
        ...(name === "preview_status" ? { promptGuidelines: BROWSER_GUIDELINES } : {}),
        // The MCP server owns validation; pass the JSON schema through as-is.
        parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as never,
        async execute(_toolCallId, params) {
          const call = await mcpRequest(
            url,
            token,
            {
              jsonrpc: "2.0",
              id: nextId++,
              method: "tools/call",
              params: { name, arguments: params ?? {} },
            },
            sessionId,
          );
          sessionId = call.sessionId;
          const result = call.result ?? {};
          const content = Array.isArray(result.content)
            ? (result.content as Array<Json>).map((entry) =>
                entry.type === "image" && typeof entry.data === "string"
                  ? { type: "image", data: entry.data, mimeType: String(entry.mimeType ?? "image/png") }
                  : { type: "text", text: typeof entry.text === "string" ? entry.text : JSON.stringify(entry) },
              )
            : [{ type: "text", text: JSON.stringify(result) }];
          if (result.isError === true) {
            throw new Error(
              content.map((entry) => ("text" in entry ? entry.text : "")).join("\n") || "T3 tool failed.",
            );
          }
          return { content: content as never, details: result.structuredContent ?? {} };
        },
      });
    }
  } catch (error) {
    // The preview toolkit is optional; pi keeps working without it.
    console.error("[t3-code] T3 MCP bridge unavailable:", error instanceof Error ? error.message : error);
  }
}
`;

export function resolvePiExtensionDir(stateDir: string, path: Path.Path): string {
  return path.join(stateDir, "providers", "pi", "extensions");
}

/**
 * Write the extension into the state dir. Idempotent: identical content is
 * left alone so pi's module cache and file watchers stay quiet.
 */
export const materializePiExtension = Effect.fn("materializePiExtension")(function* (
  stateDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = resolvePiExtensionDir(stateDir, path);
  const filePath = path.join(directory, T3_PI_EXTENSION_FILE_NAME);
  yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
  const existing = yield* fileSystem
    .readFileString(filePath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (existing !== T3_PI_EXTENSION_SOURCE) {
    yield* fileSystem.writeFileString(filePath, T3_PI_EXTENSION_SOURCE, { mode: 0o600 });
  }
  return filePath;
});
