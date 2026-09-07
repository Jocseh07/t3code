import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import { splitJsonlLines } from "./PiRpcClient.ts";
import { parsePiModelSlug, piModelSlug } from "./PiRpcProtocol.ts";
import {
  makePiMappingState,
  mapPiEvent,
  piToolItemType,
  piUsageToSnapshot,
} from "./PiRuntimeEvents.ts";
import { parseT3PiApprovalEnvelope, parseT3PiQuestionEnvelope } from "./piExtension.ts";

const ctx = {
  provider: ProviderDriverKind.make("pi"),
  providerInstanceId: ProviderInstanceId.make("pi"),
  threadId: ThreadId.make("thread-1"),
  turnId: TurnId.make("turn-1"),
};

function makeMapper() {
  let n = 0;
  const state = makePiMappingState(() => `item-${++n}`);
  let e = 0;
  const stamp = () => ({
    eventId: EventId.make(`event-${++e}`),
    createdAt: "2026-01-01T00:00:00Z",
  });
  return (
    event: Parameters<typeof mapPiEvent>[0]["event"],
    options?: { readonly autoCompactionEnabled?: boolean },
  ) =>
    mapPiEvent({
      event,
      stamp,
      ctx,
      state,
      contextWindow: 200_000,
      ...(options?.autoCompactionEnabled !== undefined
        ? { autoCompactionEnabled: options.autoCompactionEnabled }
        : {}),
    });
}

it("splits JSONL on LF only and strips a trailing CR", () => {
  const first = splitJsonlLines("", '{"a":1}\r\n{"b":"x\u2028y"}\n{"c"');
  assert.deepStrictEqual(first.lines, ['{"a":1}', '{"b":"x\u2028y"}']);
  assert.strictEqual(first.rest, '{"c"');
  const second = splitJsonlLines(first.rest, ":3}\n");
  assert.deepStrictEqual(second.lines, ['{"c":3}']);
  assert.strictEqual(second.rest, "");
});

it("round-trips provider/model slugs", () => {
  assert.strictEqual(
    piModelSlug({ provider: "anthropic", id: "claude-opus-4-5" }),
    "anthropic/claude-opus-4-5",
  );
  assert.deepStrictEqual(parsePiModelSlug("openai/gpt-5"), {
    provider: "openai",
    modelId: "gpt-5",
  });
  assert.deepStrictEqual(parsePiModelSlug("my-proxy/vendor/model"), {
    provider: "my-proxy",
    modelId: "vendor/model",
  });
  assert.isUndefined(parsePiModelSlug("pi-default"));
  assert.isUndefined(parsePiModelSlug("/x"));
});

it("classifies pi tool names into canonical item types", () => {
  assert.strictEqual(piToolItemType("bash"), "command_execution");
  assert.strictEqual(piToolItemType("PowerShell"), "command_execution");
  assert.strictEqual(piToolItemType("edit"), "file_change");
  assert.strictEqual(piToolItemType("write"), "file_change");
  assert.strictEqual(piToolItemType("read"), "dynamic_tool_call");
  assert.strictEqual(piToolItemType("t3_preview_snapshot"), "mcp_tool_call");
  assert.strictEqual(piToolItemType("t3_"), "dynamic_tool_call");
});

it("maps bridged t3-code tools to mcp_tool_call items carrying server and tool", () => {
  const map = makeMapper();
  const started = map({
    type: "tool_execution_start",
    toolCallId: "call-mcp",
    toolName: "t3_preview_snapshot",
    args: { tabId: "tab-1" },
  });
  assert.strictEqual(started[0]?.type, "item.started");
  if (started[0]?.type === "item.started") {
    assert.strictEqual(started[0].payload.itemType, "mcp_tool_call");
    assert.strictEqual(started[0].payload.title, "MCP tool call");
    const data = started[0].payload.data as {
      server?: string;
      tool?: string;
      toolName?: string;
      input?: unknown;
    };
    assert.deepStrictEqual(
      { server: data.server, tool: data.tool, toolName: data.toolName, input: data.input },
      {
        server: "t3-code",
        tool: "preview_snapshot",
        toolName: "t3_preview_snapshot",
        input: { tabId: "tab-1" },
      },
    );
  }
});

it("maps a streamed text block to item.started, content.delta, item.completed", () => {
  const map = makeMapper();
  const started = map({
    type: "message_update",
    assistantMessageEvent: { type: "text_start", contentIndex: 0 },
  });
  assert.strictEqual(started.length, 1);
  assert.strictEqual(started[0]?.type, "item.started");
  assert.strictEqual(started[0]?.itemId, "item-1");

  const delta = map({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" },
  });
  assert.strictEqual(delta[0]?.type, "content.delta");
  assert.strictEqual(delta[0]?.itemId, "item-1");
  if (delta[0]?.type === "content.delta") {
    assert.strictEqual(delta[0].payload.streamKind, "assistant_text");
    assert.strictEqual(delta[0].payload.delta, "Hello");
  }

  const thinking = map({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "hmm" },
  });
  if (thinking[0]?.type === "content.delta") {
    assert.strictEqual(thinking[0].payload.streamKind, "reasoning_text");
  }

  const ended = map({
    type: "message_update",
    assistantMessageEvent: { type: "text_end", contentIndex: 0 },
  });
  assert.strictEqual(ended[0]?.type, "item.completed");
  assert.strictEqual(ended[0]?.itemId, "item-1");
});

it("maps tool execution to command_execution items carrying command and output", () => {
  const map = makeMapper();
  const started = map({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "ls -la" },
  });
  assert.strictEqual(started[0]?.type, "item.started");
  if (started[0]?.type === "item.started") {
    assert.strictEqual(started[0].payload.itemType, "command_execution");
    assert.strictEqual(started[0].payload.detail, "ls -la");
    assert.deepStrictEqual((started[0].payload.data as { command?: string }).command, "ls -la");
  }
  const ended = map({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "total 0\n" }], details: {} },
    isError: false,
  });
  if (ended[0]?.type === "item.completed") {
    assert.strictEqual(ended[0].payload.status, "completed");
    assert.strictEqual(ended[0].payload.itemType, "command_execution");
    const data = ended[0].payload.data as { rawOutput?: { content?: string } };
    assert.strictEqual(data.rawOutput?.content, "total 0\n");
  }
  const failed = map({
    type: "tool_execution_end",
    toolCallId: "call-2",
    toolName: "edit",
    result: { content: [{ type: "text", text: "nope" }] },
    isError: true,
  });
  if (failed[0]?.type === "item.completed") {
    assert.strictEqual(failed[0].payload.status, "failed");
    assert.strictEqual(failed[0].payload.itemType, "file_change");
  }
});

it("emits token usage and errors from message_end", () => {
  const map = makeMapper();
  const events = map({
    type: "message_end",
    message: {
      role: "assistant",
      usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, totalTokens: 170 },
      stopReason: "error",
      errorMessage: "boom",
    },
  });
  const usage = events.find((event) => event.type === "thread.token-usage.updated");
  assert.isDefined(usage);
  if (usage?.type === "thread.token-usage.updated") {
    assert.strictEqual(usage.payload.usage.usedTokens, 170);
    assert.strictEqual(usage.payload.usage.cachedInputTokens, 50);
    assert.strictEqual(usage.payload.usage.maxTokens, 200_000);
  }
  const error = events.find((event) => event.type === "runtime.error");
  assert.isDefined(error);
  if (error?.type === "runtime.error") {
    assert.strictEqual(error.payload.message, "boom");
  }
  assert.isUndefined(piUsageToSnapshot({ input: 0, output: 0 }, { contextWindow: undefined }));
});

it("marks usage as auto-compacting when pi reports it enabled", () => {
  const map = makeMapper();
  const events = map(
    {
      type: "message_end",
      message: { role: "assistant", usage: { input: 10, output: 5, totalTokens: 15 } },
    },
    { autoCompactionEnabled: true },
  );
  const usage = events.find((event) => event.type === "thread.token-usage.updated");
  assert.isDefined(usage);
  if (usage?.type === "thread.token-usage.updated") {
    assert.strictEqual(usage.payload.usage.compactsAutomatically, true);
  }
  const plain = piUsageToSnapshot({ input: 10, output: 5 }, { contextWindow: 200_000 });
  assert.isUndefined(plain?.compactsAutomatically);
});

it("emits compacted state and post-compaction usage from compaction_end", () => {
  const map = makeMapper();
  const events = map({
    type: "compaction_end",
    reason: "threshold",
    result: { summary: "Summary", tokensBefore: 150_000, estimatedTokensAfter: 32_000 },
    aborted: false,
  });
  assert.deepStrictEqual(
    events.map((event) => event.type),
    ["item.completed", "thread.state.changed", "thread.token-usage.updated"],
  );
  const [item, compacted, usage] = events;
  if (item?.type === "item.completed") {
    assert.strictEqual(item.payload.itemType, "context_compaction");
    assert.strictEqual(item.payload.status, "completed");
  }
  if (compacted?.type === "thread.state.changed") {
    assert.strictEqual(compacted.payload.state, "compacted");
    assert.strictEqual(compacted.payload.beforeTokens, 150_000);
    assert.strictEqual(compacted.payload.afterTokens, 32_000);
  }
  if (usage?.type === "thread.token-usage.updated") {
    assert.strictEqual(usage.payload.usage.usedTokens, 32_000);
    assert.strictEqual(usage.payload.usage.lastUsedTokens, 150_000);
    assert.strictEqual(usage.payload.usage.maxTokens, 200_000);
  }
});

it("emits only a failed item when compaction is aborted or fails", () => {
  const map = makeMapper();
  const aborted = map({ type: "compaction_end", result: null, aborted: true });
  assert.deepStrictEqual(
    aborted.map((event) => event.type),
    ["item.completed"],
  );
  if (aborted[0]?.type === "item.completed") {
    assert.strictEqual(aborted[0].payload.status, "failed");
  }
  const errored = map({
    type: "compaction_end",
    result: null,
    aborted: false,
    errorMessage: "quota exceeded",
  });
  assert.deepStrictEqual(
    errored.map((event) => event.type),
    ["item.completed"],
  );
  if (errored[0]?.type === "item.completed") {
    assert.strictEqual(errored[0].payload.detail, "quota exceeded");
  }
});

it("parses only T3 approval envelopes from select titles", () => {
  const envelope = parseT3PiApprovalEnvelope(
    JSON.stringify({
      t3: "t3-approval",
      toolCallId: "c1",
      toolName: "bash",
      input: { command: "rm" },
    }),
  );
  assert.strictEqual(envelope?.toolName, "bash");
  assert.isUndefined(parseT3PiApprovalEnvelope("Allow dangerous command?"));
  assert.isUndefined(parseT3PiApprovalEnvelope(JSON.stringify({ t3: "other" })));
  assert.isUndefined(parseT3PiApprovalEnvelope("{not json"));
});

it("parses question envelopes and drops malformed options", () => {
  const question = parseT3PiQuestionEnvelope(
    JSON.stringify({
      t3: "t3-question",
      question: "Which?",
      options: [{ label: "A", description: "first" }, { label: "" }, "junk", { label: "B" }],
    }),
  );
  assert.strictEqual(question?.t3, "t3-question");
  if (question?.t3 === "t3-question") {
    assert.deepStrictEqual(question.options, [
      { label: "A", description: "first" },
      { label: "B" },
    ]);
  }
  const custom = parseT3PiQuestionEnvelope(
    JSON.stringify({ t3: "t3-question-custom", question: "Which?" }),
  );
  assert.strictEqual(custom?.t3, "t3-question-custom");
  assert.isUndefined(
    parseT3PiQuestionEnvelope(JSON.stringify({ t3: "t3-question", question: "x", options: [] })),
  );
  assert.isUndefined(
    parseT3PiQuestionEnvelope(JSON.stringify({ t3: "t3-approval", question: "x" })),
  );
});
