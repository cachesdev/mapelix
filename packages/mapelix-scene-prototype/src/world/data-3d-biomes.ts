const HEIGHTMAP_BYTES = 512;
const SECTION_COUNT = 24;
const LOWEST_SECTION = -4;
const BIOMES_PER_SECTION = 4096;
/** A storage header that repeats the storage of the subchunk below. */
const REPEAT_BELOW = 0xff;

/**
 * Biome lookups read straight from a Data3D record, without unpacking it.
 *
 * The record holds a 512-byte heightmap, then one biome storage per subchunk from
 * y = -64 upward. Each storage is a header byte, packed palette indexes, and a
 * palette of biome ids. Surface scans need only a few voxels per chunk, so each
 * lookup reads one packed word and one palette entry.
 */
export class Data3DBiomes {
  private readonly view: DataView;
  /** Byte offset of each subchunk's storage, from the bottom of the world up. */
  private readonly offsets: number[] = [];

  constructor(value: Uint8Array) {
    this.view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    let offset = HEIGHTMAP_BYTES;
    while (offset < value.byteLength && this.offsets.length < SECTION_COUNT) {
      const header = value[offset]!;
      if (header === REPEAT_BELOW) {
        const below = this.offsets.at(-1);
        if (below === undefined) break;
        this.offsets.push(below);
        offset += 1;
        continue;
      }
      const end = this.storageEnd(offset);
      if (end === undefined || end > value.byteLength) break;
      this.offsets.push(offset);
      offset = end;
    }
  }

  at(localX: number, y: number, localZ: number): number | undefined {
    const offset = this.offsets[Math.floor(y / 16) - LOWEST_SECTION];
    if (offset === undefined) return undefined;
    const bits = this.view.getUint8(offset) >>> 1;
    // A storage with zero bits holds a single biome and no length.
    if (bits === 0) return this.view.getInt32(offset + 1, true);

    const perWord = Math.floor(32 / bits);
    const index = localX * 256 + localZ * 16 + (y & 15);
    const word = this.view.getUint32(offset + 1 + Math.floor(index / perWord) * 4, true);
    const paletteIndex = (word >>> ((index % perWord) * bits)) & ((1 << bits) - 1);
    const palette = offset + 1 + Math.ceil(BIOMES_PER_SECTION / perWord) * 4;
    if (paletteIndex >= this.view.getInt32(palette, true)) return undefined;
    return this.view.getInt32(palette + 4 + paletteIndex * 4, true);
  }

  /** Where the storage at `offset` ends, or undefined when its header is not a disk storage. */
  private storageEnd(offset: number): number | undefined {
    const header = this.view.getUint8(offset);
    // Runtime palettes, flagged by a clear low bit, never appear on disk.
    if ((header & 1) === 0) return undefined;
    const bits = header >>> 1;
    if (bits === 0) return offset + 5;
    if (bits > 16) return undefined;

    const palette = offset + 1 + Math.ceil(BIOMES_PER_SECTION / Math.floor(32 / bits)) * 4;
    if (palette + 4 > this.view.byteLength) return undefined;
    const length = this.view.getInt32(palette, true);
    if (length < 1 || length > BIOMES_PER_SECTION) return undefined;
    return palette + 4 + length * 4;
  }
}
