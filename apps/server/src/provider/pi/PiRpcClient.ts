/**
 * PiRpcClient — one `pi --mode rpc` child process.
 *
 * Framing follows pi's RPC contract: split stdout on `\n` only, strip one
 * trailing `\r`, never use a generic line reader. Commands carry an `id` so
 * responses correlate; events are published to a queue for the adapter.
 *
 * @module provider/pi/PiRpcClient
 */
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { ProviderAdapterProcessError, ProviderAdapterRequestError } from "../Errors.ts";
import {
  isPiRpcEvent,
  isPiRpcResponse,
  type PiRpcCommand,
  type PiRpcEvent,
  type PiRpcResponse,
} from "./PiRpcProtocol.ts";

const PROVIDER_LABEL = "pi";
const encoder = new TextEncoder();
const decodeUnknownJsonStringExit = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export interface PiRpcSpawnInput {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly threadId: string;
}

export interface PiRpcClient {
  readonly request: (
    command: PiRpcCommand,
    options?: { readonly timeoutMs?: number },
  ) => Effect.Effect<PiRpcResponse, ProviderAdapterRequestError>;
  /** Fire-and-forget write, used for `extension_ui_response`. */
  readonly notify: (command: PiRpcCommand) => Effect.Effect<void, ProviderAdapterRequestError>;
  readonly events: Queue.Dequeue<PiRpcEvent, Cause.Done<void>>;
  readonly stderrLines: Queue.Dequeue<string, Cause.Done<void>>;
  /** Resolves once the child exits, with its exit code. */
  readonly exited: Deferred.Deferred<number>;
  readonly pid: number | undefined;
}

/** Split a UTF-8 chunk stream into LF-delimited lines, dropping a trailing CR. */
export function splitJsonlLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const combined = buffer + chunk;
  const parts = combined.split("\n");
  const rest = parts.pop() ?? "";
  const lines = parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  return { lines, rest };
}

export const spawnPiRpcClient = Effect.fn("spawnPiRpcClient")(function* (
  input: PiRpcSpawnInput,
): Effect.fn.Return<
  PiRpcClient,
  ProviderAdapterProcessError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const spawnCommand = yield* resolveSpawnCommand(input.binaryPath, input.args, {
    env: input.env,
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: input.cwd,
        env: input.env,
        extendEnv: false,
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER_LABEL,
            threadId: input.threadId,
            detail: `Failed to spawn pi (${input.binaryPath}): ${cause.message}`,
            cause,
          }),
      ),
    );

  const events = yield* Queue.unbounded<PiRpcEvent, Cause.Done<void>>();
  const stderrLines = yield* Queue.unbounded<string, Cause.Done<void>>();
  const exited = yield* Deferred.make<number>();
  const pending = new Map<string, Deferred.Deferred<PiRpcResponse, ProviderAdapterRequestError>>();
  const stdinQueue = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const nextIdRef = yield* Ref.make(0);

  const failAllPending = (detail: string) =>
    Effect.forEach(
      Array.from(pending.entries()),
      ([id, deferred]) =>
        Deferred.fail(
          deferred,
          new ProviderAdapterRequestError({
            provider: PROVIDER_LABEL,
            method: `rpc#${id}`,
            detail,
          }),
        ).pipe(Effect.asVoid),
      { discard: true },
    ).pipe(Effect.tap(() => Effect.sync(() => pending.clear())));

  yield* Stream.fromQueue(stdinQueue).pipe(Stream.run(child.stdin), Effect.forkIn(scope));

  const handleLine = (line: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (line.trim().length === 0) return;
      const decoded = decodeUnknownJsonStringExit(line);
      if (!Exit.isSuccess(decoded)) {
        yield* Queue.offer(stderrLines, `[pi stdout, not JSON] ${line.slice(0, 500)}`);
        return;
      }
      const parsed = decoded.value;
      if (isPiRpcResponse(parsed)) {
        const id = parsed.id;
        const deferred = id !== undefined ? pending.get(id) : undefined;
        if (deferred) {
          pending.delete(id!);
          yield* Deferred.succeed(deferred, parsed);
        }
        return;
      }
      if (isPiRpcEvent(parsed)) {
        yield* Queue.offer(events, parsed);
      }
    });

  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.runFoldEffect(
      (): string => "",
      (buffer: string, chunk: string) =>
        Effect.gen(function* () {
          const { lines, rest } = splitJsonlLines(buffer, chunk);
          yield* Effect.forEach(lines, handleLine, { discard: true });
          return rest;
        }),
    ),
    Effect.flatMap((rest) => (rest.length > 0 ? handleLine(rest) : Effect.void)),
    Effect.ignore,
    Effect.forkIn(scope),
  );

  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runFoldEffect(
      (): string => "",
      (buffer: string, chunk: string) =>
        Effect.gen(function* () {
          const { lines, rest } = splitJsonlLines(buffer, chunk);
          yield* Effect.forEach(
            lines.filter((line) => line.trim().length > 0),
            (line) => Queue.offer(stderrLines, line),
            { discard: true },
          );
          return rest;
        }),
    ),
    Effect.ignore,
    Effect.forkIn(scope),
  );

  yield* child.exitCode.pipe(
    Effect.map(Number),
    Effect.orElseSucceed(() => -1),
    Effect.flatMap((code) =>
      Deferred.succeed(exited, code).pipe(
        Effect.andThen(failAllPending(`pi exited with code ${code} before responding.`)),
        Effect.andThen(Queue.end(events)),
      ),
    ),
    Effect.forkIn(scope),
  );

  yield* Scope.addFinalizer(
    scope,
    Effect.gen(function* () {
      yield* Queue.end(stdinQueue).pipe(Effect.ignore);
      yield* failAllPending("pi session closed.");
      yield* child.kill({ forceKillAfter: "1 second" }).pipe(Effect.ignore);
    }),
  );

  const writeLine = (
    payload: Record<string, unknown>,
  ): Effect.Effect<void, ProviderAdapterRequestError> =>
    Effect.gen(function* () {
      if (yield* Deferred.isDone(exited)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER_LABEL,
          method: String(payload.type ?? "rpc"),
          detail: "pi process has exited.",
        });
      }
      yield* Queue.offer(stdinQueue, encoder.encode(`${encodeUnknownJsonString(payload)}\n`));
    });

  const request: PiRpcClient["request"] = (command, options) =>
    Effect.gen(function* () {
      const id = `t3-${yield* Ref.updateAndGet(nextIdRef, (n) => n + 1)}`;
      const deferred = yield* Deferred.make<PiRpcResponse, ProviderAdapterRequestError>();
      pending.set(id, deferred);
      yield* writeLine({ id, ...command }).pipe(
        Effect.tapError(() => Effect.sync(() => pending.delete(id))),
      );
      const response = yield* Deferred.await(deferred).pipe(
        Effect.timeoutOrElse({
          duration: options?.timeoutMs ?? 60_000,
          orElse: () =>
            Effect.sync(() => pending.delete(id)).pipe(
              Effect.andThen(
                new ProviderAdapterRequestError({
                  provider: PROVIDER_LABEL,
                  method: command.type,
                  detail: `pi did not answer '${command.type}' in time.`,
                }),
              ),
            ),
        }),
      );
      if (!response.success) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER_LABEL,
          method: command.type,
          detail: response.error ?? `pi rejected '${command.type}'.`,
        });
      }
      return response;
    });

  const notify: PiRpcClient["notify"] = (command) => writeLine({ ...command });

  return {
    request,
    notify,
    events,
    stderrLines,
    exited,
    pid: child.pid,
  } satisfies PiRpcClient;
});
