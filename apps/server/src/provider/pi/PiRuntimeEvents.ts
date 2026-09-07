/**
 * PiRuntimeEvents — pure mappers from pi RPC events to T3's canonical
 * `ProviderRuntimeEvent`s. No process or Effect dependencies so the adapter
 * stays thin and the mapping stays unit-testable.
 *
 * @module provider/pi/PiRuntimeEvents
 */
import {
  type CanonicalItemType,
  type EventId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  type ThreadId,
  type ThreadTokenUsageSnapshot,
  type ToolLifecycleItemType,
  type TurnId,
} from "@t3tools/contracts";

import type { PiRpcEvent, PiToolResultContent, PiUsage } from "./PiRpcProtocol.ts";

export interface PiEventStamp {
  readonly eventId: EventId;
  readonly createdAt: string;
}

export interface PiEventContext {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
}

const COMMAND_TOOL_NAMES = new Set(["bash", "powershell"]);
const FILE_CHANGE_TOOL_NAMES = new Set(["edit", "write"]);
/** The T3 extension registers every `t3-code` MCP tool under this prefix. */
const T3_BRIDGE_TOOL_PREFIX = "t3_";
const T3_MCP_SERVER_NAME = "t3-code";

/** The MCP tool name behind a bridged pi tool, or undefined for pi's own tools. */
export function piBridgeToolName(toolName: string): string | undefined {
  const trimmed = toolName.trim();
  return trimmed.length > T3_BRIDGE_TOOL_PREFIX.length && trimmed.startsWith(T3_BRIDGE_TOOL_PREFIX)
    ? trimmed.slice(T3_BRIDGE_TOOL_PREFIX.length)
    : undefined;
}

/** pi's built-in tools carry stable names; anything else is a custom or extension tool. */
export function piToolItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.trim().toLowerCase();
  if (COMMAND_TOOL_NAMES.has(normalized)) return "command_execution";
  if (FILE_CHANGE_TOOL_NAMES.has(normalized)) return "file_change";
  if (piBridgeToolName(toolName) !== undefined) return "mcp_tool_call";
  return "dynamic_tool_call";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function piToolTitle(toolName: string, args: unknown): string {
  const itemType = piToolItemType(toolName);
  const input = isRecord(args) ? args : {};
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return nonEmptyString(input.path) ? `${toolName} ${String(input.path)}` : "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    default:
      return toolName;
  }
}

export function piToolDetail(toolName: string, args: unknown): string | undefined {
  const input = isRecord(args) ? args : {};
  switch (piToolItemType(toolName)) {
    case "command_execution":
      return nonEmptyString(input.command);
    case "file_change":
      return nonEmptyString(input.path);
    default: {
      const path = nonEmptyString(input.path);
      if (path) return path;
      const pattern = nonEmptyString(input.pattern);
      if (pattern) return pattern;
      return undefined;
    }
  }
}

export function piToolResultText(result: PiToolResultContent | undefined): string | undefined {
  if (!result?.content) return undefined;
  const text = result.content
    .flatMap((entry) =>
      entry.type === "text" && typeof entry.text === "string" ? [entry.text] : [],
    )
    .join("\n");
  return text.length > 0 ? text : undefined;
}

function piToolData(input: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly outputText?: string | undefined;
  readonly details?: unknown;
}): Record<string, unknown> {
  const args = isRecord(input.args) ? input.args : {};
  const bridgeTool = piBridgeToolName(input.toolName);
  return {
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    // Clients resolve labels and icons from `server` + `tool`, like Codex.
    ...(bridgeTool !== undefined ? { server: T3_MCP_SERVER_NAME, tool: bridgeTool } : {}),
    input: args,
    ...(piToolItemType(input.toolName) === "command_execution" && nonEmptyString(args.command)
      ? { command: args.command }
      : {}),
    ...(input.outputText !== undefined ? { rawOutput: { content: input.outputText } } : {}),
    ...(isRecord(input.details) && typeof input.details.patch === "string"
      ? { patch: input.details.patch }
      : {}),
  };
}

function baseEvent(stamp: PiEventStamp, ctx: PiEventContext) {
  return {
    ...stamp,
    provider: ctx.provider,
    providerInstanceId: ctx.providerInstanceId,
    threadId: ctx.threadId,
    ...(ctx.turnId !== undefined ? { turnId: ctx.turnId } : {}),
  };
}

function raw(method: string, payload: unknown) {
  return { raw: { source: "pi.rpc" as const, method, payload } };
}

export interface PiContextInfo {
  readonly contextWindow: number | undefined;
  readonly autoCompactionEnabled?: boolean | undefined;
}

function contextSnapshotFields(
  info: PiContextInfo,
): Pick<ThreadTokenUsageSnapshot, "maxTokens" | "compactsAutomatically"> {
  return {
    ...(info.contextWindow !== undefined && info.contextWindow > 0
      ? { maxTokens: info.contextWindow }
      : {}),
    ...(info.autoCompactionEnabled === true ? { compactsAutomatically: true } : {}),
  };
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function piUsageToSnapshot(
  usage: PiUsage | undefined,
  info: PiContextInfo,
): ThreadTokenUsageSnapshot | undefined {
  if (!usage) return undefined;
  const input = usage.input ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const output = usage.output ?? 0;
  const usedTokens = input + cacheRead + cacheWrite + output;
  if (usedTokens <= 0 && (usage.totalTokens ?? 0) <= 0) return undefined;
  return {
    usedTokens: usage.totalTokens ?? usedTokens,
    inputTokens: input + cacheRead + cacheWrite,
    cachedInputTokens: cacheRead,
    outputTokens: output,
    lastInputTokens: input + cacheRead + cacheWrite,
    lastCachedInputTokens: cacheRead,
    lastOutputTokens: output,
    ...contextSnapshotFields(info),
  };
}

export interface PiMappingState {
  /** Content index → synthetic item id for the assistant text block being streamed. */
  readonly openTextItems: Map<number, string>;
  /** Tool call id → tool name and args for `tool_execution_*` correlation. */
  readonly tools: Map<string, { readonly toolName: string; readonly args: unknown }>;
  /** Item id of the compaction in progress, so its end closes what its start opened. */
  compactionItemId: string | undefined;
  nextSyntheticId: () => string;
}

export function makePiMappingState(nextSyntheticId: () => string): PiMappingState {
  return {
    openTextItems: new Map(),
    tools: new Map(),
    compactionItemId: undefined,
    nextSyntheticId,
  };
}

/**
 * Map one pi event to zero or more canonical runtime events. Turn lifecycle
 * (`turn.started` / `turn.completed`) is owned by the adapter because it
 * depends on prompt bookkeeping, not on the event stream alone.
 */
export function mapPiEvent(input: {
  readonly event: PiRpcEvent;
  readonly stamp: () => PiEventStamp;
  readonly ctx: PiEventContext;
  readonly state: PiMappingState;
  readonly contextWindow: number | undefined;
  readonly autoCompactionEnabled?: boolean | undefined;
}): ReadonlyArray<ProviderRuntimeEvent> {
  const { event, ctx, state } = input;
  const stamp = input.stamp;
  const contextInfo: PiContextInfo = {
    contextWindow: input.contextWindow,
    autoCompactionEnabled: input.autoCompactionEnabled,
  };

  switch (event.type) {
    case "message_update": {
      if (!("assistantMessageEvent" in event)) return [];
      const delta = event.assistantMessageEvent;
      switch (delta.type) {
        case "text_start": {
          const itemId = state.nextSyntheticId();
          state.openTextItems.set(delta.contentIndex, itemId);
          return [
            {
              type: "item.started",
              ...baseEvent(stamp(), ctx),
              itemId: RuntimeItemId.make(itemId),
              payload: { itemType: "assistant_message", status: "inProgress" },
            },
          ];
        }
        case "text_delta": {
          const itemId = state.openTextItems.get(delta.contentIndex);
          if (delta.delta.length === 0) return [];
          return [
            {
              type: "content.delta",
              ...baseEvent(stamp(), ctx),
              ...(itemId ? { itemId: RuntimeItemId.make(itemId) } : {}),
              payload: {
                streamKind: "assistant_text",
                delta: delta.delta,
                contentIndex: delta.contentIndex,
              },
            },
          ];
        }
        case "text_end": {
          const itemId = state.openTextItems.get(delta.contentIndex);
          state.openTextItems.delete(delta.contentIndex);
          if (!itemId) return [];
          return [
            {
              type: "item.completed",
              ...baseEvent(stamp(), ctx),
              itemId: RuntimeItemId.make(itemId),
              payload: { itemType: "assistant_message", status: "completed" },
            },
          ];
        }
        case "thinking_delta": {
          if (delta.delta.length === 0) return [];
          return [
            {
              type: "content.delta",
              ...baseEvent(stamp(), ctx),
              payload: {
                streamKind: "reasoning_text",
                delta: delta.delta,
                contentIndex: delta.contentIndex,
              },
            },
          ];
        }
        default:
          return [];
      }
    }

    case "tool_execution_start": {
      if (!("toolCallId" in event) || !("toolName" in event)) return [];
      state.tools.set(event.toolCallId, { toolName: event.toolName, args: event.args });
      return [
        {
          type: "item.started",
          ...baseEvent(stamp(), ctx),
          itemId: RuntimeItemId.make(event.toolCallId),
          payload: {
            itemType: piToolItemType(event.toolName),
            status: "inProgress",
            title: piToolTitle(event.toolName, event.args),
            ...(piToolDetail(event.toolName, event.args)
              ? { detail: piToolDetail(event.toolName, event.args) }
              : {}),
            data: piToolData({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
            }),
          },
          ...raw("tool_execution_start", event),
        },
      ];
    }

    case "tool_execution_update": {
      if (!("toolCallId" in event) || !("toolName" in event)) return [];
      const known = state.tools.get(event.toolCallId);
      const args = event.args ?? known?.args;
      const outputText = piToolResultText(event.partialResult);
      const itemType = piToolItemType(event.toolName);
      const events: Array<ProviderRuntimeEvent> = [
        {
          type: "item.updated",
          ...baseEvent(stamp(), ctx),
          itemId: RuntimeItemId.make(event.toolCallId),
          payload: {
            itemType,
            status: "inProgress",
            title: piToolTitle(event.toolName, args),
            ...(piToolDetail(event.toolName, args)
              ? { detail: piToolDetail(event.toolName, args) }
              : {}),
            data: piToolData({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args,
              outputText,
            }),
          },
        },
      ];
      return events;
    }

    case "tool_execution_end": {
      if (!("toolCallId" in event) || !("toolName" in event)) return [];
      const known = state.tools.get(event.toolCallId);
      state.tools.delete(event.toolCallId);
      const args = known?.args;
      const outputText = piToolResultText(event.result);
      const itemType: CanonicalItemType = piToolItemType(event.toolName);
      return [
        {
          type: "item.completed",
          ...baseEvent(stamp(), ctx),
          itemId: RuntimeItemId.make(event.toolCallId),
          payload: {
            itemType,
            status: event.isError === true ? "failed" : "completed",
            title: piToolTitle(event.toolName, args),
            ...(piToolDetail(event.toolName, args)
              ? { detail: piToolDetail(event.toolName, args) }
              : {}),
            data: piToolData({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args,
              outputText,
              details: event.result?.details,
            }),
          },
          ...raw("tool_execution_end", event),
        },
      ];
    }

    case "message_end": {
      if (!("message" in event) || !isRecord(event.message)) return [];
      const message = event.message;
      if (message.role !== "assistant") return [];
      const events: Array<ProviderRuntimeEvent> = [];
      // Close any text block whose `text_end` never arrived.
      for (const itemId of state.openTextItems.values()) {
        events.push({
          type: "item.completed",
          ...baseEvent(stamp(), ctx),
          itemId: RuntimeItemId.make(itemId),
          payload: { itemType: "assistant_message", status: "completed" },
        });
      }
      state.openTextItems.clear();
      const usage = piUsageToSnapshot(
        isRecord(message.usage) ? (message.usage as PiUsage) : undefined,
        contextInfo,
      );
      if (usage) {
        events.push({
          type: "thread.token-usage.updated",
          ...baseEvent(stamp(), ctx),
          payload: { usage },
        });
      }
      if (message.stopReason === "error") {
        events.push({
          type: "runtime.error",
          ...baseEvent(stamp(), ctx),
          payload: {
            message: nonEmptyString(message.errorMessage) ?? "pi reported an error.",
            class: "provider_error",
          },
          ...raw("message_end", message),
        });
      }
      return events;
    }

    case "compaction_start": {
      state.compactionItemId = state.nextSyntheticId();
      return [
        {
          type: "item.started",
          ...baseEvent(stamp(), ctx),
          itemId: RuntimeItemId.make(state.compactionItemId),
          payload: {
            itemType: "context_compaction",
            status: "inProgress",
            title: "Compacting context",
          },
          ...raw("compaction_start", event),
        },
      ];
    }

    case "compaction_end": {
      // pi omits `result` when the compaction was aborted or errored, which is
      // exactly when the started item most needs closing.
      const result = "result" in event ? event.result : undefined;
      const aborted = "aborted" in event ? event.aborted : undefined;
      const errorMessage = "errorMessage" in event ? event.errorMessage : undefined;
      const failed = aborted === true || result === null || result === undefined;
      const summary = result?.summary;
      const itemId = state.compactionItemId ?? state.nextSyntheticId();
      state.compactionItemId = undefined;
      const events: Array<ProviderRuntimeEvent> = [
        {
          type: "item.completed",
          ...baseEvent(stamp(), ctx),
          itemId: RuntimeItemId.make(itemId),
          payload: {
            itemType: "context_compaction",
            status: failed ? "failed" : "completed",
            title: "Compacted context",
            ...(nonEmptyString(errorMessage) ? { detail: errorMessage } : {}),
            ...(summary ? { data: { summary } } : {}),
          },
          ...raw("compaction_end", event),
        },
      ];
      if (failed) return events;
      const beforeTokens = finiteNonNegative(result?.tokensBefore);
      const afterTokens = finiteNonNegative(result?.estimatedTokensAfter);
      events.push({
        type: "thread.state.changed",
        ...baseEvent(stamp(), ctx),
        payload: {
          state: "compacted",
          ...(beforeTokens !== undefined ? { beforeTokens } : {}),
          ...(afterTokens !== undefined ? { afterTokens } : {}),
        },
        ...raw("compaction_end", event),
      });
      // pi only reports a heuristic estimate until the next assistant reply;
      // publishing it keeps the meter from showing the pre-compaction size.
      if (afterTokens !== undefined) {
        events.push({
          type: "thread.token-usage.updated",
          ...baseEvent(stamp(), ctx),
          payload: {
            usage: {
              usedTokens: afterTokens,
              ...(beforeTokens !== undefined ? { lastUsedTokens: beforeTokens } : {}),
              ...contextSnapshotFields(contextInfo),
            },
          },
        });
      }
      return events;
    }

    case "auto_retry_start": {
      // `attempt` is optional in pi's payload; a retry is still a retry.
      const attempt = ("attempt" in event ? event.attempt : undefined) ?? 1;
      const max = ("maxAttempts" in event ? event.maxAttempts : undefined) ?? attempt;
      const retryError = "errorMessage" in event ? event.errorMessage : undefined;
      return [
        {
          type: "runtime.warning",
          ...baseEvent(stamp(), ctx),
          payload: {
            message: `pi is retrying after a transient error (attempt ${attempt} of ${max}).`,
            ...(nonEmptyString(retryError) ? { detail: retryError } : {}),
          },
          ...raw("auto_retry_start", event),
        },
      ];
    }

    case "auto_retry_end": {
      if (!("success" in event) || event.success !== false) return [];
      return [
        {
          type: "runtime.error",
          ...baseEvent(stamp(), ctx),
          payload: {
            message: nonEmptyString(event.finalError) ?? "pi gave up retrying.",
            class: "provider_error",
          },
          ...raw("auto_retry_end", event),
        },
      ];
    }

    case "extension_error": {
      if (!("error" in event)) return [];
      return [
        {
          type: "runtime.warning",
          ...baseEvent(stamp(), ctx),
          payload: {
            message: `pi extension error: ${nonEmptyString(event.error) ?? "unknown"}`,
            ...(nonEmptyString(event.extensionPath) ? { detail: event.extensionPath } : {}),
          },
          ...raw("extension_error", event),
        },
      ];
    }

    default:
      return [];
  }
}
