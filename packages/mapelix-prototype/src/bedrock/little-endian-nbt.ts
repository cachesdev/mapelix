/** The NBT tag types used by Bedrock's little-endian network storage. */
export const LittleEndianNbtTag = {
  End: 0,
  Byte: 1,
  Short: 2,
  Int: 3,
  Long: 4,
  Float: 5,
  Double: 6,
  ByteArray: 7,
  String: 8,
  List: 9,
  Compound: 10,
  IntArray: 11,
  LongArray: 12,
} as const;

type LittleEndianNbtTag = (typeof LittleEndianNbtTag)[keyof typeof LittleEndianNbtTag];

export interface LittleEndianNbtCompoundValue {
  readonly [name: string]: LittleEndianNbtValue;
}

export interface LittleEndianNbtList extends ReadonlyArray<LittleEndianNbtValue> {}

export type LittleEndianNbtValue =
  | bigint
  | boolean
  | number
  | LittleEndianNbtList
  | LittleEndianNbtCompoundValue
  | string
  | Uint8Array;

export interface LittleEndianNbtCompound {
  readonly value: LittleEndianNbtCompoundValue;
  /** The first unread byte after this root compound. */
  readonly nextOffset: number;
}

const textDecoder = new TextDecoder();
const maxDepth = 64;

class Reader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  offset: number;

  constructor(bytes: Uint8Array, offset: number) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = offset;
  }

  private require(length: number): void {
    if (length < 0 || this.offset > this.bytes.byteLength - length) {
      throw new Error("Malformed little-endian NBT: unexpected end of input");
    }
  }

  readUint8(): number {
    this.require(1);
    const result = this.view.getUint8(this.offset);
    this.offset += 1;
    return result;
  }

  readInt8(): number {
    this.require(1);
    const result = this.view.getInt8(this.offset);
    this.offset += 1;
    return result;
  }

  readInt16(): number {
    this.require(2);
    const result = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return result;
  }

  readUint16(): number {
    this.require(2);
    const result = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return result;
  }

  readInt32(): number {
    this.require(4);
    const result = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return result;
  }

  readInt64(): bigint {
    this.require(8);
    const result = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return result;
  }

  readFloat32(): number {
    this.require(4);
    const result = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return result;
  }

  readFloat64(): number {
    this.require(8);
    const result = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return result;
  }

  readString(): string {
    const length = this.readUint16();
    this.require(length);
    const result = textDecoder.decode(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return result;
  }

  readLength(): number {
    const length = this.readInt32();
    if (length < 0) {
      throw new Error("Malformed little-endian NBT: negative array or list length");
    }
    return length;
  }
}

function readValue(reader: Reader, type: number, depth: number): LittleEndianNbtValue {
  if (depth > maxDepth) {
    throw new Error("Malformed little-endian NBT: nesting is too deep");
  }

  switch (type) {
    case LittleEndianNbtTag.Byte:
      return reader.readInt8();
    case LittleEndianNbtTag.Short:
      return reader.readInt16();
    case LittleEndianNbtTag.Int:
      return reader.readInt32();
    case LittleEndianNbtTag.Long:
      return reader.readInt64();
    case LittleEndianNbtTag.Float:
      return reader.readFloat32();
    case LittleEndianNbtTag.Double:
      return reader.readFloat64();
    case LittleEndianNbtTag.ByteArray: {
      const length = reader.readLength();
      const result = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        result[index] = reader.readUint8();
      }
      return result;
    }
    case LittleEndianNbtTag.String:
      return reader.readString();
    case LittleEndianNbtTag.List: {
      const itemType = reader.readUint8() as LittleEndianNbtTag;
      if (itemType === LittleEndianNbtTag.End) {
        throw new Error("Malformed little-endian NBT: list cannot contain end tags");
      }
      const length = reader.readLength();
      const result: LittleEndianNbtValue[] = [];
      for (let index = 0; index < length; index += 1) {
        result.push(readValue(reader, itemType, depth + 1));
      }
      return result;
    }
    case LittleEndianNbtTag.Compound:
      return readCompoundValue(reader, depth + 1);
    case LittleEndianNbtTag.IntArray: {
      const length = reader.readLength();
      const result: number[] = [];
      for (let index = 0; index < length; index += 1) {
        result.push(reader.readInt32());
      }
      return result;
    }
    case LittleEndianNbtTag.LongArray: {
      const length = reader.readLength();
      const result: bigint[] = [];
      for (let index = 0; index < length; index += 1) {
        result.push(reader.readInt64());
      }
      return result;
    }
    case LittleEndianNbtTag.End:
      throw new Error("Malformed little-endian NBT: end tag cannot be a value");
    default:
      throw new Error(`Malformed little-endian NBT: unsupported tag type ${type}`);
  }
}

function readCompoundValue(
  reader: Reader,
  depth: number,
): Readonly<Record<string, LittleEndianNbtValue>> {
  const result: Record<string, LittleEndianNbtValue> = {};
  for (;;) {
    const type = reader.readUint8() as LittleEndianNbtTag;
    if (type === LittleEndianNbtTag.End) {
      return result;
    }
    const name = reader.readString();
    result[name] = readValue(reader, type, depth);
  }
}

/**
 * Reads one complete, unnamed little-endian NBT compound from a palette.
 */
export function readLittleEndianNbtCompound(
  bytes: Uint8Array,
  offset = 0,
): LittleEndianNbtCompound {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.byteLength) {
    throw new Error("Malformed little-endian NBT: invalid root offset");
  }

  const reader = new Reader(bytes, offset);
  const type = reader.readUint8();
  if (type !== LittleEndianNbtTag.Compound) {
    throw new Error(`Malformed little-endian NBT: expected compound root, got tag type ${type}`);
  }
  reader.readString(); // Palette roots are unnamed, but NBT still stores the name.

  return { value: readCompoundValue(reader, 0), nextOffset: reader.offset };
}

/** Extracts the block name from a Bedrock palette compound. */
export function blockNameFromPaletteEntry(entry: LittleEndianNbtCompound): string {
  const name = entry.value.name;
  if (typeof name !== "string") {
    throw new Error("Malformed Bedrock palette entry: missing string name");
  }
  return name.includes(":") ? name : `minecraft:${name}`;
}
