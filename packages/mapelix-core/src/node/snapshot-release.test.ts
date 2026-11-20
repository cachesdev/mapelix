import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  sectionRecord,
  writeFixtureWorld,
} from "../../../mapelix-scene-prototype/test/dimension-fixture.js";

const run = promisify(execFile);
const repository = fileURLToPath(new URL("../../../../", import.meta.url));

it("ships a complete, independently resolvable validation API and CLI with verified hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mapelix-validation-release-"));
  try {
    const releaseDirectory = join(root, "release");
    const world = join(root, "world");
    await writeFixtureWorld(world, [sectionRecord(0, 0, 0, 4, "minecraft:stone")]);
    await writeFile(join(world, "db", "038514.ldb"), new Uint8Array(79383));
    await run(
      process.execPath,
      [
        join(repository, "packages/mapelix-viewer/scripts/pack-release.mjs"),
        releaseDirectory,
        "--allow-dirty",
      ],
      { cwd: repository, timeout: 20000 },
    );
    const release = JSON.parse(await readFile(join(releaseDirectory, "release.json"), "utf8")) as {
      commit: string;
      dirty: boolean;
      snapshotValidationVersion: number;
      snapshotValidationApi: string;
      snapshotValidationCli: { entry: string; args: string[] };
      renderCli: string;
      files: Record<string, string>;
    };
    expect(release.snapshotValidationVersion).toBe(1);
    expect(release.snapshotValidationCli).toEqual({ entry: release.renderCli, args: ["validate"] });
    expect(release.commit).toMatch(/^[0-9a-f]{40}$/);
    for (const [path, expected] of Object.entries(release.files)) {
      expect(
        createHash("sha256")
          .update(await readFile(join(releaseDirectory, path)))
          .digest("hex"),
        path,
      ).toBe(expected);
    }
    for (const path of [
      release.snapshotValidationApi,
      release.renderCli,
      "node_modules/@mapelix/core/dist/node/snapshot-identity.js",
      "node_modules/@mapelix/prototype/dist/node-leveldb.js",
      "node_modules/@mapelix/prototype/dist/bedrock/table-validation.js",
      "node_modules/@mapelix/render-cli/dist/snapshot-cli.js",
    ])
      expect(release.files[path], path).toMatch(/^[0-9a-f]{64}$/);

    // Missing bundled dependencies must not be hidden by resolution into the checkout.
    const guard = join(root, "guard.mjs");
    await writeFile(
      guard,
      `import {registerHooks} from "node:module";
import {fileURLToPath} from "node:url";
import {relative,isAbsolute,sep} from "node:path";
registerHooks({resolve(specifier,context,next){const result=next(specifier,context);if(result.url.startsWith("file:")){const part=relative(process.env.MAPELIX_RELEASE_ROOT,fileURLToPath(result.url));if(isAbsolute(part)||part===".."||part.startsWith(".."+sep))throw new Error("Resolved outside release: "+result.url);}return result;}});
`,
    );
    const env = {
      ...process.env,
      NODE_PATH: "",
      NODE_OPTIONS: "",
      MAPELIX_RELEASE_ROOT: releaseDirectory,
    };
    const cli = join(releaseDirectory, release.renderCli);
    const api = join(releaseDirectory, release.snapshotValidationApi);
    const apiScript =
      'import {pathToFileURL} from "node:url"; const {validateSnapshot}=await import(pathToFileURL(process.argv[1]).href); console.log(JSON.stringify(await validateSnapshot(process.argv[2])));';
    const apiRun = await run(
      process.execPath,
      ["--import", pathToFileURL(guard).href, "--input-type=module", "-e", apiScript, api, world],
      { cwd: root, env },
    );
    const cliRun = await run(
      process.execPath,
      [
        "--import",
        pathToFileURL(guard).href,
        cli,
        ...release.snapshotValidationCli.args,
        "--world",
        world,
      ],
      { cwd: root, env },
    );
    const apiResult = JSON.parse(apiRun.stdout);
    const cliResult = JSON.parse(cliRun.stdout);
    expect(apiRun.stderr).toBe("");
    expect(cliRun.stderr).toBe("");
    expect(apiResult).toMatchObject({ valid: true, ignoredTables: 1, schemaVersion: 1 });
    expect(cliResult).toMatchObject({
      valid: true,
      revision: apiResult.revision,
      ignoredTables: 1,
    });
    const rendered = await run(
      process.execPath,
      [
        "--import",
        pathToFileURL(guard).href,
        cli,
        "--world",
        world,
        "--output",
        join(root, "map"),
        "--dimension",
        "overworld",
        "--zooms",
        "0",
        "--workers",
        "1",
        "--shadows",
        "off",
      ],
      { cwd: root, env },
    );
    expect(JSON.parse(rendered.stdout)).toMatchObject({ tiles: 1 });
    expect(rendered.stderr).toBe("");
    await writeFile(join(world, "db", "000001.log"), "corrupt necessary journal");
    const failed = (await run(
      process.execPath,
      ["--import", pathToFileURL(guard).href, cli, "validate", "--world", world],
      { cwd: root, env },
    ).catch((cause: unknown) => cause)) as { code: number; stdout: string; stderr: string };
    expect(failed.code).toBe(1);
    const failure = JSON.parse(failed.stdout);
    expect(failure).toMatchObject({ valid: false, errors: [{ code: "REQUIRED_LOG_INVALID" }] });
    await writeFile(
      join(repository, ".local/leveldb/lot2-release-smoke.json"),
      JSON.stringify(
        {
          commit: release.commit,
          dirty: release.dirty,
          filesVerified: Object.keys(release.files).length,
          snapshotValidationVersion: release.snapshotValidationVersion,
          snapshotValidationApi: release.snapshotValidationApi,
          snapshotValidationCli: release.snapshotValidationCli,
          outsideCheckout: true,
          resolutionConfined: true,
          renderTiles: 1,
          apiResult,
          cliResult,
          failure,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
