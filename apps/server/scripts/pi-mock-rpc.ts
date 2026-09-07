#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Minimal stand-in for `pi --mode rpc`, used by the pi adapter and provider
 * tests. It speaks the same LF-delimited JSONL protocol and replays a small
 * scripted turn: assistant text, one bash tool call gated by an
 * `extension_ui_request`, then `agent_end` and `agent_settled`.
 *
 * Environment toggles:
 *   T3_PI_MOCK_NO_MODELS=1        report no authenticated models
 *   T3_PI_MOCK_REQUEST_LOG=<path> append every received command as JSONL, preceded by
 *                                 one `mock.env` line with the T3 MCP env pi was given
 *   T3_PI_MOCK_HANG_PROMPT=1      never settle a prompt (for abort tests)
 *   T3_PI_MOCK_ASK_QUESTION=1     replace the bash tool with an ask_user-style question
 *   T3_PI_MOCK_SETTLE_ON_STEER=1  hold the first prompt open until a second `prompt`
 *                                 arrives, then settle the run once (for steer tests)
 *   T3_PI_MOCK_REJECT_PROMPT=1    reject every `prompt` command (for turn-failure tests)
 *   T3_PI_MOCK_SELF_RUN=1         settle the first prompt immediately, then start one run
 *                                 nobody asked for (what a background terminal exit or a
 *                                 finished subagent does), held open until a prompt arrives
 *
 * Like the real pi, a `prompt` that arrives while the agent loop runs is
 * rejected unless it carries `streamingBehavior`.
 */
import * as NodeFS from "node:fs";

const args = process.argv.slice(2);
const requestLog = process.env.T3_PI_MOCK_REQUEST_LOG;
const noModels = process.env.T3_PI_MOCK_NO_MODELS === "1";
const hangPrompt = process.env.T3_PI_MOCK_HANG_PROMPT === "1";
const askQuestion = process.env.T3_PI_MOCK_ASK_QUESTION === "1";
const settleOnSteer = process.env.T3_PI_MOCK_SETTLE_ON_STEER === "1";
const selfRun = process.env.T3_PI_MOCK_SELF_RUN === "1";
const rejectPrompt = process.env.T3_PI_MOCK_REJECT_PROMPT === "1";

if (args.includes("--version")) {
  process.stdout.write("0.84.4\n");
  process.exit(0);
}

if (args.includes("-p")) {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    prompt += chunk;
  });
  process.stdin.on("end", () => {
    const wantsTitle = /title/i.test(prompt);
    const wantsBranch = /branch name|"branch"/i.test(prompt);
    const wantsPr = /pull request|"title"[\s\S]*"body"/i.test(prompt);
    const output =
      wantsTitle && !wantsPr
        ? { title: "Mock pi title" }
        : wantsBranch && !wantsPr
          ? { branch: "mock-pi-branch" }
          : wantsPr && !/subject/i.test(prompt)
            ? { title: "Mock PR title", body: "Mock PR body" }
            : {
                subject: "feat: mock pi commit",
                body: "Body from mock pi.",
                branch: "mock-branch",
              };
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.exit(0);
  });
} else {
  runRpc();
}

function runRpc() {
  if (requestLog) {
    NodeFS.appendFileSync(
      requestLog,
      `${JSON.stringify({
        type: "mock.env",
        mcpUrl: process.env.T3_MCP_URL ?? null,
        mcpToken: process.env.T3_MCP_BEARER_TOKEN ?? null,
      })}\n`,
    );
  }
  const sessionFile = process.env.T3_PI_MOCK_SESSION_FILE ?? "/tmp/pi-mock-session.jsonl";
  const models = noModels
    ? []
    : [
        {
          id: "claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          provider: "anthropic",
          reasoning: true,
          thinkingLevelMap: { xhigh: null, max: null },
          contextWindow: 200000,
          input: ["text", "image"],
        },
        {
          id: "gpt-5",
          name: "GPT-5",
          provider: "openai",
          reasoning: true,
          contextWindow: 272000,
          input: ["text"],
        },
      ];
  let model = models[0] ?? null;
  let thinkingLevel = "medium";
  let streaming = false;
  let sessionName = args.includes("--name") ? args[args.indexOf("--name") + 1] : undefined;
  const send = (payload: Record<string, unknown>) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };
  const respond = (id: string | undefined, command: string, data?: unknown) =>
    send({
      ...(id ? { id } : {}),
      type: "response",
      command,
      success: true,
      ...(data !== undefined ? { data } : {}),
    });
  let pendingUi: { id: string; resolve: (value: string | undefined) => void } | undefined;
  let pendingSteer: (() => void) | undefined;
  let uiCounter = 0;
  const askUi = (request: Record<string, unknown>) =>
    new Promise<string | undefined>((resolve) => {
      const id = `ui-${++uiCounter}`;
      pendingUi = { id, resolve };
      send({ type: "extension_ui_request", id, ...request });
    });

  const runQuestion = async () => {
    const toolCallId = "call_ask_1";
    const question = "Which color?";
    const options = [{ label: "Red", description: "Warm" }, { label: "Blue" }];
    send({
      type: "tool_execution_start",
      toolCallId,
      toolName: "ask_user",
      args: { question, options },
    });
    const choice = await askUi({
      method: "select",
      title: JSON.stringify({ t3: "t3-question", question, options }),
      options: [...options.map((option) => option.label), "__t3_other__"],
    });
    let text: string;
    if (choice === undefined) {
      text = "User dismissed the question without answering.";
    } else if (choice === "__t3_other__") {
      const custom = await askUi({
        method: "input",
        title: JSON.stringify({ t3: "t3-question-custom", question }),
        placeholder: "Your answer",
      });
      text = custom
        ? `User wrote their own answer: ${custom}`
        : "User dismissed the question without answering.";
    } else {
      text = `User selected option ${options.findIndex((option) => option.label === choice) + 1}: ${choice}`;
    }
    send({
      type: "tool_execution_end",
      toolCallId,
      toolName: "ask_user",
      result: { content: [{ type: "text", text }], details: {} },
      isError: false,
    });
  };

  let selfRunStarted = false;
  /** A run pi starts on its own, held open until a prompt steers into it. */
  const startSelfRun = async () => {
    selfRunStarted = true;
    streaming = true;
    send({ type: "agent_start" });
    send({ type: "turn_start" });
    send({ type: "message_start", message: { role: "assistant", content: [] } });
    send({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    send({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Background work" },
    });
    send({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Background work" },
    });
    await new Promise<void>((resolve) => {
      pendingSteer = resolve;
    });
    send({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Background work" }],
        stopReason: "stop",
      },
    });
    send({ type: "turn_end", message: {}, toolResults: [] });
    send({ type: "agent_end", messages: [], willRetry: false });
    send({ type: "agent_settled" });
    streaming = false;
  };

  const runPrompt = async (message: string) => {
    streaming = true;
    send({ type: "agent_start" });
    send({ type: "turn_start" });
    send({ type: "message_start", message: { role: "assistant", content: [] } });
    send({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    send({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `Echo: ${message}` },
    });
    send({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: `Echo: ${message}` },
    });
    send({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Echo: ${message}` }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
        stopReason: "toolUse",
      },
    });
    if (hangPrompt) return;

    if (selfRun) {
      send({ type: "turn_end", message: {}, toolResults: [] });
      send({ type: "agent_end", messages: [], willRetry: false });
      send({ type: "agent_settled" });
      streaming = false;
      if (!selfRunStarted) void startSelfRun();
      return;
    }

    if (settleOnSteer) {
      await new Promise<void>((resolve) => {
        pendingSteer = resolve;
      });
      send({ type: "turn_end", message: {}, toolResults: [] });
      send({ type: "agent_end", messages: [], willRetry: false });
      send({ type: "agent_settled" });
      streaming = false;
      return;
    }

    if (askQuestion) {
      await runQuestion();
      send({ type: "turn_end", message: {}, toolResults: [] });
      send({ type: "agent_end", messages: [], willRetry: false });
      send({ type: "agent_settled" });
      streaming = false;
      return;
    }

    const toolCallId = "call_mock_1";
    const toolArgs = { command: "echo hi" };
    const choice = await askUi({
      method: "select",
      title: JSON.stringify({ t3: "t3-approval", toolCallId, toolName: "bash", input: toolArgs }),
      options: ["accept", "acceptForSession", "decline"],
    });
    send({ type: "tool_execution_start", toolCallId, toolName: "bash", args: toolArgs });
    if (choice === "accept" || choice === "acceptForSession") {
      send({
        type: "tool_execution_update",
        toolCallId,
        toolName: "bash",
        args: toolArgs,
        partialResult: { content: [{ type: "text", text: "hi" }] },
      });
      send({
        type: "tool_execution_end",
        toolCallId,
        toolName: "bash",
        result: { content: [{ type: "text", text: "hi\n" }], details: {} },
        isError: false,
      });
    } else {
      send({
        type: "tool_execution_end",
        toolCallId,
        toolName: "bash",
        result: { content: [{ type: "text", text: "Declined by the user in T3 Code." }] },
        isError: true,
      });
    }
    send({ type: "turn_end", message: {}, toolResults: [] });
    send({ type: "agent_end", messages: [], willRetry: false });
    send({ type: "agent_settled" });
    streaming = false;
  };

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (!line.trim()) continue;
      const command = JSON.parse(line) as Record<string, unknown>;
      if (requestLog) NodeFS.appendFileSync(requestLog, `${JSON.stringify(command)}\n`);
      const id = typeof command.id === "string" ? command.id : undefined;
      switch (command.type) {
        case "get_state":
          respond(id, "get_state", {
            model,
            thinkingLevel,
            isStreaming: streaming,
            isCompacting: false,
            steeringMode: "one-at-a-time",
            followUpMode: "one-at-a-time",
            sessionFile,
            sessionId: "mock-session-id",
            ...(sessionName ? { sessionName } : {}),
            autoCompactionEnabled: true,
            messageCount: 0,
            pendingMessageCount: 0,
          });
          break;
        case "get_available_models":
          respond(id, "get_available_models", { models });
          break;
        case "get_available_thinking_levels":
          respond(id, "get_available_thinking_levels", {
            levels: ["off", "low", "medium", "high"],
          });
          break;
        case "get_commands":
          respond(id, "get_commands", {
            commands: [
              {
                name: "fix-tests",
                description: "Fix failing tests",
                source: "prompt",
                sourceInfo: { path: "/p/fix-tests.md", scope: "project" },
              },
              {
                name: "skill:brave-search",
                description: "Web search",
                source: "skill",
                sourceInfo: { path: "/u/skills/brave-search/SKILL.md", scope: "user" },
              },
              { name: "llama", description: "Manage llama.cpp", source: "extension" },
            ],
          });
          break;
        case "set_model": {
          const next = models.find(
            (m) => m.provider === command.provider && m.id === command.modelId,
          );
          if (!next) {
            send({
              ...(id ? { id } : {}),
              type: "response",
              command: "set_model",
              success: false,
              error: `Model not found: ${String(command.provider)}/${String(command.modelId)}`,
            });
            break;
          }
          model = next;
          respond(id, "set_model", model);
          break;
        }
        case "set_thinking_level":
          thinkingLevel = String(command.level);
          respond(id, "set_thinking_level");
          break;
        case "set_session_name":
          sessionName = String(command.name);
          respond(id, "set_session_name");
          break;
        case "prompt":
          if (rejectPrompt) {
            send({
              ...(id ? { id } : {}),
              type: "response",
              command: "prompt",
              success: false,
              error: "pi refused the prompt.",
            });
            break;
          }
          if (streaming && typeof command.streamingBehavior !== "string") {
            send({
              ...(id ? { id } : {}),
              type: "response",
              command: "prompt",
              success: false,
              error:
                "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
            });
            break;
          }
          respond(id, "prompt");
          if (streaming && pendingSteer) {
            const resolve = pendingSteer;
            pendingSteer = undefined;
            resolve();
            break;
          }
          void runPrompt(String(command.message));
          break;
        case "abort":
          respond(id, "abort");
          if (streaming) {
            streaming = false;
            send({
              type: "message_end",
              message: { role: "assistant", content: [], stopReason: "aborted" },
            });
            send({ type: "agent_end", messages: [], willRetry: false });
            send({ type: "agent_settled" });
          }
          break;
        case "extension_ui_response":
          if (pendingUi && pendingUi.id === command.id) {
            const resolve = pendingUi.resolve;
            pendingUi = undefined;
            resolve(command.cancelled === true ? undefined : (command.value as string | undefined));
          }
          break;
        default:
          send({
            ...(id ? { id } : {}),
            type: "response",
            command: String(command.type),
            success: false,
            error: `Unknown command: ${String(command.type)}`,
          });
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
