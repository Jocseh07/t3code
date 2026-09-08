// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import {
  ApprovalRequestId,
  EnvironmentId,
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockPath = NodePath.join(__dirname, "../../../scripts/pi-mock-rpc.ts");

async function makeMockPiWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-adapter-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-pi.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  await NodeFSP.writeFile(
    wrapperPath,
    `#!/bin/sh\n${envExports}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockPath)} "$@"\n`,
    "utf8",
  );
  await NodeFSP.chmod(wrapperPath, 0o755);
  return { wrapperPath, dir };
}

async function makeArgsLoggingPiWrapper(dir: string, requestLog: string, argsLog: string) {
  const wrapperPath = NodePath.join(dir, "fake-pi-args.sh");
  await NodeFSP.writeFile(
    wrapperPath,
    `#!/bin/sh\nexport T3_PI_MOCK_REQUEST_LOG=${JSON.stringify(requestLog)}\nprintf '%s\\n' "$@" > ${JSON.stringify(argsLog)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockPath)} "$@"\n`,
    "utf8",
  );
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const piAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-pi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, extensionPath: string) =>
  makePiAdapter(decodePiSettings({ binaryPath }), {
    instanceId: ProviderInstanceId.make("pi"),
    extensionPath,
  }).pipe(Effect.orDie);

it.layer(piAdapterTestLayer)("PiAdapterLive", (it) => {
  it.effect("starts a session, streams a turn, and answers the T3 approval request", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-mock-thread");
      const requestLog = NodePath.join(
        yield* Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-log-"))),
        "requests.jsonl",
      );
      const { wrapperPath } = yield* Effect.promise(() =>
        makeMockPiWrapper({ T3_PI_MOCK_REQUEST_LOG: requestLog }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, "/tmp/t3-code.ts");

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const requestOpened = yield* Deferred.make<ApprovalRequestId>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (event.type === "request.opened" && event.requestId) {
            yield* Deferred.succeed(requestOpened, ApprovalRequestId.make(event.requestId));
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined);
          }
        }),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: process.cwd(),
        title: "Mock thread",
        runtimeMode: "approval-required",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "openai/gpt-5",
          options: [{ id: "thinkingLevel", value: "high" }],
        },
      });
      assert.strictEqual(session.provider, "pi");
      assert.strictEqual(session.model, "openai/gpt-5");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionFile: "/tmp/pi-mock-session.jsonl",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "hello pi", attachments: [] })
        .pipe(Effect.forkChild);

      const requestId = yield* Deferred.await(requestOpened);
      const opened = runtimeEvents.find((event) => event.type === "request.opened");
      assert.strictEqual(opened?.type, "request.opened");
      if (opened?.type === "request.opened") {
        assert.strictEqual(opened.payload.requestType, "exec_command_approval");
        assert.strictEqual(opened.payload.detail, "echo hi");
      }
      yield* adapter.respondToRequest(threadId, requestId, "accept");

      const result = yield* Fiber.join(sendTurnFiber);
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(eventsFiber);
      assert.strictEqual(result.threadId, threadId);

      const types = runtimeEvents.map((event) => event.type);
      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "thread.token-usage.updated",
        "request.opened",
        "request.resolved",
        "item.completed",
        "turn.completed",
      ] as const);
      const delta = runtimeEvents.find((event) => event.type === "content.delta");
      assert.strictEqual(delta?.type, "content.delta");
      if (delta?.type === "content.delta") {
        assert.strictEqual(delta.payload.delta, "Echo: hello pi");
      }
      const tool = runtimeEvents.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "command_execution",
      );
      assert.isDefined(tool);
      if (tool?.type === "item.completed") {
        assert.strictEqual(tool.payload.status, "completed");
      }

      const requests = yield* Effect.promise(() => readJsonLines(requestLog));
      const setModel = requests.find((request) => request.type === "set_model");
      assert.deepStrictEqual(
        { provider: setModel?.provider, modelId: setModel?.modelId },
        { provider: "openai", modelId: "gpt-5" },
      );
      assert.isTrue(
        requests.some(
          (request) => request.type === "set_thinking_level" && request.level === "high",
        ),
      );
      const prompt = requests.find((request) => request.type === "prompt");
      assert.strictEqual(prompt?.message, "hello pi");
      const uiResponse = requests.find((request) => request.type === "extension_ui_response");
      assert.deepStrictEqual(
        { id: uiResponse?.id, value: uiResponse?.value },
        { id: "ui-1", value: "accept" },
      );

      yield* adapter.stopSession(threadId);
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect("hands the thread's MCP credential to pi as environment variables", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-mcp-thread");
      const requestLog = NodePath.join(
        yield* Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-log-"))),
        "requests.jsonl",
      );
      const { wrapperPath } = yield* Effect.promise(() =>
        makeMockPiWrapper({ T3_PI_MOCK_REQUEST_LOG: requestLog }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, "/tmp/t3-code.ts");
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("env-1"),
        threadId,
        providerSessionId: "session-1",
        providerInstanceId: ProviderInstanceId.make("pi"),
        endpoint: "http://127.0.0.1:4321/mcp",
        authorizationHeader: "Bearer secret-token",
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const requests = yield* Effect.promise(() => readJsonLines(requestLog));
      const env = requests.find((request) => request.type === "mock.env");
      assert.deepStrictEqual(
        { mcpUrl: env?.mcpUrl, mcpToken: env?.mcpToken },
        { mcpUrl: "http://127.0.0.1:4321/mcp", mcpToken: "secret-token" },
      );
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("declining an approval marks the tool item failed and still completes the turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-decline-thread");
      const { wrapperPath } = yield* Effect.promise(() => makeMockPiWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath, "/tmp/t3-code.ts");

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const requestOpened = yield* Deferred.make<ApprovalRequestId>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (event.type === "request.opened" && event.requestId) {
            yield* Deferred.succeed(requestOpened, ApprovalRequestId.make(event.requestId));
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "run something", attachments: [] })
        .pipe(Effect.forkChild);
      const requestId = yield* Deferred.await(requestOpened);
      yield* adapter.respondToRequest(threadId, requestId, "decline");
      yield* Fiber.join(sendTurnFiber);
      yield* Fiber.interrupt(eventsFiber);

      const tool = runtimeEvents.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "command_execution",
      );
      assert.strictEqual(tool?.type, "item.completed");
      if (tool?.type === "item.completed") {
        assert.strictEqual(tool.payload.status, "failed");
      }
      const resolved = runtimeEvents.find((event) => event.type === "request.resolved");
      assert.strictEqual(resolved?.type, "request.resolved");
      if (resolved?.type === "request.resolved") {
        assert.strictEqual(resolved.payload.decision, "decline");
      }
      assert.isTrue(runtimeEvents.some((event) => event.type === "turn.completed"));
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("shows ask_user questions as user-input requests and answers with an option", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-question-thread");
      const requestLog = NodePath.join(
        yield* Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-log-"))),
        "requests.jsonl",
      );
      const { wrapperPath } = yield* Effect.promise(() =>
        makeMockPiWrapper({ T3_PI_MOCK_ASK_QUESTION: "1", T3_PI_MOCK_REQUEST_LOG: requestLog }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, "/tmp/t3-code.ts");
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const requested = yield* Deferred.make<{
        requestId: ApprovalRequestId;
        questionId: string;
      }>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (event.type === "user-input.requested" && event.requestId) {
            yield* Deferred.succeed(requested, {
              requestId: ApprovalRequestId.make(event.requestId),
              questionId: event.payload.questions[0]?.id ?? "",
            });
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask me", attachments: [] })
        .pipe(Effect.forkChild);
      const { requestId, questionId } = yield* Deferred.await(requested);
      const opened = runtimeEvents.find((event) => event.type === "user-input.requested");
      assert.strictEqual(opened?.type, "user-input.requested");
      if (opened?.type === "user-input.requested") {
        const question = opened.payload.questions[0];
        assert.strictEqual(question?.question, "Which color?");
        assert.deepStrictEqual(
          question?.options.map((option) => option.value),
          ["Red", "Blue"],
        );
        assert.isTrue(question?.allowCustomAnswer);
      }
      yield* adapter.respondToUserInput(threadId, requestId, { [questionId]: "Blue" });
      yield* Fiber.join(sendTurnFiber);
      yield* Fiber.interrupt(eventsFiber);

      const tool = runtimeEvents.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "dynamic_tool_call",
      );
      assert.strictEqual(tool?.type, "item.completed");
      if (tool?.type === "item.completed") {
        const data = tool.payload.data as { rawOutput?: { content?: string } };
        assert.strictEqual(data.rawOutput?.content, "User selected option 2: Blue");
      }
      assert.isTrue(runtimeEvents.some((event) => event.type === "user-input.resolved"));
      const requests = yield* Effect.promise(() => readJsonLines(requestLog));
      const uiResponses = requests.filter((request) => request.type === "extension_ui_response");
      assert.deepStrictEqual(
        uiResponses.map((request) => request.value),
        ["Blue"],
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("delivers a custom answer through the follow-up input dialog", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-question-custom-thread");
      const requestLog = NodePath.join(
        yield* Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-log-"))),
        "requests.jsonl",
      );
      const { wrapperPath } = yield* Effect.promise(() =>
        makeMockPiWrapper({ T3_PI_MOCK_ASK_QUESTION: "1", T3_PI_MOCK_REQUEST_LOG: requestLog }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, "/tmp/t3-code.ts");
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const requested = yield* Deferred.make<{
        requestId: ApprovalRequestId;
        questionId: string;
      }>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (event.type === "user-input.requested" && event.requestId) {
            yield* Deferred.succeed(requested, {
              requestId: ApprovalRequestId.make(event.requestId),
              questionId: event.payload.questions[0]?.id ?? "",
            });
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask me", attachments: [] })
        .pipe(Effect.forkChild);
      const { requestId, questionId } = yield* Deferred.await(requested);
      yield* adapter.respondToUserInput(threadId, requestId, { [questionId]: "Teal, actually" });
      yield* Fiber.join(sendTurnFiber);
      yield* Fiber.interrupt(eventsFiber);

      const tool = runtimeEvents.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "dynamic_tool_call",
      );
      assert.strictEqual(tool?.type, "item.completed");
      if (tool?.type === "item.completed") {
        const data = tool.payload.data as { rawOutput?: { content?: string } };
        assert.strictEqual(data.rawOutput?.content, "User wrote their own answer: Teal, actually");
      }
      assert.strictEqual(
        runtimeEvents.filter((event) => event.type === "user-input.requested").length,
        1,
      );
      const requests = yield* Effect.promise(() => readJsonLines(requestLog));
      const uiResponses = requests.filter((request) => request.type === "extension_ui_response");
      assert.deepStrictEqual(
        uiResponses.map((request) => request.value),
        ["__t3_other__", "Teal, actually"],
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("answers select, confirm, and input dialogs from any other extension", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-plain-dialog-thread");
      const requestLog = NodePath.join(
        yield* Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-log-"))),
        "requests.jsonl",
      );
      const { wrapperPath } = yield* Effect.promise(() =>
        makeMockPiWrapper({ T3_PI_MOCK_PLAIN_DIALOGS: "1", T3_PI_MOCK_REQUEST_LOG: requestLog }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, "/tmp/t3-code.ts");
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (event.type !== "user-input.requested" || !event.requestId) return;
          const question = event.payload.questions[0];
          if (!question) return;
          const answer =
            question.header === "Proceed?"
              ? "Yes"
              : question.options.length > 0
                ? "Fast"
                : "nightly";
          yield* adapter
            .respondToUserInput(threadId, ApprovalRequestId.make(event.requestId), {
              [question.id]: answer,
            })
            .pipe(Effect.orDie);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "run the workflow", attachments: [] });
      yield* Fiber.interrupt(eventsFiber);

      const asked = runtimeEvents.filter((event) => event.type === "user-input.requested");
      assert.strictEqual(asked.length, 3);
      const [select, confirm, input] = asked.map((event) =>
        event.type === "user-input.requested" ? event.payload.questions[0] : undefined,
      );
      assert.strictEqual(select?.question, "Pick a lane");
      assert.deepStrictEqual(
        select?.options.map((option) => option.value),
        ["Fast", "Slow"],
      );
      assert.isFalse(select?.allowCustomAnswer);
      assert.strictEqual(confirm?.question, "This runs the workflow.");
      assert.deepStrictEqual(
        confirm?.options.map((option) => option.value),
        ["Yes", "No"],
      );
      assert.strictEqual(input?.question, "Name the run");
      assert.deepStrictEqual(input?.options, []);
      assert.isTrue(input?.allowCustomAnswer);

      const tool = runtimeEvents.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "dynamic_tool_call",
      );
      assert.strictEqual(tool?.type, "item.completed");
      if (tool?.type === "item.completed") {
        const data = tool.payload.data as { rawOutput?: { content?: string } };
        assert.strictEqual(data.rawOutput?.content, "lane=Fast confirmed=true name=nightly");
      }
      const requests = yield* Effect.promise(() => readJsonLines(requestLog));
      const uiResponses = requests.filter((request) => request.type === "extension_ui_response");
      assert.deepStrictEqual(
        uiResponses.map((request) => ({ value: request.value, confirmed: request.confirmed })),
        [
          { value: "Fast", confirmed: undefined },
          { value: undefined, confirmed: true },
          { value: "nightly", confirmed: undefined },
        ],
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("expires a dialog card when pi resolves the timeout itself", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-dialog-timeout-thread");
      const requestLog = NodePath.join(
        yield* Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-log-"))),
        "requests.jsonl",
      );
      const { wrapperPath } = yield* Effect.promise(() =>
        makeMockPiWrapper({
          T3_PI_MOCK_DIALOG_TIMEOUT: "200",
          T3_PI_MOCK_REQUEST_LOG: requestLog,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, "/tmp/t3-code.ts");
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const asked = yield* Deferred.make<void>();
      const expired = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (event.type === "user-input.requested") {
            yield* Deferred.succeed(asked, undefined);
          }
          if (event.type === "user-input.resolved") {
            yield* Deferred.succeed(expired, undefined);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "run the workflow", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(asked);
      // pi gives up on its own 200ms after asking; the card follows the same clock.
      yield* TestClock.adjust(Duration.millis(200));
      yield* Deferred.await(expired);
      yield* Fiber.join(sendTurnFiber);
      yield* Fiber.interrupt(eventsFiber);

      assert.strictEqual(
        runtimeEvents.filter((event) => event.type === "user-input.requested").length,
        1,
      );
      const resolved = runtimeEvents.find((event) => event.type === "user-input.resolved");
      assert.strictEqual(resolved?.type, "user-input.resolved");
      if (resolved?.type === "user-input.resolved") {
        assert.deepStrictEqual(resolved.payload.answers, {});
      }
      const requests = yield* Effect.promise(() => readJsonLines(requestLog));
      assert.isFalse(
        requests.some((request) => request.type === "extension_ui_response"),
        "pi already gave up on the dialog; a late reply would carry a stale id",
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("interruptTurn aborts a hung prompt and settles the turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-abort-thread");
      const { wrapperPath } = yield* Effect.promise(() =>
        makeMockPiWrapper({ T3_PI_MOCK_HANG_PROMPT: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, "/tmp/t3-code.ts");
      const firstDelta = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "content.delta" ? Deferred.succeed(firstDelta, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "hang", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstDelta);
      yield* adapter.interruptTurn(threadId);
      const result = yield* Fiber.join(sendTurnFiber);
      assert.strictEqual(result.threadId, threadId);
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("a steer joins the running turn and the turn completes once pi settles", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-steer-thread");
      const requestLog = NodePath.join(
        yield* Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-log-"))),
        "requests.jsonl",
      );
      const { wrapperPath } = yield* Effect.promise(() =>
        makeMockPiWrapper({ T3_PI_MOCK_SETTLE_ON_STEER: "1", T3_PI_MOCK_REQUEST_LOG: requestLog }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, "/tmp/t3-code.ts");

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const firstDelta = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (event.type === "content.delta") {
            yield* Deferred.succeed(firstDelta, undefined);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const firstTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "first", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstDelta);
      const steerTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "second", attachments: [] })
        .pipe(Effect.forkChild);

      const first = yield* Fiber.join(firstTurnFiber);
      const steer = yield* Fiber.join(steerTurnFiber);
      yield* Fiber.interrupt(eventsFiber);

      assert.strictEqual(steer.turnId, first.turnId);
      assert.strictEqual(runtimeEvents.filter((event) => event.type === "turn.started").length, 1);
      const completed = runtimeEvents.filter((event) => event.type === "turn.completed");
      assert.strictEqual(completed.length, 1);
      assert.strictEqual(completed[0]?.type, "turn.completed");
      if (completed[0]?.type === "turn.completed") {
        assert.strictEqual(completed[0].payload.state, "completed");
      }

      const requests = yield* Effect.promise(() => readJsonLines(requestLog));
      const prompts = requests.filter((request) => request.type === "prompt");
      assert.deepStrictEqual(
        prompts.map((request) => [request.message, request.streamingBehavior]),
        [
          ["first", undefined],
          ["second", "steer"],
        ],
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("steers into a run pi started on its own and shows it as a turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-self-run-thread");
      const requestLog = NodePath.join(
        yield* Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-log-"))),
        "requests.jsonl",
      );
      const { wrapperPath } = yield* Effect.promise(() =>
        makeMockPiWrapper({ T3_PI_MOCK_SELF_RUN: "1", T3_PI_MOCK_REQUEST_LOG: requestLog }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, "/tmp/t3-code.ts");

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const syntheticTurnStarted = yield* Deferred.make<void>();
      let turnStarts = 0;
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (event.type === "turn.started" && ++turnStarts === 2) {
            yield* Deferred.succeed(syntheticTurnStarted, undefined);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const first = yield* adapter.sendTurn({ threadId, input: "first", attachments: [] });
      // pi picks work back up with no prompt from us: the adapter opens a turn
      // for it so the thread reads as running.
      yield* Deferred.await(syntheticTurnStarted);
      const second = yield* adapter.sendTurn({ threadId, input: "second", attachments: [] });
      yield* Fiber.interrupt(eventsFiber);

      assert.notStrictEqual(second.turnId, first.turnId);
      const started = runtimeEvents
        .filter((event) => event.type === "turn.started")
        .map((event) => String(event.turnId));
      const completed = runtimeEvents
        .filter((event) => event.type === "turn.completed")
        .map((event) => String(event.turnId));
      assert.deepStrictEqual(started, [String(first.turnId), started[1], String(second.turnId)]);
      assert.deepStrictEqual(completed, started);

      const requests = yield* Effect.promise(() => readJsonLines(requestLog));
      const prompts = requests.filter((request) => request.type === "prompt");
      assert.deepStrictEqual(
        prompts.map((request) => [request.message, request.streamingBehavior]),
        [
          ["first", undefined],
          ["second", "steer"],
        ],
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ends the turn as failed when pi rejects the prompt", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-rejected-prompt-thread");
      const { wrapperPath } = yield* Effect.promise(() =>
        makeMockPiWrapper({ T3_PI_MOCK_REJECT_PROMPT: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, "/tmp/t3-code.ts");

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const outcome = yield* Effect.exit(
        adapter.sendTurn({ threadId, input: "hello", attachments: [] }),
      );
      yield* Fiber.interrupt(eventsFiber);

      assert.isTrue(Exit.isFailure(outcome));
      const started = runtimeEvents.filter((event) => event.type === "turn.started");
      const completed = runtimeEvents.filter((event) => event.type === "turn.completed");
      assert.strictEqual(started.length, 1);
      assert.strictEqual(completed.length, 1);
      const failure = completed[0];
      assert.strictEqual(failure?.type, "turn.completed");
      if (failure?.type === "turn.completed") {
        assert.strictEqual(failure.turnId, started[0]?.turnId);
        assert.strictEqual(failure.payload.state, "failed");
        assert.strictEqual(failure.payload.errorMessage, "pi refused the prompt.");
      }
      // The failed turn must not stay installed as the session's active one.
      const sessions = yield* adapter.listSessions();
      assert.strictEqual(
        sessions.find((session) => session.threadId === threadId)?.activeTurnId,
        undefined,
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("resumes with --session when a resume cursor is provided", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-resume-thread");
      const { dir } = yield* Effect.promise(() => makeMockPiWrapper());
      const requestLog = NodePath.join(dir, "requests.jsonl");
      const argsLog = NodePath.join(dir, "args.txt");
      const loggingWrapper = yield* Effect.promise(() =>
        makeArgsLoggingPiWrapper(dir, requestLog, argsLog),
      );
      const adapter = yield* makeTestAdapter(loggingWrapper, "/tmp/t3-code.ts");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionFile: "/tmp/previous.jsonl" },
      });
      const args = yield* Effect.promise(() => NodeFSP.readFile(argsLog, "utf8"));
      const argv = args.split("\n");
      assert.strictEqual(argv[argv.indexOf("--session") + 1], "/tmp/previous.jsonl");
      assert.strictEqual(argv[argv.indexOf("-e") + 1], "/tmp/t3-code.ts");
      yield* adapter.stopSession(threadId);
    }),
  );
});
