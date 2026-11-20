import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface FixtureRecord {
  readonly key: Uint8Array;
  readonly value: Uint8Array;
}

export function chunkKey(
  dimension: number,
  x: number,
  z: number,
  tag: number,
  y?: number,
): Uint8Array {
  const offset = dimension === 0 ? 8 : 12;
  const key = new Uint8Array(offset + (y === undefined ? 1 : 2));
  const view = new DataView(key.buffer);
  view.setInt32(0, x, true);
  view.setInt32(4, z, true);
  if (dimension !== 0) view.setInt32(8, dimension, true);
  key[offset] = tag;
  if (y !== undefined) key[offset + 1] = y & 255;
  return key;
}

export type FixtureBlock =
  | string
  | {
      readonly name: string;
      readonly states: Readonly<Record<string, number | string>>;
    };

function paletteEntry(block: FixtureBlock): Uint8Array {
  const string = (text: string): number[] => {
    const bytes = new TextEncoder().encode(text);
    return [bytes.length & 255, bytes.length >> 8, ...bytes];
  };
  const name = typeof block === "string" ? block : block.name;
  const bytes = [10, 0, 0, 8, ...string("name"), ...string(name)];
  if (typeof block !== "string") {
    bytes.push(10, ...string("states"));
    for (const [key, value] of Object.entries(block.states)) {
      if (typeof value === "string") bytes.push(8, ...string(key), ...string(value));
      else {
        const encoded = new Uint8Array(4);
        new DataView(encoded.buffer).setInt32(0, value, true);
        bytes.push(3, ...string(key), ...encoded);
      }
    }
    bytes.push(0);
  }
  bytes.push(0);
  return Uint8Array.from(bytes);
}

/** A v9 disk subchunk with a four/eight-bit palette and real little-endian block NBT. */
export function sectionRecord(
  dimension: number,
  x: number,
  z: number,
  y: number,
  block: FixtureBlock | ((x: number, y: number, z: number) => FixtureBlock),
): FixtureRecord {
  const names: string[] = [];
  const palette: FixtureBlock[] = [];
  const indexes = new Uint16Array(4096);
  for (let index = 0; index < 4096; index++) {
    const name =
      typeof block === "function"
        ? block(x * 16 + (index >> 8), y * 16 + (index & 15), z * 16 + ((index >> 4) & 15))
        : block;
    const key = typeof name === "string" ? name : JSON.stringify(name);
    let id = names.indexOf(key);
    if (id < 0) {
      id = names.length;
      names.push(key);
      palette.push(name);
    }
    if (id > 255) throw new Error("Fixture palette exceeds eight bits");
    indexes[index] = id;
  }
  const bits = palette.length > 16 ? 8 : 4;
  const perWord = 32 / bits;
  const words = new Uint32Array(4096 / perWord);
  for (let index = 0; index < indexes.length; index++) {
    const word = Math.floor(index / perWord);
    words[word] = words[word]! | (indexes[index]! << ((index % perWord) * bits));
  }
  const entries = palette.map(paletteEntry);
  const value = new Uint8Array(
    4 + words.byteLength + 4 + entries.reduce((size, entry) => size + entry.length, 0),
  );
  value.set([9, 1, y & 255, bits << 1]);
  const view = new DataView(value.buffer);
  for (let index = 0; index < words.length; index++)
    view.setUint32(4 + index * 4, words[index]!, true);
  view.setUint32(4 + words.byteLength, names.length, true);
  let offset = 8 + words.byteLength;
  for (const entry of entries) {
    value.set(entry, offset);
    offset += entry.length;
  }
  return { key: chunkKey(dimension, x, z, 0x2f, y), value };
}

export function biomeRecord(
  dimension: number,
  x: number,
  z: number,
  biomes: readonly number[],
): FixtureRecord {
  const value = new Uint8Array(512 + biomes.length * 5);
  const view = new DataView(value.buffer);
  biomes.forEach((biome, index) => {
    value[512 + index * 5] = 1;
    view.setInt32(513 + index * 5, biome, true);
  });
  return { key: chunkKey(dimension, x, z, 0x2b), value };
}

/** Real concatenated little-endian block-entity compounds, without touching a real world. */
export function bedEntityRecord(
  dimension: number,
  chunkX: number,
  chunkZ: number,
  beds: readonly { x: number; y: number; z: number; color?: number; base?: number; id?: string }[],
): FixtureRecord {
  const bytes: number[] = [];
  const string = (value: string): number[] => {
    const encoded = new TextEncoder().encode(value);
    return [encoded.length & 255, encoded.length >> 8, ...encoded];
  };
  for (const bed of beds) {
    bytes.push(10, 0, 0, 8, ...string("id"), ...string(bed.id ?? "Bed"));
    for (const key of ["x", "y", "z"] as const) {
      const value = new Uint8Array(4);
      new DataView(value.buffer).setInt32(0, bed[key], true);
      bytes.push(3, ...string(key), ...value);
    }
    if (bed.color !== undefined) bytes.push(1, ...string("color"), bed.color & 255);
    if (bed.base !== undefined) {
      const value = new Uint8Array(4);
      new DataView(value.buffer).setInt32(0, bed.base, true);
      bytes.push(3, ...string("Base"), ...value);
    }
    bytes.push(0);
  }
  return { key: chunkKey(dimension, chunkX, chunkZ, 0x31), value: new Uint8Array(bytes) };
}

export function dimensionFixtureRecords(): FixtureRecord[] {
  const records: FixtureRecord[] = [];
  for (let z = 0; z < 4; z++) {
    for (let x = 0; x < 4; x++) {
      records.push(
        sectionRecord(0, x, z, 4, (_x, y) =>
          y === 79 ? "minecraft:grass_block" : "minecraft:stone",
        ),
      );
      records.push(biomeRecord(0, x, z, Array<number>(24).fill(1)));
      records.push(
        sectionRecord(1, x, z, 0, (wx, y) =>
          y === 15
            ? wx < 32
              ? "minecraft:crimson_nylium"
              : "minecraft:warped_nylium"
            : "minecraft:netherrack",
        ),
      );
      for (let section = 1; section < 6; section++) {
        records.push(
          sectionRecord(1, x, z, section, (wx, y, wz) => {
            if (wx === 0 || wx === 63 || wz === 0 || wz === 63) return "minecraft:netherrack";
            if (y === 31 && wx >= 8 && wx < 24 && wz >= 8 && wz < 24) return "minecraft:lava";
            if (wx === 30 && wz === 30 && y === 50) return "minecraft:glowstone";
            if (wx === 32 && wz === 30 && y === 50) return "example:unknown_crystal";
            return "minecraft:air";
          }),
        );
      }
      records.push(
        sectionRecord(1, x, z, 6, "minecraft:bedrock"),
        sectionRecord(1, x, z, 7, "minecraft:bedrock"),
      );
      records.push(biomeRecord(1, x, z, Array<number>(8).fill(x < 2 ? 179 : 180)));
      records.push(sectionRecord(2, x, z, x < 2 ? 3 : 7, "minecraft:end_stone"));
      records.push(biomeRecord(2, x, z, Array<number>(16).fill(9)));
    }
  }
  return records;
}

function varint(value: number): number[] {
  const bytes: number[] = [];
  while (value >= 128) {
    bytes.push((value & 127) | 128);
    value >>>= 7;
  }
  return [...bytes, value];
}

function maskedCrc32c(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f6_3b78 : 0);
  }
  crc = ~crc;
  return (((crc >>> 15) | (crc << 17)) + 0xa282_ead8) >>> 0;
}

/** Writes only a generated test database; never opens or changes a Minecraft database. */
export async function writeFixtureWorld(
  directory: string,
  records = dimensionFixtureRecords(),
): Promise<void> {
  const fragments: Uint8Array[] = [];
  let position = 0;
  for (const [index, record] of records.entries()) {
    const payload = new Uint8Array(
      12 +
        1 +
        varint(record.key.length).length +
        record.key.length +
        varint(record.value.length).length +
        record.value.length,
    );
    const view = new DataView(payload.buffer);
    view.setBigUint64(0, BigInt(index + 1), true);
    view.setUint32(8, 1, true);
    payload.set(
      [
        1,
        ...varint(record.key.length),
        ...record.key,
        ...varint(record.value.length),
        ...record.value,
      ],
      12,
    );
    const frame = new Uint8Array(7 + payload.length);
    frame[6] = 1; // FULL physical record.
    new DataView(frame.buffer).setUint16(4, payload.length, true);
    frame.set(payload, 7);
    new DataView(frame.buffer).setUint32(0, maskedCrc32c(new Uint8Array([1, ...payload])), true);
    const remaining = 32768 - (position % 32768);
    if (remaining < frame.length) {
      fragments.push(new Uint8Array(remaining));
      position += remaining;
    }
    fragments.push(frame);
    position += frame.length;
  }
  await mkdir(join(directory, "db"), { recursive: true });
  await writeFile(join(directory, "db", "000001.log"), Buffer.concat(fragments));
  const edit = new Uint8Array([2, 1, 3, 3, 4, ...varint(records.length)]);
  const manifest = new Uint8Array(7 + edit.length);
  manifest[6] = 1;
  manifest.set(edit, 7);
  const header = new DataView(manifest.buffer);
  header.setUint16(4, edit.length, true);
  header.setUint32(0, maskedCrc32c(manifest.subarray(6)), true);
  await writeFile(join(directory, "db", "CURRENT"), "MANIFEST-000002\n");
  await writeFile(join(directory, "db", "MANIFEST-000002"), manifest);
  await writeFile(join(directory, "levelname.txt"), "Dimension test world");
}
