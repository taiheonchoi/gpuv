# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Custom Spec 2.0 Engine — a WebGPU-first 3D engine for massive-scale digital twin visualization (8M+ instances). Built on Babylon.js with TypeScript and Vite. The engine bypasses CPU-bound rendering by using GPU compute culling, indirect draw calls (`drawIndexedIndirect`), and direct VRAM buffer manipulation.

## Build & Dev Commands

```bash
npm install          # Install dependencies
npm run dev          # Vite dev server on localhost:3000 (auto-opens browser)
npm run build        # TypeScript check + Vite production build
npm run preview      # Preview production build locally
```

No test framework is configured. No linter is configured. TypeScript strict mode is enabled with `noUnusedLocals` and `noUnusedParameters`.

## Architecture

### Rendering Pipeline (GPU-Driven)

The engine avoids CPU-side per-mesh loops. Instead:

1. **GlobalBufferManager** (singleton) pre-allocates large `StorageBuffer`s on the GPU for instance TRS matrices (16 floats/instance, std430 aligned), batch IDs (16-byte aligned), and indirect draw arguments
2. **ComputeCullingManager** runs frustum + Hi-Z occlusion culling entirely on GPU via compute shaders, writing surviving instance indices atomically into `visibleInstanceIndices`
3. **WebGPUIndirectBatcher** issues `drawIndexedIndirect` calls that read instance counts from the GPU-written indirect buffer — zero CPU iteration
4. **IndirectRenderPlugin** hooks into Babylon.js `onEndFrameObservable` to inject a custom low-level render pass with its own `GPUCommandEncoder`, bypassing Babylon's built-in CPU culling

### Data Flow: Tiles → GPU

`CustomTileParser` detects `custom_spec: "2.0"` tilesets → extracts `EXT_mesh_gpu_instancing` from glTF nodes → dequantizes positions via `Quantization.dequantizePositions()` (handles Int16/Uint16) → packs into 4x4 identity matrices with translation in column 3 → streams directly to `GlobalBufferManager.appendInstanceData()` → GPU buffers updated via `COPY_DST`

### Shader Health State Protocol

The `sensorHealthBuffers` float array encodes per-instance visual state used across multiple WGSL shaders:
- `0.0` = Normal (green outline)
- `1.0` = Delayed (yellow dotted)
- `2.0` = Disconnected/Danger (red pulsing ghost, alpha 0.5)
- `3.0` = Highlighted/Selected (blue glow)

This buffer is shared between `ghost_effect.wgsl`, `clash_detection.wgsl`, `SemanticSearch`, and `AppearanceManager`.

### AI/MCP Integration Layer

- **MCPEngineBridge**: Maps MCP tool calls (search, navigate, filter, clash sweep) to engine manager methods. Tool definitions in `MCP_TOOLS` array
- **AIContextManager**: Converts NLP command strings (`HIGHLIGHT_SYSTEM`, `FIND_AND_VIEW`, `ANALYZE_INTERFERENCE`) into engine operations
- **AutonomousAgent**: Idle-time self-diagnostic that sweeps for clash breaches and sensor disconnects, auto-navigates camera to hazards

### Key Patterns

- **Raw GPUDevice access**: Multiple managers cast `(engine as any)._device` to get the native WebGPU device. This is intentional for low-level control beyond Babylon's API surface
- **Buffer memory layout**: All GPU buffers follow std430 alignment. TRS = 16 floats (4x4 matrix), BatchID = 4 uint32s (with padding), BoundingVolume = 8 floats (32 bytes), IndirectDraw = 5 uint32s per command
- **Atomic counters in WGSL**: Culling and clash shaders use `atomicAdd` on `IndirectDrawArgs.instanceCount` and `clashResultCount` to avoid CPU roundtrips
- **Async GPU readback**: `PickingManager.pickAsync()` and `ClashDetectionManager.analyzeInterferenceAsync()` use `mapAsync(GPUMapMode.READ)` with 256-byte aligned read buffers

### Module Dependency Graph

```
main.ts → EngineSetup
  ├── SceneSetup (camera, lights, dat.gui perf monitor)
  ├── GlobalBufferManager (singleton, all GPU storage buffers)
  │   ├── WebGPUIndirectBatcher (indirect draw commands)
  │   ├── ComputeCullingManager (frustum/HiZ culling)
  │   ├── CustomTileParser (tile → GPU streaming)
  │   └── SensorLinkManager (IoT telemetry → TRS buffer)
  ├── PickingManager (R32Uint GPU picking)
  ├── ClashDetectionManager (sphere-sphere GPU clash)
  ├── AppearanceManager (health state buffer writes)
  ├── NavigationCore (camera animation to batchId positions)
  ├── CollaborationManager (multi-user delta sync)
  └── AIContextManager / MCPEngineBridge / AutonomousAgent
```

### WGSL Shaders

- `culling.wgsl` — Compute: frustum cull + LOD SSE + Hi-Z occlusion, writes `visibleInstanceIndices`
- `indirect.wgsl` — Vertex/Fragment: instanced PBR rendering with LOD dissolve dither, dual output (color + R32Uint picking ID)
- `ghost_effect.wgsl` — Vertex/Fragment: health-state-driven visualization (rim outlines, ghost, highlight)
- `hiz_generator.wgsl` — Compute: min-depth mipmap pyramid construction
- `clash_detection.wgsl` — Compute: sphere-sphere interference, atomic result collection, direct health buffer write

### SDK (Node.js)

`src/sdk/TilerSDK.ts` is a **server-side** module (imports `fs`, `path`) for converting CAD/BIM data into Spec 2.5 binary format (THIE hierarchy.bin + metadata.bin). It uses Morton codes for spatial sorting. Not part of the browser bundle.

## WebGPU Constraints

- Requires a WebGPU-capable browser (Chrome 113+, Edge 113+, Firefox Nightly)
- Buffer sizes follow 256-byte alignment for `MAP_READ` operations
- `StorageBuffer` uses `Constants.BUFFER_CREATIONFLAG_READWRITE` (maps to `GPUBufferUsage.STORAGE | COPY_DST`)
- Compute workgroup size is 64 threads across all compute shaders
