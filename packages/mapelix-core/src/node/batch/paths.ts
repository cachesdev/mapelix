import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export function isWithin(root: string, target: string): boolean {
  const part = relative(root, target);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

export function ownedPath(root: string, ...parts: string[]): string {
  const path = resolve(root, ...parts);
  if (path === root || !isWithin(root, path)) throw new Error("Output path escapes its owner");
  return path;
}

/** Reject links in every existing path component, including Windows junctions. */
export async function assertNoLinks(path: string, allowMissingLeaf = false): Promise<void> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  const components = relative(current, absolute).split(sep).filter(Boolean);
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new Error(`Symbolic links and junctions are not supported: ${current}`);
      if (index < components.length - 1 && !stat.isDirectory())
        throw new Error(`Not a directory: ${current}`);
    } catch (cause) {
      if (allowMissingLeaf && index === components.length - 1 && isMissing(cause)) return;
      throw cause;
    }
  }
}

export function isMissing(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

export async function validateRoots(world: string, output: string): Promise<void> {
  await assertNoLinks(world);
  await assertNoLinks(join(world, "db"));
  if (!(await lstat(join(world, "db"))).isDirectory())
    throw new Error("world/db must be a directory");
  await assertNoLinks(output, true);
  const input = await realpath(world);
  const parent = await realpath(dirname(output));
  const destination = join(parent, relative(dirname(output), output));
  if (isWithin(input, destination) || isWithin(destination, input)) {
    throw new Error("world and output must be disjoint directories");
  }
}

export interface OutputLease {
  readonly stage: string;
  readonly token: string;
  release(): Promise<void>;
}

/** The parent must exist. All creation and cleanup stays below the explicit output root. */
export async function acquireOutput(output: string): Promise<OutputLease> {
  try {
    await mkdir(output);
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
  }
  await assertNoLinks(output);
  if (!(await lstat(output)).isDirectory()) throw new Error("output must be a directory");
  const lock = ownedPath(output, ".mapelix.lock");
  const token = randomUUID();
  const handle = await open(lock, "wx", 0o600).catch((cause: unknown) => {
    throw new Error("Cannot acquire output lock; another writer or an interrupted export owns it", {
      cause,
    });
  });
  const stage = ownedPath(output, `.mapelix-staging-${token}`);
  try {
    try {
      await handle.writeFile(token);
    } finally {
      await handle.close();
    }
    await mkdir(stage, { mode: 0o700 });
  } catch (cause) {
    await unlink(lock);
    throw cause;
  }
  return {
    stage,
    token,
    async release() {
      await removeOwnedTree(output, stage);
      await assertNoLinks(lock);
      if ((await readFile(lock, "utf8")) !== token)
        throw new Error("Output lock ownership changed");
      await unlink(lock);
    },
  };
}

export async function assertTreeNoLinks(root: string): Promise<string[]> {
  await assertNoLinks(root);
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = ownedPath(root, relative(root, directory), entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic link in output: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
      else throw new Error(`Unsupported output file: ${path}`);
    }
  }
  await visit(root);
  return files.sort();
}

export async function removeOwnedTree(output: string, target: string): Promise<void> {
  if (!isWithin(output, target) || target === output)
    throw new Error("Refusing cleanup outside output");
  try {
    await assertTreeNoLinks(target);
  } catch (cause) {
    if (isMissing(cause)) return;
    throw cause;
  }
  await rm(target, { recursive: true, force: false });
}
