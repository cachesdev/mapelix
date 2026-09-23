import type { Dimension } from "../world/chunk-source.js";
import type { RegionBuilderOptions, RegionRequest } from "./region-builder.js";

export interface WorkerRequest {
  readonly id: number;
  readonly region: RegionRequest;
}

export type WorkerReply =
  | {
      readonly id: number;
      readonly kind: "built";
      readonly bytes: Uint8Array;
      readonly milliseconds: number;
    }
  | { readonly id: number; readonly kind: "failed"; readonly message: string };

const DIMENSIONS: readonly Dimension[] = ["overworld", "nether", "the-end"];

/** Validates the options a worker receives through `workerData`. */
export function parseWorkerSetup(input: unknown): RegionBuilderOptions {
  if (typeof input !== "object" || input === null) throw new Error("Missing worker setup");
  const directory = "directory" in input ? input.directory : undefined;
  const dimension = "dimension" in input ? input.dimension : undefined;
  if (typeof directory !== "string") throw new Error("Worker setup needs a world directory");
  const known = DIMENSIONS.find((candidate) => candidate === dimension);
  if (known === undefined) throw new Error(`Unknown dimension ${String(dimension)}`);
  return { directory, dimension: known };
}
