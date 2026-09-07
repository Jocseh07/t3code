/**
 * PiTextGeneration — titles, branch names, commit and PR text through
 * `pi -p` (print mode). Tools, extensions, and session persistence are all
 * off, and project-local resources are ignored (`--no-approve`), so a helper
 * call cannot touch the workspace.
 *
 * @module textGeneration/PiTextGeneration
 */
import { PI_DEFAULT_MODEL, type PiSettings, TextGenerationError } from "@t3tools/contracts";
import type { ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectStreamAsString } from "../provider/providerSnapshot.ts";
import { isPiThinkingLevel } from "../provider/pi/PiRpcProtocol.ts";
import { buildPiEnvironment, PI_REASONING_OPTION_ID } from "../provider/Layers/PiProvider.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const PI_TIMEOUT_MS = 180_000;
const isTextGenerationError = Schema.is(TextGenerationError);

export function piPrintModeArgs(modelSelection: ModelSelection): ReadonlyArray<string> {
  const model = modelSelection.model.trim();
  const level = getModelSelectionStringOptionValue(modelSelection, PI_REASONING_OPTION_ID);
  return [
    "-p",
    "--no-tools",
    "--no-extensions",
    "--no-session",
    "--no-approve",
    ...(model && model !== PI_DEFAULT_MODEL ? ["--model", model] : []),
    ...(level && isPiThinkingLevel(level) ? ["--thinking", level] : []),
  ];
}

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  piSettings: PiSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const piEnvironment = buildPiEnvironment(piSettings, environment ?? process.env);
  const binary = piSettings.binaryPath || "pi";

  const runPiJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const spawnCommand = yield* resolveSpawnCommand(binary, piPrintModeArgs(modelSelection), {
        env: piEnvironment,
      });
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: piEnvironment,
        cwd,
        shell: spawnCommand.shell,
        stdin: { stream: Stream.encodeText(Stream.make(prompt)) },
      });
      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("pi", operation, cause, "Failed to spawn pi."),
          ),
        );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectStreamAsString(child.stdout).pipe(
            Effect.mapError((cause) =>
              normalizeCliError("pi", operation, cause, "Failed to read pi output."),
            ),
          ),
          collectStreamAsString(child.stderr).pipe(
            Effect.mapError((cause) =>
              normalizeCliError("pi", operation, cause, "Failed to read pi output."),
            ),
          ),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("pi", operation, cause, "Failed to read pi exit code."),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        const detail = stderr.trim() || stdout.trim();
        return yield* new TextGenerationError({
          operation,
          detail: detail ? `pi failed: ${detail}` : `pi exited with code ${exitCode}.`,
        });
      }
      const trimmed = stdout.trim();
      if (!trimmed) {
        return yield* new TextGenerationError({ operation, detail: "pi returned empty output." });
      }
      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(trimmed)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "pi returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(PI_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new TextGenerationError({ operation, detail: "pi request timed out." })),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({ operation, detail: "pi text generation failed.", cause }),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runPiJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("PiTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runPiJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PiTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runPiJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runPiJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
