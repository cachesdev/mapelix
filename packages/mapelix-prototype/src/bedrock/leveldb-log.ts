const BLOCK_BYTES = 32768;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  for (let bit = 0; bit < 8; bit++) byte = (byte >>> 1) ^ (byte & 1 ? 0x82f63b78 : 0);
  return byte >>> 0;
});

/** LevelDB's masked Castagnoli checksum, independent of Node.js. */
export function maskedCrc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255]!;
  crc = ~crc;
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}

/** Reads physical log frames and reconstructs complete logical records. */
export function* levelDbLogRecords(
  bytes: Uint8Array,
  source: string,
  verifyChecksums = true,
): Generator<Uint8Array> {
  let offset = 0;
  let fragments: Uint8Array[] | undefined;
  const fail = (message: string): never => {
    throw new Error(`${source}: ${message}`);
  };
  while (offset < bytes.length) {
    const remaining = BLOCK_BYTES - (offset % BLOCK_BYTES);
    if (remaining < 7) {
      if (
        offset + remaining > bytes.length ||
        bytes.subarray(offset, offset + remaining).some(Boolean)
      )
        fail("invalid LevelDB log trailer");
      offset += remaining;
      continue;
    }
    if (bytes.length - offset < 7) fail("truncated LevelDB log header");
    const header = new DataView(bytes.buffer, bytes.byteOffset + offset, 7);
    const checksum = header.getUint32(0, true);
    const length = header.getUint16(4, true);
    const type = bytes[offset + 6]!;
    if (type === 0 && length === 0 && checksum === 0) {
      const end = Math.min(bytes.length, offset + remaining);
      if (bytes.subarray(offset, end).some(Boolean))
        fail("invalid zero-filled LevelDB log trailer");
      offset = end;
      continue;
    }
    if (length > remaining - 7 || length > bytes.length - offset - 7)
      fail("invalid LevelDB log record length");
    const payload = bytes.subarray(offset + 7, offset + 7 + length);
    if (
      verifyChecksums &&
      checksum !== maskedCrc32c(bytes.subarray(offset + 6, offset + 7 + length))
    )
      fail("LevelDB log checksum mismatch");
    offset += 7 + length;
    if (type === 1 || type === 2) {
      if (fragments !== undefined) fail("incomplete fragmented LevelDB log record");
      if (type === 1) yield payload;
      else fragments = [payload];
    } else if (type === 3 || type === 4) {
      if (fragments === undefined) fail("LevelDB log fragment without first fragment");
      fragments!.push(payload);
      if (type === 4) {
        const joined = new Uint8Array(fragments!.reduce((sum, part) => sum + part.length, 0));
        let position = 0;
        for (const fragment of fragments!) {
          joined.set(fragment, position);
          position += fragment.length;
        }
        fragments = undefined;
        yield joined;
      }
    } else fail(`unknown LevelDB log record type ${type}`);
  }
  if (fragments !== undefined) fail("incomplete fragmented LevelDB log record");
}
