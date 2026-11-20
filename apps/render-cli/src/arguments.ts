import { parseArgs } from "node:util";

import type { BatchOptions, BatchLimits, BatchBounds } from "@mapelix/core/node/batch";

export const HELP = `Usage: mapelix-render --world <snapshot> --output <directory> [options]

Validate without rendering: mapelix-render validate --world <snapshot> (see validate --help).

Read-only classic 2D export. The output parent must already exist.
  --dimension <name>          Repeat or comma-separate overworld,nether,end (default: all)
  --zooms <integers>          Default: -4,-3,-2,-1,0,1,2; explicit +3 is also supported
  --top-y <integer>           Highest included block; defaults to dimension profiles
  --appearance <name>        modern (default) or reference
  --shadows <mode>           opacity (default) or off
  --biome-blend-radius <n>    0..16 blocks (default: 0)
  --correct-reference-bugs   Opt into corrected reference shadow rounding
  --bounds <x0,z0,x1,z1>      Exclusive block bounds; intersecting tiles remain full
  --incremental              Reuse unchanged tiles of the published generation
  --surface-cache[=<mib>]    Keep chunk surfaces between exports (default bound: 512)
  --workers <n>              1..16 worker threads (default: 2)
  --max-pending <n>          Accepted jobs, 1..1024 (default: worker count)
  --max-tiles <n>            Published tiles plus temporary zoom-0 sources (default: 10000)
  --max-output-bytes <n>     All new PNGs plus both manifests (default: 1073741824)
  --max-input-file-bytes <n> Per database/level.dat file (default: 268435456)
  --timeout-seconds <n>      Whole run deadline (default: 300)
  --memory-budget-mib <n>    Sampled whole-process RSS budget (default: 2048)
  --help                    Show this help

On success, stdout contains one JSON summary. Errors go to stderr with nonzero exit.
Use --zooms=-4,-1 for an overview-only export.
`;

function integer(name: string, text: string): number {
  if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text)))
    throw new TypeError(`${name} requires a safe integer`);
  return Number(text);
}

export function parseBatchArguments(args: readonly string[]): BatchOptions | "help" {
  const { values } = parseArgs({
    args: args.map((arg) => (arg === "--surface-cache" ? "--surface-cache=" : arg)),
    strict: true,
    allowPositionals: false,
    options: {
      world: { type: "string" },
      output: { type: "string" },
      dimension: { type: "string", multiple: true },
      zooms: { type: "string" },
      "top-y": { type: "string" },
      appearance: { type: "string" },
      shadows: { type: "string" },
      "biome-blend-radius": { type: "string" },
      "correct-reference-bugs": { type: "boolean" },
      incremental: { type: "boolean" },
      "surface-cache": { type: "string" },
      bounds: { type: "string" },
      workers: { type: "string" },
      "max-pending": { type: "string" },
      "max-tiles": { type: "string" },
      "max-output-bytes": { type: "string" },
      "max-input-file-bytes": { type: "string" },
      "timeout-seconds": { type: "string" },
      "memory-budget-mib": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help === true) return "help";
  if (!values.world || !values.output)
    throw new TypeError("--world and --output are required (see --help)");
  const dimensions = values.dimension?.flatMap((text) => text.split(","));
  if (dimensions?.some((name) => !["all", "overworld", "nether", "end", "the-end"].includes(name)))
    throw new RangeError("Unsupported --dimension");
  if (dimensions?.includes("all") && dimensions.length !== 1)
    throw new RangeError("Use --dimension all on its own");
  const appearance = values.appearance;
  if (appearance !== undefined && appearance !== "modern" && appearance !== "reference")
    throw new RangeError("Unsupported --appearance");
  const shadows = values.shadows;
  if (shadows !== undefined && shadows !== "opacity" && shadows !== "off")
    throw new RangeError("Unsupported --shadows");
  const limits: Partial<BatchLimits> = {};
  const numberOptions = {
    workers: "workers",
    "max-pending": "maxPending",
    "max-tiles": "maxTiles",
    "max-output-bytes": "maxOutputBytes",
    "max-input-file-bytes": "maxInputFileBytes",
    "timeout-seconds": "timeoutMs",
    "memory-budget-mib": "memoryBudgetMiB",
  } as const;
  for (const [flag, property] of Object.entries(numberOptions)) {
    const value = values[flag as keyof typeof numberOptions];
    if (value !== undefined)
      Object.assign(limits, {
        [property]: integer(`--${flag}`, value) * (property === "timeoutMs" ? 1000 : 1),
      });
  }
  // A bare --surface-cache is accepted by rewriting it to an explicit empty value below.
  const surfaceCache = values["surface-cache"];
  let bounds: BatchBounds | undefined;
  if (values.bounds !== undefined) {
    const parts = values.bounds.split(",").map((part) => integer("--bounds", part));
    if (parts.length !== 4) throw new TypeError("--bounds requires x0,z0,x1,z1");
    bounds = { minX: parts[0]!, minZ: parts[1]!, maxX: parts[2]!, maxZ: parts[3]! };
  }
  return {
    world: values.world,
    output: values.output,
    limits,
    ...(dimensions === undefined || dimensions[0] === "all"
      ? {}
      : { dimensions: dimensions as NonNullable<BatchOptions["dimensions"]> }),
    ...(values.zooms === undefined
      ? {}
      : { zooms: values.zooms.split(",").map((part) => integer("--zooms", part)) }),
    ...(values["top-y"] === undefined ? {} : { topY: integer("--top-y", values["top-y"]) }),
    ...(appearance === undefined ? {} : { appearance }),
    ...(shadows === undefined ? {} : { shadows }),
    ...(values["biome-blend-radius"] === undefined
      ? {}
      : { biomeBlendRadius: integer("--biome-blend-radius", values["biome-blend-radius"]) }),
    ...(values["correct-reference-bugs"] === undefined
      ? {}
      : { correctReferenceBugs: values["correct-reference-bugs"] }),
    ...(bounds === undefined ? {} : { bounds }),
    ...(values.incremental === undefined ? {} : { incremental: values.incremental }),
    ...(surfaceCache === undefined
      ? {}
      : {
          surfaceCache:
            surfaceCache === "" ? true : { maxMiB: integer("--surface-cache", surfaceCache) },
        }),
  };
}
