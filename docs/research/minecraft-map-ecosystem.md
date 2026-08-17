# Minecraft web-map research for Amelix

Checked 2026-08-16. Sources below are first-party project sites, official documentation, or project repositories.

## Bottom line

- **uNmINeD is a strong, maintained Bedrock renderer, but its exported web map is generated output, not a server-integrated live map.** It reads saved Java or Bedrock world files and exports an image or web page. Its CLI can be scheduled, but the exported viewer has no built-in live player feed. More importantly, uNmINeD is closed source and its license forbids modification, so it is not a legal source-port candidate. [Product page](https://unmined.net/), [downloads](https://unmined.net/downloads/), [license](https://unmined.net/license/)
- **Java Edition has several mature live maps; Bedrock does not have an equivalent dominant open-source product.** BlueMap, squaremap, and Dynmap are strong, maintained Java server integrations. None lists BDS/Bedrock as a target. [BlueMap](https://github.com/BlueMap-Minecraft/BlueMap), [squaremap](https://github.com/jpenilla/squaremap), [Dynmap](https://github.com/webbukkit/dynmap)
- **Live players do not require a terrain-renderer port.** BDS scripts can read all active players, their locations, and dimensions, then send snapshots to a relay with `@minecraft/server-net`. The browser can draw these over existing uNmINeD tiles. [World API](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/world?view=minecraft-bedrock-stable), [Entity API](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/entity?view=minecraft-bedrock-stable), [server-net](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server-net/minecraft-server-net?view=minecraft-bedrock-experimental)
- **The strongest starting point for a TypeScript implementation is Mojang's own Minecraft Creator Tools, not a mechanical port.** Its MIT-licensed, alpha codebase already contains a React/Leaflet Bedrock world map, a TypeScript LevelDB parser, lazy browser-side chunk rendering, file-watch/WebSocket terrain invalidation, and BDS player polling. [README](https://github.com/Mojang/minecraft-creator-tools/blob/main/app/jsnode/README.md), [WorldMap.tsx](https://github.com/Mojang/minecraft-creator-tools/blob/main/app/src/UX/world/WorldMap.tsx), [MCWorld.ts](https://github.com/Mojang/minecraft-creator-tools/blob/main/app/src/minecraft/MCWorld.ts), [DedicatedServer.ts](https://github.com/Mojang/minecraft-creator-tools/blob/main/app/src/local/DedicatedServer.ts)

## Renderer comparison

| Project | Edition/platform | Terrain updates | Live players | Assessment |
|---|---|---|---|---|
| [uNmINeD](https://unmined.net/) | Java and Bedrock world files; .NET GUI/CLI | Re-run/export from saved data; CLI is automatable. Reading a live Bedrock DB is explicitly not guaranteed safe. | Saved player markers exist, but no server live-player channel in exported maps. | Best polished local/cross-edition 2D Bedrock renderer found. Actively maintained, with current dev downloads and 2026 releases. Closed source; no modification or redistribution. |
| [Minecraft Creator Tools](https://github.com/Mojang/minecraft-creator-tools) | Bedrock/BDS; TypeScript/React/Leaflet | Watches BDS world storage, parses changed `.ldb`/`.log` files incrementally, identifies affected chunks, and pushes invalidation through WebSockets. | Polls `querytarget @a` every five seconds and sends `playerMoved` notifications. | Most relevant open TypeScript foundation. Produced by Mojang and MIT licensed, but explicitly pre-release alpha and designed as a broader creator/server-admin tool, not yet a polished public map product. |
| [BedrockMap](https://www.bedrockmap.net/) | Hosted Bedrock and Java service | Paid service advertises auto-updating maps. | Its BDS add-on sends coordinates about every five seconds through the official Script API/network module. [Guide](https://www.bedrockmap.net/guides/live-player-tracking) | Proof that the add-on + relay architecture works in production. Hosted/commercial, not a reusable open renderer. |
| [PapyrusCS](https://github.com/papyrus-mc/papyruscs) | Bedrock; C#/.NET + native LevelDB | Incremental tile output using chunk CRCs, but requires another renderer run/upload. | Generates player marker data, not a live server feed. | Apache-2.0 prior art, but its README still identifies version 0.5.0/.NET Core 3.1 from 2020. Not a current-format base without substantial repair. |
| [papyrus.js](https://github.com/papyrus-mc/papyrusjs) | Bedrock; Node.js/JavaScript + LevelDB | Auto-update and live players were only planned. | Planned only. | Important proof that a JS Bedrock renderer is feasible, but the owner archived it in December 2020 and labels it unstable alpha. Apache-2.0. |
| [Atlas-plus](https://github.com/Maskviva/Atlas-plus) | Bedrock via LeviLamina; Rust server mod + browser JS | LevelDB bootstrap plus live dirty/rescanned chunks, PNG tiles over WebSocket. | Live markers. | Useful architecture prototype, not a dependable base: extremely small project with no releases. |
| [BlueMap](https://github.com/BlueMap-Minecraft/BlueMap) | Java: Paper/Spigot, Sponge, Fabric, Forge, NeoForge, CLI | Plugin/mod reads world files and renders changed data asynchronously. | Built-in live player markers through its web server. [Plugin config](https://bluemap.bluecolored.de/wiki/configs/Plugin.html) | Strongest high-fidelity/3D Java option. Current and actively maintained. No Bedrock world/BDS target. |
| [squaremap](https://github.com/jpenilla/squaremap) | Java: Paper, Fabric, NeoForge, Sponge | Server plugin/mod manages a live top-down map. | Built-in markers with yaw, health, and armor. | Strong lightweight, vanilla-style 2D Java option. MIT licensed; frontend already uses Bun/Vite/Leaflet. No Bedrock target. |
| [Dynmap](https://github.com/webbukkit/dynmap) | Java: Spigot/Paper, Forge, Fabric | Real-time server map. | Live player display is part of the established map model. | Mature and extensible, but Java-only and its own README places extra conditions on distributed unofficial ports beyond Apache-2.0. |
| [MinedMap](https://github.com/neocturne/MinedMap) | Java world files; Rust + Leaflet | Fast incremental rerenders; intended to run frequently, such as once per minute. | No integrated live players. | Strong modern static/incremental Java renderer, not Bedrock. |

There is therefore no single cross-edition “SOTA.” For Java live maps, BlueMap leads on visual fidelity, while squaremap leads on a simple, fast 2D map. For Bedrock offline rendering, uNmINeD is the polished option. For an open dynamic Bedrock foundation, Mojang Minecraft Creator Tools is the most relevant code found.

## What “static” means for uNmINeD

uNmINeD is not abandoned. Its download channel and 2026 release notes show active development and current Java/Bedrock format support. Its model is still file-based: read a saved world, render a browsable 2D map, then export an image or web page. The CLI makes periodic generation possible, but this is not the same as a live server plugin with a terrain/player event stream.

The Bedrock safety issue matters. uNmINeD's FAQ says concurrent access to a running Bedrock world is not known to be safe and recommends closing Minecraft for certainty. That makes direct polling of the live BDS LevelDB a poor core contract unless the implementation is built and tested specifically for safe snapshots or consumes server events instead. [uNmINeD FAQ](https://unmined.net/faq/)

The license is a hard stop for the proposed port: uNmINeD calls itself closed source and says not to distribute or modify it. A new implementation can reproduce documented file-format behavior independently, but it cannot be a source-level uNmINeD port. [uNmINeD license](https://unmined.net/license/)

## Live Bedrock data options

### Official Script API

A small behavior pack can run server-side and:

1. Call `world.getAllPlayers()`.
2. Read each player's inherited `Entity.location`, `Entity.dimension.id`, and stable entity ID.
3. Run this on an interval with `system.runInterval()`.
4. Send a compact JSON snapshot or delta to a Node/TS relay through `@minecraft/server-net` HTTP or outbound WebSocket support.
5. Let the map frontend consume a WebSocket/SSE feed and update markers without touching terrain tiles.

Sources: [World.getAllPlayers](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/world?view=minecraft-bedrock-stable), [Entity properties](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/entity?view=minecraft-bedrock-stable), [System.runInterval](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/system?view=minecraft-bedrock-stable), [BDS scripting and external services](https://learn.microsoft.com/en-us/minecraft/creator/documents/bedrockserver/scripting?view=minecraft-bedrock-stable), [server-net](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server-net/minecraft-server-net?view=minecraft-bedrock-experimental).

`@minecraft/server-net` is BDS-only and remains pre-release/version-sensitive. It does not work on Realms or ordinary clients. That is acceptable for Amelix if it controls its BDS deployment, but it needs version pinning and a fallback/reconnect design.

Terrain events cover player block placement/breaking, explosions, pistons, and several natural changes, but they are not a guaranteed complete terrain-delta log. A dynamic renderer should mark chunks dirty from events and also do bounded rescans near players or compare saved chunk generations. [WorldAfterEvents](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/worldafterevents?view=minecraft-bedrock-stable), [Dimension API](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/dimension?view=minecraft-bedrock-stable)

### Endstone

[Endstone](https://github.com/EndstoneMC/endstone) is a maintained BDS wrapper with Python and C++ plugin APIs. It provides online players, actor location/dimension, scheduled tasks, `PlayerMoveEvent`, and broad block/chunk/world events. It is a practical adapter if Amelix already accepts a native BDS extension layer. [Server API](https://endstone.dev/latest/reference/python/server/), [Actor API](https://endstone.dev/latest/reference/python/actor/), [scheduler](https://endstone.dev/latest/reference/python/scheduler/), [events](https://endstone.dev/v0.11/reference/python/event/)

## Is a TypeScript/browser port sensible?

**TypeScript: yes. Browser-only: no. Mechanical port: no.**

Moving the terrain renderer to browser code does not create access to the server. A remote browser cannot read BDS memory or its LevelDB directory. It still needs a trusted server-side adapter that provides tiles, chunk data, or change events. Player overlays are independent of terrain rendering and should be implemented first.

Pure TypeScript parsing/rendering is technically feasible: both archived PapyrusJS and current Mojang Creator Tools demonstrate it. The hard work is not drawing pixels. It is tracking Bedrock's changing LevelDB/chunk encodings, block palettes, resource packs, dimensions, concurrent writes, memory, and cache invalidation. These are precisely the parts most likely to fail in a fast generated port.

Mojang Creator Tools already implements much of the desired split:

- `WorldMap.tsx` renders Leaflet canvas tiles in the browser with lazy visible-chunk loading and selective cache invalidation.
- `MCWorld.ts` parses Bedrock LevelDB data and incrementally reloads changed `.ldb`/`.log` files.
- `HttpServer.ts` carries storage and `playerMoved` events over WebSockets.
- `DedicatedServer.ts` polls BDS player positions with `querytarget @a`.
- `LiveWorldState.ts` also contains a protocol-fed live chunk model for block and subchunk updates.

Sources: [WorldMap.tsx](https://github.com/Mojang/minecraft-creator-tools/blob/main/app/src/UX/world/WorldMap.tsx), [MCWorld.ts](https://github.com/Mojang/minecraft-creator-tools/blob/main/app/src/minecraft/MCWorld.ts), [HttpServer.ts](https://github.com/Mojang/minecraft-creator-tools/blob/main/app/src/local/HttpServer.ts), [DedicatedServer.ts](https://github.com/Mojang/minecraft-creator-tools/blob/main/app/src/local/DedicatedServer.ts), [LiveWorldState.ts](https://github.com/Mojang/minecraft-creator-tools/blob/main/app/src/minecraft/client/LiveWorldState.ts).

## Recommendation

Build this in three risk-controlled stages:

1. **Live overlay now:** keep the existing uNmINeD tiles. Add a BDS behavior pack or Endstone plugin that publishes player `{id, name, dimension, x, y, z, yaw}` snapshots to a small authenticated TS relay. Render markers in the existing OpenLayers page. This proves the live path without replacing terrain.
2. **Dynamic terrain prototype:** extract or adapt the MIT-licensed map/LevelDB pieces from Mojang Minecraft Creator Tools into a focused spike. Test current Amelix world fixtures, map-color parity, large-world memory, and safe behavior while BDS writes. Also inspect Atlas-plus only as a compact design reference.
3. **Choose the production renderer after measurements:** either keep server-rendered incremental tiles, or send compressed chunk/delta data and render canvas tiles in browser workers. Prefer Rust/WASM or native server code only if profiling proves TS parsing/rendering is the bottleneck. Do not start with a full clean-room rewrite of uNmINeD.

This gives Amelix live players quickly, preserves the good existing terrain map, and turns the difficult renderer work into an evidence-based follow-up rather than the first dependency.
