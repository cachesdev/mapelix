import { parseArgs } from "node:util";
import {
  SNAPSHOT_VALIDATION_FORMAT,
  SNAPSHOT_VALIDATION_VERSION,
  validateSnapshot,
  type SnapshotValidationOptions,
  type SnapshotValidationResult,
} from "@mapelix/core/node/snapshot";

const HELP = `Usage: mapelix-render validate --world <directory> [options]

Read-only, exhaustive LevelDB snapshot validation. No output directory or rendering.
Result contract: ${SNAPSHOT_VALIDATION_FORMAT}, schema version ${SNAPSHOT_VALIDATION_VERSION}.

  --world <directory>             Extracted, immutable Bedrock world
  --max-input-file-bytes <n>      Logical per-file limit (default: 268435456)
  --max-decoded-block-bytes <n>   Decoded table block limit (default: 16777216)
  --max-total-input-bytes <n>     Selected input limit (default: 34359738368)
  --timeout-seconds <n>          Cooperative deadline (default: 300)
  --help                         Show this help

One JSON result on stdout; human diagnostics on stderr.
Exit: 0 valid, 1 invalid/limited/timed out, 2 invalid invocation, 130 SIGINT, 143 SIGTERM.
`;

function integer(name: string, text: string): number {
  const number = Number(text);
  if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(number) || number < 1)
    throw new TypeError(`${name} requires a positive safe integer`);
  return number;
}

/** The existing entry dispatches here only for the validate subcommand. */
export async function runSnapshotValidation(
  args: readonly string[],
  signal: AbortSignal,
): Promise<number> {
  let result: SnapshotValidationResult;
  let exitCode = 1;
  try {
    const { values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        world: { type: "string" },
        help: { type: "boolean", short: "h" },
        "max-input-file-bytes": { type: "string" },
        "max-decoded-block-bytes": { type: "string" },
        "max-total-input-bytes": { type: "string" },
        "timeout-seconds": { type: "string" },
      },
    });
    if (values.help) {
      process.stdout.write(HELP);
      return 0;
    }
    if (!values.world) throw new TypeError("--world is required (see validate --help)");
    const options: {
      -readonly [K in keyof SnapshotValidationOptions]: SnapshotValidationOptions[K];
    } = { signal };
    for (const [flag, key] of [
      ["max-input-file-bytes", "maxInputFileBytes"],
      ["max-decoded-block-bytes", "maxDecodedBlockBytes"],
      ["max-total-input-bytes", "maxTotalInputBytes"],
      ["timeout-seconds", "timeoutMs"],
    ] as const) {
      const text = values[flag];
      if (text !== undefined)
        options[key] = integer(`--${flag}`, text) * (key === "timeoutMs" ? 1000 : 1);
    }
    result = await validateSnapshot(values.world, options);
    exitCode = result.valid ? 0 : 1;
  } catch (cause) {
    result = {
      format: SNAPSHOT_VALIDATION_FORMAT,
      schemaVersion: SNAPSHOT_VALIDATION_VERSION,
      valid: false,
      revision: null,
      activeTables: null,
      selectedJournals: null,
      ignoredTables: null,
      filesChecked: 0,
      bytesChecked: 0,
      elapsedMs: 0,
      errors: [
        {
          code: "VALIDATION_OPTIONS_INVALID",
          file: null,
          message: cause instanceof Error ? cause.message : String(cause),
        },
      ],
    };
    exitCode = 2;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  for (const error of result.errors) process.stderr.write(`${error.code}: ${error.message}\n`);
  return exitCode;
}
