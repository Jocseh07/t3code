/**
 * PiProvider — health check, model catalog, and command discovery for the pi
 * driver. Every probe runs the user's `pi` binary; nothing here opens a
 * session that could bill a model call.
 *
 * @module provider/Layers/PiProvider
 */
import {
  type CustomModelSetting,
  type ModelCapabilities,
  PI_DEFAULT_MODEL,
  type PiSettings,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  type ProviderAdapterProcessError,
  type ProviderAdapterRequestError,
  ProviderDriverError,
} from "../Errors.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type ServerProviderDraft,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import { spawnPiRpcClient } from "../pi/PiRpcClient.ts";
import {
  PI_THINKING_LEVELS,
  type PiCommandInfo,
  type PiModel,
  piModelSlug,
  type PiSessionState,
  type PiThinkingLevel,
} from "../pi/PiRpcProtocol.ts";

export const PI_PRESENTATION = {
  displayName: "pi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;

export const PI_REASONING_OPTION_ID = "thinkingLevel";
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const VERSION_PROBE_TIMEOUT_MS = 6_000;
const RPC_PROBE_TIMEOUT_MS = 20_000;

const PI_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: PI_DEFAULT_MODEL,
    name: "pi default",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

function piModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = PI_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/** Thinking levels a pi model exposes, honoring `thinkingLevelMap` holes. */
export function piThinkingLevelsForModel(model: PiModel): ReadonlyArray<PiThinkingLevel> {
  if (!model.reasoning) return [];
  const map = model.thinkingLevelMap ?? {};
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    // Extended levels are opt-in and need an explicit mapping.
    if ((level === "xhigh" || level === "max") && mapped === undefined) return false;
    return true;
  });
}

export function buildPiModelCapabilities(model: PiModel): ModelCapabilities {
  const levels = piThinkingLevelsForModel(model);
  if (levels.length === 0) return EMPTY_CAPABILITIES;
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: PI_REASONING_OPTION_ID,
        label: "Thinking",
        options: levels.map((level) => ({
          value: level,
          label: level,
          ...(level === "medium" ? { isDefault: true } : {}),
        })),
      }),
    ],
  });
}

export function buildPiModelsFromRpc(
  models: ReadonlyArray<PiModel>,
  currentModel: PiModel | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const currentSlug = currentModel ? piModelSlug(currentModel) : undefined;
  const seen = new Set<string>();
  const discovered: Array<ServerProviderModel> = [];
  for (const model of models) {
    const slug = piModelSlug(model);
    if (!model.id.trim() || !model.provider.trim() || seen.has(slug)) continue;
    seen.add(slug);
    discovered.push({
      slug,
      name: model.name.trim() || model.id,
      subProvider: model.provider,
      isCustom: false,
      ...(slug === currentSlug ? { isDefault: true } : {}),
      capabilities: buildPiModelCapabilities(model),
    });
  }
  return [...PI_BUILT_IN_MODELS, ...discovered];
}

export function buildPiCommandsFromRpc(commands: ReadonlyArray<PiCommandInfo>): {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
} {
  const slashCommands: Array<ServerProviderSlashCommand> = [];
  const skills: Array<ServerProviderSkill> = [];
  const seen = new Set<string>();
  for (const command of commands) {
    const name = command.name.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const description = command.description?.trim() || undefined;
    if (command.source === "skill") {
      const skillName = name.startsWith("skill:") ? name.slice("skill:".length) : name;
      const path = command.sourceInfo?.path?.trim();
      if (!skillName || !path) continue;
      skills.push({
        name: skillName,
        path,
        enabled: true,
        ...(description ? { description } : {}),
        ...(command.sourceInfo?.scope ? { scope: command.sourceInfo.scope } : {}),
      });
      continue;
    }
    slashCommands.push({ name, ...(description ? { description } : {}) });
  }
  return { slashCommands, skills };
}

export function buildInitialPiProviderSnapshot(
  piSettings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = piModelsFromSettings(piSettings.customModels);
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: piSettings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: piSettings.enabled
          ? "Checking pi availability..."
          : "pi is disabled in T3 Code settings.",
      },
    });
  });
}

/** Environment for every pi child: instance env plus the optional agent dir override. */
export function buildPiEnvironment(
  piSettings: Pick<PiSettings, "agentDir">,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const agentDir = piSettings.agentDir.trim();
  return agentDir ? { ...environment, [PI_AGENT_DIR_ENV]: agentDir } : { ...environment };
}

export function piLaunchArgv(piSettings: Pick<PiSettings, "launchArgs">): ReadonlyArray<string> {
  return tokenizeCliArgs(piSettings.launchArgs);
}

const runPiCliCommand = (
  piSettings: PiSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = piSettings.binaryPath || "pi";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

interface PiRpcProbeResult {
  readonly state: PiSessionState;
  readonly models: ReadonlyArray<PiModel>;
  readonly commands: ReadonlyArray<PiCommandInfo>;
}

/**
 * One short-lived ephemeral RPC session: reads state, the authenticated model
 * list, and the commands pi discovers for `cwd`. No prompt is ever sent.
 */
export const probePiRpc = Effect.fn("probePiRpc")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Effect.fn.Return<
  PiRpcProbeResult,
  ProviderAdapterProcessError | ProviderAdapterRequestError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const client = yield* spawnPiRpcClient({
    binaryPath: piSettings.binaryPath || "pi",
    args: ["--mode", "rpc", "--no-session", ...piLaunchArgv(piSettings)],
    cwd,
    env: buildPiEnvironment(piSettings, environment),
    threadId: "provider-probe",
  });
  const state = (yield* client.request({ type: "get_state" })).data as PiSessionState;
  const modelsResponse = yield* client.request({ type: "get_available_models" });
  const models = ((modelsResponse.data as { models?: ReadonlyArray<PiModel> } | undefined)
    ?.models ?? []) as ReadonlyArray<PiModel>;
  const commandsResponse = yield* client.request({ type: "get_commands" });
  const commands = ((
    commandsResponse.data as { commands?: ReadonlyArray<PiCommandInfo> } | undefined
  )?.commands ?? []) as ReadonlyArray<PiCommandInfo>;
  return { state, models, commands };
});

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = piModelsFromSettings(piSettings.customModels);
  const env = buildPiEnvironment(piSettings, environment);

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runPiCliCommand(piSettings, ["--version"], env).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("pi health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "pi is not installed or not on PATH."
          : "Failed to run the pi health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "pi timed out while running `pi --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "pi is installed but failed to run.",
      },
    });
  }

  const probeExit = yield* probePiRpc(piSettings, environment, cwd).pipe(
    Effect.scoped,
    Effect.timeoutOption(RPC_PROBE_TIMEOUT_MS),
    Effect.exit,
  );
  const probe = Exit.isSuccess(probeExit) ? Option.getOrUndefined(probeExit.value) : undefined;
  if (!probe) {
    yield* Effect.logWarning("pi RPC probe failed or timed out.", {
      errorTag: Exit.isFailure(probeExit) ? causeErrorTag(probeExit.cause) : "Timeout",
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: "pi is installed but did not answer in RPC mode. Model options may be incomplete.",
      },
    });
  }

  const discovered = buildPiModelsFromRpc(probe.models, probe.state.model);
  const models = piModelsFromSettings(piSettings.customModels, discovered);
  const { slashCommands, skills } = buildPiCommandsFromRpc(probe.commands);
  const authenticated = probe.models.length > 0;
  const auth: ServerProviderAuth = authenticated
    ? { status: "authenticated", type: "cached_token", label: "pi credentials" }
    : { status: "unauthenticated" };

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    slashCommands,
    skills,
    probe: {
      installed: true,
      version,
      status: authenticated ? "ready" : "error",
      auth,
      ...(authenticated
        ? {}
        : { message: "pi has no model with credentials. Run `pi` and `/login` in a terminal." }),
    },
  });
});

/** Per-workspace commands and skills, folded into the machine snapshot by the driver. */
export const probePiCommandsForCwd = Effect.fn("probePiCommandsForCwd")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Effect.fn.Return<
  {
    readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
    readonly skills: ReadonlyArray<ServerProviderSkill>;
  },
  ProviderDriverError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const probe = yield* probePiRpc(piSettings, environment, cwd).pipe(
    Effect.scoped,
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver: "pi",
          instanceId: "pi",
          detail: `Failed to discover pi commands for '${cwd}': ${cause.message}`,
          cause,
        }),
    ),
  );
  return buildPiCommandsFromRpc(probe.commands);
});

export const enrichPiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enriched) => input.publishSnapshot(enriched)),
    Effect.catchCause((cause) =>
      Effect.logWarning("pi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
