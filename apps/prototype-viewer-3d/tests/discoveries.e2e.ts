import { expect, test } from "@playwright/test";
import {
  decodeDiscoveryTile,
  discoveryKind,
  unpackDiscoveryBlock,
} from "../../../packages/mapelix-scene-prototype/dist/discoveries.js";

test("discovery transport indexes all heights separately from mesh windows and rejects stale snapshots", async ({
  request,
}) => {
  const world = await (await request.get("/world.json?mode=caves")).json();
  expect(world.discoveries).toMatchObject({ schemaVersion: 1, tileSpan: 32 });
  const url = `/discoveries/0/0.bin?dimension=overworld&revision=${world.snapshotRevision}&schema=1`;
  const response = await request.get(url);
  expect(response.ok()).toBe(true);
  const tile = decodeDiscoveryTile(new Uint8Array(await response.body()));
  const blocks = Array.from(tile.blocks, (word) => unpackDiscoveryBlock(tile, word));
  expect(blocks.some((block) => block.kind === discoveryKind("minecraft:mob_spawner"))).toBe(true);
  expect(
    blocks.find((block) => block.x === 14 && block.y === -63 && block.z === 20)?.exposure,
  ).toBe("buried");
  const otherDepth = await (await request.get("/world.json?mode=caves&minY=-32&maxY=0")).json();
  expect(otherDepth.snapshotRevision).toBe(world.snapshotRevision);
  const cached = await request.get(url);
  expect(cached.headers()["x-mapelix-cache"]).toBe("memory");
  expect(await cached.body()).toEqual(await response.body());
  expect((await request.get(`${url}&minY=-64`)).status()).toBe(400);
  expect((await request.get("/discoveries/0/0.bin?revision=old")).status()).toBe(409);
  expect((await request.get("/discoveries/0/0.bin?schema=999")).status()).toBe(400);
  expect((await request.get("/discoveries/0/0.bin?dimension=invalid")).status()).toBe(400);
});

test("discovery filters find hidden ores, persist preferences and navigate without replacing the canvas", async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === "webgl")
    await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  const errors: string[] = [],
    urls: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("request", (request) => {
    if (request.url().includes("/discoveries/")) urls.push(request.url());
  });
  await page.goto(
    "/?mode=caves&minY=-64&maxY=-32&x=16&y=-48&z=16&distance=45&pitch=60&discover=off",
  );
  await page.getByText("All nearby terrain loaded").waitFor();
  await page.getByText("Discoveries · hidden", { exact: true }).click();
  await page.getByLabel("Show discoveries", { exact: true }).check();
  const list = page.getByRole("list", { name: "Discoveries found" });
  await expect(list.getByRole("button", { name: /Explore Monster spawner/ })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByLabel("Ores", { exact: true }).check();
  await page.getByLabel("Exposure", { exact: true }).selectOption("buried");
  await page.getByLabel("Slice thickness", { exact: true }).selectOption("16");
  await page.getByRole("slider", { name: /^Slice:/ }).evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "-32";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page).toHaveURL(/minY=-32&maxY=-16/);
  await page.getByLabel("Search all heights", { exact: true }).check();
  await expect(list.getByRole("button", { name: /Explore Diamond at 14, -63, 20/ })).toBeVisible();
  await expect(page).toHaveURL(/exposure=buried/);
  await list.getByRole("button", { name: /Explore Diamond at 14, -63, 20/ }).click();
  await expect(page).toHaveURL(/x=14&y=-63&z=20/);
  await expect(page).toHaveURL(/minY=-64&maxY=-48/);
  expect(Number(new URL(page.url()).searchParams.get("distance"))).toBeLessThanOrEqual(24);
  await expect(page.locator("[data-discovery-details]")).toBeVisible();
  await expect(page.locator("canvas")).toHaveCount(1);
  expect(urls.every((url) => !new URL(url).searchParams.has("minY"))).toBe(true);
  await page.reload();
  await page
    .locator("summary")
    .filter({ hasText: /^Discoveries/ })
    .click();
  await expect(page.getByLabel("Exposure", { exact: true })).toHaveValue("buried");
  await expect(page.getByLabel("Ores", { exact: true })).toBeChecked();
  await page.getByLabel("Show discoveries", { exact: true }).uncheck();
  await expect(page).toHaveURL(/discover=off/);
  await page.reload();
  await page
    .locator("summary")
    .filter({ hasText: /^Discoveries/ })
    .click();
  await expect(page.getByLabel("Show discoveries", { exact: true })).not.toBeChecked();
  await page.getByLabel("Show discoveries", { exact: true }).check();
  await expect(page.getByLabel("Exposure", { exact: true })).toHaveValue("buried");
  await expect(page.getByLabel("Ores", { exact: true })).toBeChecked();
  expect(errors).toEqual([]);
});
