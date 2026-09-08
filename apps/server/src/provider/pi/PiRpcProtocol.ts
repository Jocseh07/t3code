/**
 * PiRpcProtocol — the subset of pi's `--mode rpc` JSONL protocol that T3 Code
 * speaks. Commands go to stdin, responses and events come back on stdout,
 * one JSON object per LF-terminated line.
 *
 * Only fields T3 reads are modeled. Unknown fields pass through untouched so
 * a newer pi does not break decoding.
 *
 * @see pi docs/rpc.md
 * @module provider/pi/PiRpcProtocol
 */

export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export function isPiThinkingLevel(value: unknown): value is PiThinkingLevel {
  return typeof value === "string" && (PI_THINKING_LEVELS as ReadonlyArray<string>).includes(value);
}

export interface PiImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export type PiRpcCommand =
  | {
      readonly type: "prompt";
      readonly message: string;
      readonly images?: ReadonlyArray<PiImageContent>;
      readonly streamingBehavior?: "steer" | "followUp";
    }
  | { readonly type: "abort" }
  | { readonly type: "get_state" }
  | { readonly type: "get_available_models" }
  | { readonly type: "get_available_thinking_levels" }
  | { readonly type: "get_commands" }
  | { readonly type: "get_session_stats" }
  | { readonly type: "set_model"; readonly provider: string; readonly modelId: string }
  | { readonly type: "set_thinking_level"; readonly level: PiThinkingLevel }
  | { readonly type: "set_session_name"; readonly name: string }
  | {
      readonly type: "extension_ui_response";
      readonly id: string;
      readonly value?: string;
      readonly confirmed?: boolean;
      readonly cancelled?: boolean;
    };

export interface PiModel {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Partial<Record<PiThinkingLevel, string | null>>;
  readonly contextWindow?: number;
  readonly input?: ReadonlyArray<string>;
}

export interface PiSessionState {
  readonly model: PiModel | null;
  readonly thinkingLevel: PiThinkingLevel;
  readonly isStreaming: boolean;
  readonly sessionFile?: string;
  readonly sessionId: string;
  readonly sessionName?: string;
  readonly autoCompactionEnabled?: boolean;
  readonly messageCount?: number;
}

export interface PiCommandInfo {
  readonly name: string;
  readonly description?: string;
  readonly source: "extension" | "prompt" | "skill";
  readonly sourceInfo?: {
    readonly path?: string;
    readonly scope?: string;
    readonly source?: string;
  };
}

export interface PiUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly totalTokens?: number;
}

export type PiAssistantMessageEvent =
  | { readonly type: "text_start"; readonly contentIndex: number }
  | { readonly type: "text_delta"; readonly contentIndex: number; readonly delta: string }
  | { readonly type: "text_end"; readonly contentIndex: number; readonly content?: string }
  | { readonly type: "thinking_start"; readonly contentIndex: number }
  | { readonly type: "thinking_delta"; readonly contentIndex: number; readonly delta: string }
  | { readonly type: "thinking_end"; readonly contentIndex: number; readonly content?: string }
  | {
      readonly type: "toolcall_start";
      readonly contentIndex: number;
      readonly id?: string;
      readonly toolName?: string;
    }
  | { readonly type: "toolcall_delta"; readonly contentIndex: number; readonly delta: string }
  | { readonly type: "toolcall_end"; readonly contentIndex: number; readonly toolCall?: unknown };

export interface PiAssistantMessage {
  readonly role: "assistant";
  readonly content?: ReadonlyArray<Record<string, unknown>>;
  readonly usage?: PiUsage;
  readonly stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
  readonly errorMessage?: string;
  readonly model?: string;
  readonly provider?: string;
}

export interface PiToolResultContent {
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly details?: unknown;
}

export type PiRpcEvent =
  | { readonly type: "agent_start" }
  | {
      readonly type: "agent_end";
      readonly messages?: ReadonlyArray<unknown>;
      readonly willRetry?: boolean;
    }
  | { readonly type: "agent_settled" }
  | { readonly type: "turn_start" }
  | {
      readonly type: "turn_end";
      readonly message?: unknown;
      readonly toolResults?: ReadonlyArray<unknown>;
    }
  | { readonly type: "message_start"; readonly message?: Record<string, unknown> }
  | {
      readonly type: "message_update";
      readonly usage?: PiUsage;
      readonly assistantMessageEvent: PiAssistantMessageEvent;
    }
  | { readonly type: "message_end"; readonly message?: Record<string, unknown> }
  | {
      readonly type: "tool_execution_start";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args?: unknown;
    }
  | {
      readonly type: "tool_execution_update";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args?: unknown;
      readonly partialResult?: PiToolResultContent;
    }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result?: PiToolResultContent;
      readonly isError?: boolean;
    }
  | {
      readonly type: "queue_update";
      readonly steering?: ReadonlyArray<string>;
      readonly followUp?: ReadonlyArray<string>;
    }
  | { readonly type: "compaction_start"; readonly reason?: string }
  | {
      readonly type: "compaction_end";
      readonly reason?: string;
      readonly result?: {
        readonly summary?: string;
        readonly tokensBefore?: number;
        readonly estimatedTokensAfter?: number;
      } | null;
      readonly aborted?: boolean;
      readonly willRetry?: boolean;
      readonly errorMessage?: string;
    }
  | {
      readonly type: "auto_retry_start";
      readonly attempt?: number;
      readonly maxAttempts?: number;
      readonly delayMs?: number;
      readonly errorMessage?: string;
    }
  | {
      readonly type: "auto_retry_end";
      readonly success?: boolean;
      readonly attempt?: number;
      readonly finalError?: string;
    }
  | {
      readonly type: "extension_error";
      readonly extensionPath?: string;
      readonly event?: string;
      readonly error?: string;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: string;
      readonly title?: string;
      readonly message?: string;
      readonly options?: ReadonlyArray<string>;
      readonly placeholder?: string;
      readonly prefill?: string;
      readonly timeout?: number;
      readonly notifyType?: string;
      readonly statusText?: string;
    }
  | { readonly type: string };

export interface PiRpcResponse {
  readonly type: "response";
  readonly id?: string;
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export function isPiRpcResponse(value: unknown): value is PiRpcResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "response" &&
    typeof (value as { command?: unknown }).command === "string" &&
    typeof (value as { success?: unknown }).success === "boolean"
  );
}

export function isPiRpcEvent(value: unknown): value is PiRpcEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string" &&
    (value as { type: string }).type !== "response"
  );
}

/** `provider/id` slug used throughout T3 for a pi model. */
export function piModelSlug(model: Pick<PiModel, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

/** Split a T3 slug back into pi's `{ provider, modelId }` pair. */
export function parsePiModelSlug(slug: string): { provider: string; modelId: string } | undefined {
  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return undefined;
  }
  return { provider: trimmed.slice(0, separator), modelId: trimmed.slice(separator + 1) };
}
