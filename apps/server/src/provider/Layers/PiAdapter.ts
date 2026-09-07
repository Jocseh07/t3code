/**
 * PiAdapter — pi (`pi --mode rpc`) behind the generic `ProviderAdapterShape`.
 *
 * One pi process per thread. Turns are `prompt` commands; a `prompt` sent
 * while pi's agent loop runs becomes a steer, including when that loop is work
 * pi started on its own (a background terminal exiting, a subagent finishing),
 * which shows up as a synthetic turn. Approvals arrive as
 * `extension_ui_request` (method `select`) from the T3 extension and are
 * answered with `extension_ui_response`. The pi session file is the resume
 * cursor so a restarted server can `--session <file>` back into history.
 *
 * @module provider/Layers/PiAdapter
 */
import {
  ApprovalRequestId,
  EventId,
  PI_DEFAULT_MODEL,
  type PiSettings,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { type PiRpcClient, spawnPiRpcClient } from "../pi/PiRpcClient.ts";
import {
  isPiThinkingLevel,
  parsePiModelSlug,
  type PiImageContent,
  type PiModel,
  type PiRpcEvent,
  type PiSessionState,
  piModelSlug,
} from "../pi/PiRpcProtocol.ts";
import { makePiMappingState, mapPiEvent, type PiMappingState } from "../pi/PiRuntimeEvents.ts";
import {
  parseT3PiApprovalEnvelope,
  parseT3PiQuestionEnvelope,
  T3_PI_MCP_TOKEN_ENV,
  T3_PI_QUESTION_CUSTOM_MARKER,
  T3_PI_QUESTION_OTHER_VALUE,
  T3_PI_MCP_URL_ENV,
  T3_PI_RUNTIME_MODE_ENV,
} from "../pi/piExtension.ts";
import { buildPiEnvironment, PI_REASONING_OPTION_ID, piLaunchArgv } from "./PiProvider.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const PI_RESUME_VERSION = 1 as const;
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface PiAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  /** Absolute path of the materialized T3 extension, passed to pi with `-e`. */
  readonly extensionPath: string;
}

interface PendingApproval {
  readonly uiRequestId: string;
  readonly toolCallId: string;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly uiRequestId: string;
  readonly optionLabels: ReadonlyArray<string>;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers | undefined>;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly client: PiRpcClient;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  /** Free-text answer held for the extension's follow-up `input` dialog. */
  pendingCustomAnswer: { readonly question: string; readonly text: string } | undefined;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly mapping: PiMappingState;
  activeTurnId: TurnId | undefined;
  currentModel: PiModel | null;
  currentThinkingLevel: string | undefined;
  autoCompactionEnabled: boolean | undefined;
  /** The `prompt` commands in flight; only the last one settles the turn. */
  promptsInFlight: number;
  /**
   * True between pi's `agent_start` and `agent_settled`. pi also runs without
   * a prompt from us (background terminal exits, subagent results), so this is
   * the only reliable answer to "is pi busy right now".
   */
  agentRunning: boolean;
  /** Turn opened for a run pi started on its own; the next prompt closes it. */
  syntheticTurnId: TurnId | undefined;
  /** Shared by every prompt in flight: pi settles a steered run once. */
  turnSettled: Deferred.Deferred<void> | undefined;
  /** Last assistant `stopReason` seen during the active turn. */
  lastStopReason: string | undefined;
  stopped: boolean;
}

interface PiResumeCursor {
  readonly schemaVersion: typeof PI_RESUME_VERSION;
  readonly sessionFile: string;
}

function parsePiResume(raw: unknown): PiResumeCursor | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as { schemaVersion?: unknown; sessionFile?: unknown };
  return record.schemaVersion === PI_RESUME_VERSION && typeof record.sessionFile === "string"
    ? { schemaVersion: PI_RESUME_VERSION, sessionFile: record.sessionFile }
    : undefined;
}

export function makePiAdapter(piSettings: PiSettings, options: PiAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("pi");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger = options.nativeEventLogger;

    const sessions = new Map<ThreadId, PiSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate pi runtime identifier.",
            cause,
          }),
      ),
    );
    const makeEventStamp = () =>
      Effect.all({ eventId: Effect.map(randomUUIDv4, EventId.make), createdAt: nowIso });
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = current.get(threadId);
        if (existing) return Effect.succeed([existing, current] as const);
        return Semaphore.make(1).pipe(
          Effect.map((semaphore) => {
            const next = new Map(current);
            next.set(threadId, semaphore);
            return [semaphore, next] as const;
          }),
        );
      });
    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<PiSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const settlePendingApprovalsAsCancelled = (ctx: PiSessionContext) =>
      Effect.forEach(
        Array.from(ctx.pendingApprovals.values()),
        (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.asVoid),
        { discard: true },
      ).pipe(
        Effect.andThen(
          Effect.forEach(
            Array.from(ctx.pendingUserInputs.values()),
            (pending) => Deferred.succeed(pending.answers, undefined).pipe(Effect.asVoid),
            { discard: true },
          ),
        ),
      );

    const stopSessionInternal = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx);
        if (ctx.turnSettled) {
          yield* Deferred.succeed(ctx.turnSettled, undefined);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    /** Apply a T3 model selection to the running pi session. Sentinel keeps pi's own choice. */
    const applyModelSelection = (
      ctx: PiSessionContext,
      modelSelection: { readonly model: string; readonly options?: unknown } | undefined,
    ) =>
      Effect.gen(function* () {
        if (!modelSelection) return;
        const requestedSlug = modelSelection.model.trim();
        const currentSlug = ctx.currentModel ? piModelSlug(ctx.currentModel) : undefined;
        if (requestedSlug && requestedSlug !== PI_DEFAULT_MODEL && requestedSlug !== currentSlug) {
          const parsed = parsePiModelSlug(requestedSlug);
          if (!parsed) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "set_model",
              issue: `pi model ids look like 'provider/model', got '${requestedSlug}'.`,
            });
          }
          const response = yield* ctx.client.request({
            type: "set_model",
            provider: parsed.provider,
            modelId: parsed.modelId,
          });
          ctx.currentModel = (response.data as PiModel | undefined) ?? null;
        }
        const requestedLevel = getModelSelectionStringOptionValue(
          modelSelection as never,
          PI_REASONING_OPTION_ID,
        );
        if (
          requestedLevel &&
          isPiThinkingLevel(requestedLevel) &&
          requestedLevel !== ctx.currentThinkingLevel
        ) {
          yield* ctx.client.request({ type: "set_thinking_level", level: requestedLevel });
          ctx.currentThinkingLevel = requestedLevel;
        }
      });

    /**
     * A `t3-question` select from the user's `ask_user` extension. Shown as a
     * T3 question card; an answer that is not one of the offered labels is
     * held and delivered through the extension's follow-up `input` dialog.
     */
    const handleQuestionRequest = (
      ctx: PiSessionContext,
      event: Extract<PiRpcEvent, { type: "extension_ui_request" }>,
      envelope: Extract<ReturnType<typeof parseT3PiQuestionEnvelope>, { t3: "t3-question" }>,
    ) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const runtimeRequestId = RuntimeRequestId.make(requestId);
        const answers = yield* Deferred.make<ProviderUserInputAnswers | undefined>();
        const optionLabels = envelope.options.map((option) => option.label);
        ctx.pendingUserInputs.set(requestId, { uiRequestId: event.id, optionLabels, answers });
        const questionId = event.id;
        yield* offerRuntimeEvent({
          type: "user-input.requested",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          requestId: runtimeRequestId,
          payload: {
            questions: [
              {
                id: questionId,
                header: "Question",
                question: envelope.question,
                options: envelope.options.map((option) => ({
                  label: option.label,
                  description: option.description ?? option.label,
                  value: option.label,
                })),
                allowCustomAnswer: true,
                multiSelect: false,
              },
            ],
          },
          raw: { source: "pi.rpc", method: "extension_ui_request", payload: event },
        });

        yield* Effect.gen(function* () {
          const resolved = yield* Deferred.await(answers);
          ctx.pendingUserInputs.delete(requestId);
          const rawAnswer = resolved?.[questionId];
          const answer =
            typeof rawAnswer === "string"
              ? rawAnswer.trim()
              : Array.isArray(rawAnswer) && typeof rawAnswer[0] === "string"
                ? rawAnswer[0].trim()
                : "";
          if (resolved === undefined || answer.length === 0) {
            yield* ctx.client
              .notify({ type: "extension_ui_response", id: event.id, cancelled: true })
              .pipe(Effect.ignore);
          } else if (optionLabels.includes(answer)) {
            yield* ctx.client
              .notify({ type: "extension_ui_response", id: event.id, value: answer })
              .pipe(Effect.ignore);
          } else {
            ctx.pendingCustomAnswer = { question: envelope.question, text: answer };
            yield* ctx.client
              .notify({
                type: "extension_ui_response",
                id: event.id,
                value: T3_PI_QUESTION_OTHER_VALUE,
              })
              .pipe(Effect.ignore);
          }
          yield* offerRuntimeEvent({
            type: "user-input.resolved",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            requestId: runtimeRequestId,
            payload: { answers: resolved ?? {} },
          });
        }).pipe(Effect.forkIn(ctx.scope));
      });

    const handleExtensionUiRequest = (
      ctx: PiSessionContext,
      event: Extract<PiRpcEvent, { type: "extension_ui_request" }>,
    ) =>
      Effect.gen(function* () {
        const question = parseT3PiQuestionEnvelope(event.title);
        if (question?.t3 === "t3-question" && event.method === "select") {
          return yield* handleQuestionRequest(ctx, event, question);
        }
        if (question?.t3 === T3_PI_QUESTION_CUSTOM_MARKER && event.method === "input") {
          const held = ctx.pendingCustomAnswer;
          ctx.pendingCustomAnswer = undefined;
          yield* ctx.client
            .notify(
              held && held.question === question.question
                ? { type: "extension_ui_response", id: event.id, value: held.text }
                : { type: "extension_ui_response", id: event.id, cancelled: true },
            )
            .pipe(Effect.ignore);
          return;
        }
        const envelope = parseT3PiApprovalEnvelope(event.title);
        if (event.method !== "select" || !envelope) {
          // Another extension's dialog. Cancel it so pi does not hang waiting on us.
          if (
            event.method === "select" ||
            event.method === "confirm" ||
            event.method === "input" ||
            event.method === "editor"
          ) {
            yield* ctx.client.notify({
              type: "extension_ui_response",
              id: event.id,
              cancelled: true,
            });
          }
          return;
        }
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const runtimeRequestId = RuntimeRequestId.make(requestId);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();
        ctx.pendingApprovals.set(requestId, {
          uiRequestId: event.id,
          toolCallId: envelope.toolCallId,
          decision,
        });
        const input = envelope.input as Record<string, unknown> | undefined;
        const command = typeof input?.command === "string" ? input.command : undefined;
        const filePath = typeof input?.path === "string" ? input.path : undefined;
        const isCommand = envelope.toolName === "bash" || envelope.toolName === "powershell";
        const isFileChange = envelope.toolName === "edit" || envelope.toolName === "write";
        yield* offerRuntimeEvent({
          type: "request.opened",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          itemId: RuntimeItemId.make(envelope.toolCallId),
          requestId: runtimeRequestId,
          payload: {
            requestType: isCommand
              ? "exec_command_approval"
              : isFileChange
                ? "file_change_approval"
                : "dynamic_tool_call",
            detail: command ?? filePath ?? envelope.toolName,
            options: [
              { decision: "accept", label: "Allow" },
              { decision: "acceptForSession", label: "Allow for this session" },
              { decision: "decline", label: "Deny" },
            ],
            args: { toolName: envelope.toolName, input: envelope.input },
          },
          raw: { source: "pi.rpc", method: "extension_ui_request", payload: event },
        });

        // Resolve off the event loop so the stream keeps flowing while we wait.
        yield* Effect.gen(function* () {
          const resolved = yield* Deferred.await(decision);
          ctx.pendingApprovals.delete(requestId);
          const value =
            resolved === "accept" || resolved === "acceptAlways"
              ? "accept"
              : resolved === "acceptForSession"
                ? "acceptForSession"
                : "decline";
          yield* ctx.client
            .notify({ type: "extension_ui_response", id: event.id, value })
            .pipe(Effect.ignore);
          yield* offerRuntimeEvent({
            type: "request.resolved",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            requestId: runtimeRequestId,
            payload: {
              requestType: isCommand
                ? "exec_command_approval"
                : isFileChange
                  ? "file_change_approval"
                  : "dynamic_tool_call",
              decision: resolved,
            },
          });
          if (resolved === "cancel") {
            yield* ctx.client.request({ type: "abort" }).pipe(Effect.ignore);
          }
        }).pipe(Effect.forkIn(ctx.scope));
      });

    /** Ends `turnId`, clears the active-turn state, and reports how it ended. */
    const completeTurn = (ctx: PiSessionContext, turnId: TurnId, stopReason: string | undefined) =>
      Effect.gen(function* () {
        ctx.activeTurnId = undefined;
        ctx.syntheticTurnId = undefined;
        ctx.turnSettled = undefined;
        ctx.lastStopReason = undefined;
        ctx.session = { ...ctx.session, activeTurnId: undefined, updatedAt: yield* nowIso };
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId,
          payload: ctx.stopped
            ? { state: "interrupted", stopReason: "session_exited" }
            : stopReason === "aborted"
              ? { state: "cancelled", stopReason }
              : stopReason === "error"
                ? { state: "failed", stopReason, errorMessage: "pi reported an error." }
                : { state: "completed", stopReason: stopReason ?? null },
        });
      });

    /**
     * Opens a turn for work pi started on its own, so the thread shows as
     * running instead of hanging the output off the turn that just finished.
     */
    const startSyntheticTurn = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        const turnId = TurnId.make(yield* randomUUIDv4);
        ctx.activeTurnId = turnId;
        ctx.syntheticTurnId = turnId;
        ctx.lastStopReason = undefined;
        ctx.session = { ...ctx.session, activeTurnId: turnId, updatedAt: yield* nowIso };
        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId,
          payload: {
            ...(ctx.currentModel ? { model: piModelSlug(ctx.currentModel) } : {}),
            ...(ctx.currentThinkingLevel ? { effort: ctx.currentThinkingLevel } : {}),
          },
          raw: { source: "pi.rpc", method: "pi/synthetic-turn-start", payload: {} },
        });
      });

    const consumeEvents = (ctx: PiSessionContext) =>
      Stream.fromQueue(ctx.client.events).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            yield* logNative(ctx.threadId, event.type, event);
            if (event.type === "extension_ui_request" && "id" in event && "method" in event) {
              yield* handleExtensionUiRequest(
                ctx,
                event as Extract<PiRpcEvent, { type: "extension_ui_request" }>,
              );
              return;
            }
            if (event.type === "agent_start") {
              ctx.agentRunning = true;
              if (ctx.promptsInFlight === 0 && !ctx.activeTurnId) {
                yield* startSyntheticTurn(ctx);
              }
              return;
            }
            // `agent_end` can still be followed by retries, compaction, or
            // queued steers; only `agent_settled` means the run is over.
            if (event.type === "agent_settled") {
              ctx.agentRunning = false;
              if (ctx.turnSettled) {
                yield* Deferred.succeed(ctx.turnSettled, undefined);
              } else if (ctx.syntheticTurnId) {
                yield* completeTurn(ctx, ctx.syntheticTurnId, ctx.lastStopReason);
              }
              return;
            }
            if (event.type === "message_end" && "message" in event) {
              const message = event.message as { role?: unknown; stopReason?: unknown } | undefined;
              if (message?.role === "assistant" && typeof message.stopReason === "string") {
                ctx.lastStopReason = message.stopReason;
              }
            }
            // One UUID per pi event; mapped runtime events derive unique ids
            // by suffix so the mapper stays synchronous and pure.
            const createdAt = yield* nowIso;
            const baseId = yield* randomUUIDv4;
            let sequence = 0;
            const mapped = mapPiEvent({
              event,
              stamp: () => ({
                eventId: EventId.make(sequence++ === 0 ? baseId : `${baseId}-${sequence}`),
                createdAt,
              }),
              ctx: {
                provider: PROVIDER,
                providerInstanceId: boundInstanceId,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
              },
              state: ctx.mapping,
              contextWindow: ctx.currentModel?.contextWindow,
              autoCompactionEnabled: ctx.autoCompactionEnabled,
            });
            for (const runtimeEvent of mapped) {
              yield* offerRuntimeEvent(runtimeEvent);
            }
          }),
        ),
        Effect.catch((cause) => Effect.logError("Failed to process pi runtime event.", { cause })),
      );

    const consumeStderr = (ctx: PiSessionContext) =>
      Stream.fromQueue(ctx.client.stderrLines).pipe(
        Stream.runForEach((line) => logNative(ctx.threadId, "process/stderr", { line })),
        Effect.ignore,
      );

    const watchExit = (ctx: PiSessionContext) =>
      Deferred.await(ctx.client.exited).pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            if (ctx.stopped) return;
            ctx.stopped = true;
            ctx.agentRunning = false;
            yield* settlePendingApprovalsAsCancelled(ctx);
            if (ctx.turnSettled) {
              yield* Deferred.succeed(ctx.turnSettled, undefined);
            } else if (ctx.syntheticTurnId) {
              yield* completeTurn(ctx, ctx.syntheticTurnId, undefined);
            }
            sessions.delete(ctx.threadId);
            ctx.session = {
              ...ctx.session,
              status: code === 0 ? "closed" : "error",
              activeTurnId: undefined,
              updatedAt: yield* nowIso,
              ...(code === 0 ? {} : { lastError: `pi exited with code ${code}.` }),
            };
            yield* offerRuntimeEvent({
              type: "session.exited",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: ctx.threadId,
              payload: {
                exitKind: code === 0 ? "graceful" : "error",
                ...(code === 0 ? {} : { reason: `pi exited with code ${code}.` }),
              },
            });
          }),
        ),
      );

    const startSession: PiAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }
          const cwd = path.resolve(input.cwd.trim());
          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const syntheticItemSeed = yield* randomUUIDv4;
          let syntheticItemCounter = 0;
          const resume = parsePiResume(input.resumeCursor);
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const env: NodeJS.ProcessEnv = {
            ...buildPiEnvironment(piSettings, options.environment ?? process.env),
            [T3_PI_RUNTIME_MODE_ENV]: input.runtimeMode,
            ...(mcpSession
              ? {
                  [T3_PI_MCP_URL_ENV]: mcpSession.endpoint,
                  [T3_PI_MCP_TOKEN_ENV]: mcpSession.authorizationHeader.replace(/^Bearer\s+/i, ""),
                }
              : {}),
          };
          const args = [
            "--mode",
            "rpc",
            "-e",
            options.extensionPath,
            ...(resume ? ["--session", resume.sessionFile] : []),
            ...(input.title?.trim() && !resume ? ["--name", input.title.trim()] : []),
            ...piLaunchArgv(piSettings),
          ];

          const client = yield* spawnPiRpcClient({
            binaryPath: piSettings.binaryPath || "pi",
            args,
            cwd,
            env,
            threadId: input.threadId,
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
            Effect.provideService(Scope.Scope, sessionScope),
          );

          const ctx: PiSessionContext = {
            threadId: input.threadId,
            session: {
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              status: "connecting",
              runtimeMode: input.runtimeMode,
              cwd,
              threadId: input.threadId,
              createdAt: "",
              updatedAt: "",
            },
            scope: sessionScope,
            client,
            pendingApprovals: new Map(),
            pendingUserInputs: new Map(),
            pendingCustomAnswer: undefined,
            turns: [],
            mapping: makePiMappingState(() => `pi-${syntheticItemSeed}-${++syntheticItemCounter}`),
            activeTurnId: undefined,
            currentModel: null,
            currentThinkingLevel: undefined,
            autoCompactionEnabled: undefined,
            promptsInFlight: 0,
            agentRunning: false,
            syntheticTurnId: undefined,
            turnSettled: undefined,
            lastStopReason: undefined,
            stopped: false,
          };

          yield* consumeEvents(ctx).pipe(Effect.forkIn(sessionScope));
          yield* consumeStderr(ctx).pipe(Effect.forkIn(sessionScope));
          yield* watchExit(ctx).pipe(Effect.forkIn(sessionScope));

          const state = (yield* client.request({ type: "get_state" }, { timeoutMs: 30_000 }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: `pi did not start: ${cause.detail}`,
                  cause,
                }),
            ),
          )).data as PiSessionState;
          ctx.currentModel = state.model;
          ctx.currentThinkingLevel = state.thinkingLevel;
          ctx.autoCompactionEnabled = state.autoCompactionEnabled;
          yield* applyModelSelection(ctx, modelSelection);

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model:
              modelSelection?.model ??
              (ctx.currentModel ? piModelSlug(ctx.currentModel) : undefined),
            threadId: input.threadId,
            ...(state.sessionFile
              ? {
                  resumeCursor: {
                    schemaVersion: PI_RESUME_VERSION,
                    sessionFile: state.sessionFile,
                  } satisfies PiResumeCursor,
                }
              : {}),
            createdAt: now,
            updatedAt: now,
          };
          ctx.session = session;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: { resume: session.resumeCursor },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: { state: "ready", reason: "pi session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: { providerThreadId: state.sessionId },
          });
          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const steering = ctx.promptsInFlight > 0;
        const turnId =
          (steering ? ctx.activeTurnId : undefined) ?? TurnId.make(yield* randomUUIDv4);
        ctx.promptsInFlight += 1;

        return yield* Effect.gen(function* () {
          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          yield* applyModelSelection(ctx, modelSelection);

          const text = input.input?.trim() ?? "";
          const images: Array<PiImageContent> = [];
          for (const attachment of input.attachments ?? []) {
            // pi ingests images only. Generic files reach the agent through
            // the path line ProviderService puts in the prompt.
            if (
              attachment.type !== "image" ||
              !SUPPORTED_IMAGE_MIME_TYPES.has(attachment.mimeType)
            ) {
              continue;
            }
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "prompt",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "prompt",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            images.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }
          if (!text && images.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }

          // A run pi started on its own is still displayed as a turn. The
          // user's message closes it and opens its own turn, the way the
          // Claude adapter treats its synthetic turns.
          if (ctx.syntheticTurnId) {
            yield* completeTurn(ctx, ctx.syntheticTurnId, undefined);
          }

          ctx.activeTurnId = turnId;
          // pi runs a steer inside the same agent loop and emits one
          // `agent_settled` for the whole run, so every prompt fiber waits on
          // the same signal. Replacing it would orphan the first prompt.
          const settled =
            steering && ctx.turnSettled ? ctx.turnSettled : yield* Deferred.make<void>();
          ctx.turnSettled = settled;
          ctx.session = { ...ctx.session, activeTurnId: turnId, updatedAt: yield* nowIso };

          if (!steering) {
            ctx.lastStopReason = undefined;
            yield* offerRuntimeEvent({
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: input.threadId,
              turnId,
              payload: {
                ...(ctx.currentModel ? { model: piModelSlug(ctx.currentModel) } : {}),
                ...(ctx.currentThinkingLevel ? { effort: ctx.currentThinkingLevel } : {}),
              },
            });
          }

          // pi rejects a bare `prompt` while its agent loop runs, and the loop
          // may be running work we never asked for. `agent_start` can also
          // still be in flight when we write, so a rejection retries as a
          // steer rather than losing the message.
          const prompt = {
            type: "prompt" as const,
            message: text || "See the attached image.",
            ...(images.length > 0 ? { images } : {}),
          };
          const piBusy = steering || ctx.agentRunning;
          yield* ctx.client
            .request({ ...prompt, ...(piBusy ? { streamingBehavior: "steer" as const } : {}) })
            .pipe(
              Effect.catchIf(
                (error) => !piBusy && /already processing/i.test(error.detail),
                () => ctx.client.request({ ...prompt, streamingBehavior: "steer" as const }),
              ),
            );

          const turnRecord = ctx.turns.find((turn) => turn.id === turnId);
          const item = { prompt: text, imageCount: images.length };
          if (turnRecord) turnRecord.items.push(item);
          else ctx.turns.push({ id: turnId, items: [item] });

          // Wait until pi settles (agent_settled) or the session dies.
          if (!ctx.stopped) {
            yield* Deferred.await(settled);
          }

          if (ctx.promptsInFlight === 1) {
            yield* completeTurn(ctx, turnId, ctx.lastStopReason);
            // pi settled our turn and went straight back to work of its own.
            // The `agent_start` branch could not open a turn for it while this
            // prompt was still in flight, so it happens here instead.
            if (ctx.agentRunning && !ctx.stopped) {
              yield* startSyntheticTurn(ctx);
            }
          }

          return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
            }),
          ),
        );
      });

    const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePendingApprovalsAsCancelled(ctx);
        yield* ctx.client.request({ type: "abort" }).pipe(Effect.ignore);
      });

    const respondToRequest: PiAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: PiAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: PiAdapterShape["readThread"] = (threadId) =>
      Effect.map(requireSession(threadId), (ctx) => ({ threadId, turns: ctx.turns }));

    const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
        return { threadId, turns: ctx.turns };
      });

    const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(threadId, Effect.flatMap(requireSession(threadId), stopSessionInternal));

    const listSessions: PiAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const stopAll: PiAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit pi session shutdown event.", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies PiAdapterShape;
  });
}
