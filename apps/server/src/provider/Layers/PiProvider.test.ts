// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PI_DEFAULT_MODEL, PiSettings } from "@t3tools/contracts";

import {
  buildPiCommandsFromRpc,
  buildPiEnvironment,
  buildPiModelCapabilities,
  buildPiModelsFromRpc,
  checkPiProviderStatus,
  piThinkingLevelsForModel,
} from "./PiProvider.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockPath = NodePath.join(__dirname, "../../../scripts/pi-mock-rpc.ts");

async function makeMockPiWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-mock-"));
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
  return wrapperPath;
}

it("exposes thinking levels from reasoning and thinkingLevelMap holes", () => {
  assert.deepStrictEqual(
    piThinkingLevelsForModel({ id: "m", name: "m", provider: "p", reasoning: false }),
    [],
  );
  assert.deepStrictEqual(
    piThinkingLevelsForModel({
      id: "m",
      name: "m",
      provider: "p",
      reasoning: true,
      thinkingLevelMap: { minimal: null, low: null, high: "high", max: "max" },
    }),
    ["off", "medium", "high", "max"],
  );
  const capabilities = buildPiModelCapabilities({
    id: "m",
    name: "m",
    provider: "p",
    reasoning: true,
  });
  const descriptor = capabilities.optionDescriptors?.[0];
  assert.strictEqual(descriptor?.id, "thinkingLevel");
  assert.strictEqual(descriptor?.type, "select");
  if (descriptor?.type === "select") {
    assert.strictEqual(descriptor.currentValue, "medium");
    assert.deepStrictEqual(
      descriptor.options.map((option) => option.id),
      ["off", "minimal", "low", "medium", "high"],
    );
  }
});

it("builds the model list with the sentinel first and pi's current model as default", () => {
  const models = buildPiModelsFromRpc(
    [
      { id: "a", name: "A", provider: "anthropic" },
      { id: "a", name: "A again", provider: "anthropic" },
      { id: "b", name: "B", provider: "openai" },
    ],
    { id: "b", name: "B", provider: "openai" },
  );
  assert.deepStrictEqual(
    models.map((model) => model.slug),
    [PI_DEFAULT_MODEL, "anthropic/a", "openai/b"],
  );
  assert.isTrue(models[2]?.isDefault);
  assert.strictEqual(models[1]?.subProvider, "anthropic");
});

it("splits pi commands into skills and slash commands", () => {
  const result = buildPiCommandsFromRpc([
    {
      name: "fix-tests",
      description: "Fix",
      source: "prompt",
      sourceInfo: { path: "/p.md", scope: "project" },
    },
    {
      name: "skill:brave",
      description: "Search",
      source: "skill",
      sourceInfo: { path: "/s/SKILL.md", scope: "user" },
    },
    { name: "llama", source: "extension" },
    { name: "skill:nopath", source: "skill" },
  ]);
  assert.deepStrictEqual(
    result.slashCommands.map((command) => command.name),
    ["fix-tests", "llama"],
  );
  assert.strictEqual(result.skills.length, 1);
  assert.strictEqual(result.skills[0]?.name, "brave");
  assert.strictEqual(result.skills[0]?.scope, "user");
});

it("sets PI_CODING_AGENT_DIR only when an agent dir is configured", () => {
  assert.isUndefined(buildPiEnvironment({ agentDir: "" }, { PATH: "/bin" }).PI_CODING_AGENT_DIR);
  assert.strictEqual(
    buildPiEnvironment({ agentDir: "/custom" }, { PATH: "/bin" }).PI_CODING_AGENT_DIR,
    "/custom",
  );
});

it.effect("reports a disabled provider without spawning anything", () =>
  Effect.gen(function* () {
    const snapshot = yield* checkPiProviderStatus(
      decodePiSettings({ enabled: false, binaryPath: "/definitely/missing/pi" }),
    );
    assert.strictEqual(snapshot.status, "disabled");
    assert.isFalse(snapshot.installed);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a missing binary as not installed", () =>
  Effect.gen(function* () {
    const snapshot = yield* checkPiProviderStatus(
      decodePiSettings({ enabled: true, binaryPath: "/definitely/missing/pi" }),
    );
    assert.strictEqual(snapshot.status, "error");
    assert.isFalse(snapshot.installed);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("discovers version, models, skills, and commands from the RPC probe", () =>
  Effect.gen(function* () {
    const binaryPath = yield* Effect.promise(() => makeMockPiWrapper());
    const snapshot = yield* checkPiProviderStatus(
      decodePiSettings({ enabled: true, binaryPath }),
      process.env,
      process.cwd(),
    );
    assert.strictEqual(snapshot.status, "ready");
    assert.strictEqual(snapshot.version, "0.84.4");
    assert.strictEqual(snapshot.auth.status, "authenticated");
    assert.deepStrictEqual(
      snapshot.models.map((model) => model.slug),
      [PI_DEFAULT_MODEL, "anthropic/claude-sonnet-4-5", "openai/gpt-5"],
    );
    assert.isTrue(snapshot.models[1]?.isDefault);
    assert.deepStrictEqual(
      snapshot.slashCommands.map((command) => command.name),
      ["fix-tests", "llama"],
    );
    assert.strictEqual(snapshot.skills[0]?.name, "brave-search");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports unauthenticated when pi has no models with credentials", () =>
  Effect.gen(function* () {
    const binaryPath = yield* Effect.promise(() =>
      makeMockPiWrapper({ T3_PI_MOCK_NO_MODELS: "1" }),
    );
    const snapshot = yield* checkPiProviderStatus(decodePiSettings({ enabled: true, binaryPath }));
    assert.strictEqual(snapshot.status, "error");
    assert.strictEqual(snapshot.auth.status, "unauthenticated");
    assert.deepStrictEqual(
      snapshot.models.map((model) => model.slug),
      [PI_DEFAULT_MODEL],
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
