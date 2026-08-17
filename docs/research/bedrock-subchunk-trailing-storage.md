# Bedrock subchunk trailing storage

## Finding

The exact error `unexpected trailing data after 2 storage area(s)` is reproduced
by a zero-bit **block** storage palette. It is not a third storage area and it is
not Data3D biome data.

The Amelix record was deliberately not opened or inspected. Therefore, the
zero-bit singleton is the format-level diagnosis that exactly matches the
reported failure, but its presence in that specific record is an inference, not
a direct byte-level observation.

For subchunk v8, the value prefix is `version, storageCount`; v9 adds the signed
section Y byte. `storageCount` counts block layers: the first is the primary
layer and the optional second layer is the auxiliary/waterlogged layer. Mojang's
`WorldChunk.parseSubChunk` identifies and iterates these fields explicitly.
([source](https://github.com/Mojang/minecraft-creator-tools/blob/77fdb1f1083616d4c21f7bf4b55a49695051990d/app/src/minecraft/WorldChunk.ts#L1545-L1574))

Each persistent block layer starts with `bitsPerBlock << 1`. For a nonzero bit
width, packed index words are followed by a little-endian 32-bit palette count
and that many little-endian NBT compounds. A zero bit width is the constant
palette form: it has no packed words and no explicit palette-count field; its
single implicit palette entry is one NBT compound directly after the storage
header. Mojang's source records the observed zero-bit/NBT case and shows the
one-entry parse that its current live code leaves disabled.
([source](https://github.com/Mojang/minecraft-creator-tools/blob/77fdb1f1083616d4c21f7bf4b55a49695051990d/app/src/minecraft/WorldChunk.ts#L1574-L1617))
PapyrusCs implements that exact branch by creating a one-entry palette and
reading one NBT value without first reading a count.
([source](https://github.com/papyrus-mc/papyruscs/blob/fa55835525537164eb06f7662dd8715f12a45c86/Maploader/World/World.cs#L337-L374))

Mapelix already makes the zero-filled 4,096-entry index array correctly, but
[`decodeStorage`](../../packages/mapelix/src/bedrock/subchunk.ts#L69) returns
immediately for zero bits with an empty palette and leaves the NBT unread. After
the declared two layers have been visited,
[`decodeSubchunk`](../../packages/mapelix/src/bedrock/subchunk.ts#L150) sees
those NBT bytes and reports them as trailing data. Thus the message means “the
declared layers were counted, but the final layer was under-consumed.”

Data3D cannot be that tail. It is a separate LevelDB record (tag 43), and its
biome palette grammar is different: zero bits has one little-endian `int32`
biome ID, not an NBT block entry. Mapelix decodes it separately in
[`decodeData3D`](../../packages/mapelix/src/bedrock/data-3d.ts#L94).

## Synthetic reproduction

A recommended regression in
[`subchunk.test.ts`](../../packages/mapelix/src/bedrock/subchunk.test.ts) should
construct only these bytes:

1. v9 prefix with `storageCount = 2`;
2. a normal packed primary layer;
3. auxiliary header `0x00`, followed directly by one `minecraft:water` NBT
   palette compound.

The equivalent temporary, standalone reproduction fails with the exact
reported error. No world was opened or read.

```text
RED: Malformed Bedrock subchunk: unexpected trailing data after 2 storage area(s)
```

## Minimal fix and test

In `decodeStorage`, when `bitsPerBlock === 0`, read exactly one NBT compound at
`packed.nextOffset`, return its block name as the one-entry palette, and advance
`nextOffset` to the compound's end. Keep the all-zero index array and the final
exact-length check. Then:

- make the new auxiliary-layer test pass;
- change the existing synthetic header-only zero-bit v9 test to append an
  implicit `minecraft:air` NBT entry and expect that one-entry palette;
- add a zero-bit primary-layer case if broader coverage is useful.

Do not fix this by dropping the trailing-data check or by treating the bytes as
another storage. Both changes would hide malformed records and misidentify the
declared layer count.

## Reference behavior and uncertainty

The inspected local uNmINeD `BedrockChunkExtractor.LoadSectionBlocks` reads only
the primary layer, and `LoadSectionBlockStorage` returns after a zero-bit header.
It therefore accepts this input by ignoring bytes that Mapelix validates; it
does not provide evidence that the NBT is absent. Mojang Creator Tools also has
the one-entry zero-bit parse commented out. PapyrusCs supplies the active parser
corroboration.

No allowed source showed a valid header-only zero-bit block layer. Mapelix's
existing header-only test is synthetic, so the strict recommendation is to
replace it rather than add an ambiguous compatibility heuristic. If a future
public fixture proves that a historical header-only form exists, support it as
an explicit versioned exception, not by silently ignoring arbitrary tail bytes.

## Sources inspected

- Mapelix `subchunk.ts`, `subchunk.test.ts`, `data-3d.ts`, and little-endian NBT
  reader.
- Mojang Minecraft Creator Tools commit
  `77fdb1f1083616d4c21f7bf4b55a49695051990d`, `WorldChunk.parseSubChunk`.
- PapyrusCs commit `fa55835525537164eb06f7662dd8715f12a45c86`,
  `World.CopySubChunkToChunk` and `GetNbtVal`.
- Local clean-room inspection of uNmINeD
  `BedrockChunkExtractor.LoadSectionBlocks` and `LoadSectionBlockStorage`; no
  proprietary source was copied.
