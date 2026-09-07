// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { PI_DEFAULT_MODEL, PiSettings, ProviderInstanceId } from "@t3tools/contracts";

import { makePiTextGeneration, piPrintModeArgs } from "./PiTextGeneration.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockPath = NodePath.join(__dirname, "../../scripts/pi-mock-rpc.ts");

function makeFakePi(dir: string, argsLog: string): string {
  const binaryPath = NodePath.join(dir, "pi");
  NodeFS.writeFileSync(
    binaryPath,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsLog)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockPath)} "$@"\n`,
    "utf8",
  );
  NodeFS.chmodSync(binaryPath, 0o755);
  return binaryPath;
}

it("builds print-mode args with tools, extensions, and sessions off", () => {
  const args = piPrintModeArgs(
    createModelSelection(ProviderInstanceId.make("pi"), "anthropic/claude-haiku-4-5", [
      { id: "thinkingLevel", value: "low" },
    ]),
  );
  assert.deepStrictEqual(args, [
    "-p",
    "--no-tools",
    "--no-extensions",
    "--no-session",
    "--no-approve",
    "--no-context-files",
    "--model",
    "anthropic/claude-haiku-4-5",
    "--thinking",
    "low",
  ]);
  const sentinel = piPrintModeArgs(
    createModelSelection(ProviderInstanceId.make("pi"), PI_DEFAULT_MODEL),
  );
  assert.isFalse(sentinel.includes("--model"));
  // Generated titles and branch names must not read the user's AGENTS.md.
  assert.isTrue(sentinel.includes("--no-context-files"));
});

it.effect("runs pi in print mode and parses structured commit output", () =>
  Effect.gen(function* () {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-pi-text-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
    );
    const argsLog = NodePath.join(dir, "args.txt");
    const binaryPath = makeFakePi(dir, argsLog);
    const textGeneration = yield* makePiTextGeneration(decodePiSettings({ binaryPath }));

    const generated = yield* textGeneration.generateCommitMessage({
      cwd: process.cwd(),
      branch: "feature/pi",
      stagedSummary: "M apps/server/src/provider/Drivers/PiDriver.ts",
      stagedPatch: "diff --git a/x b/x",
      modelSelection: createModelSelection(ProviderInstanceId.make("pi"), "openai/gpt-5"),
    });
    assert.strictEqual(generated.subject, "feat: mock pi commit");
    assert.strictEqual(generated.body, "Body from mock pi.");

    const argv = NodeFS.readFileSync(argsLog, "utf8").split("\n");
    assert.include(argv, "-p");
    assert.include(argv, "--no-tools");
    assert.strictEqual(argv[argv.indexOf("--model") + 1], "openai/gpt-5");

    const title = yield* textGeneration.generateThreadTitle({
      cwd: process.cwd(),
      message: "Please add a pi provider",
      modelSelection: createModelSelection(ProviderInstanceId.make("pi"), PI_DEFAULT_MODEL),
    });
    assert.strictEqual(title.title, "Mock pi title");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
