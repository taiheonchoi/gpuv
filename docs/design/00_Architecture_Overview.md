Custom Spec 2.0 Engine - Architecture Overview

Version: 1.0
Date: 2026-02-23

1. Introduction

The Custom Spec 2.0 Engine is a highly optimized, WebGPU-first 3D engine designed to visualize massive scale digital twins (handling 8M+ instances seamlessly). Built on top of Babylon.js and Vite, this engine bypasses traditional CPU-bound rendering limitations by tightly integrating low-level GPU compute operations, indirect rendering, and zero-latency data stream mapping.

2. Core Objectives

Massive Scale Rendering (8M+ Instances): Execute draw commands using drawIndexedIndirect without causing CPU looping overhead.

Zero-Latency GPU Culling: Utilize WebGPU Compute Shaders to perform Frustum and Hi-Z Occlusion culling purely on the GPU.

Real-time IoT Integration: Sync High-frequency Sensor and CCTV data straight into GPU buffers, updating visual representations without rebuilding scene trees.

Memory Efficiency: Avoid copying large chunks of instantiated float vectors in JavaScript. Rely on explicit garbage collection and GPU-side allocations (StorageBuffer).

3. Directory Structure

/src
├── core/
│   ├── ComputeCullingManager.ts  # GPU Compute Culling Lifecycle
│   ├── Engine.ts                 # WebGPU Engine Setup Boilerplate
│   ├── GlobalBufferManager.ts    # VRAM Storage Buffer Allocator (SSBOs)
│   ├── PickingManager.ts         # Asynchronous R32Uint Picking System
│   ├── SceneSetup.ts             # Camera/Environment Setup
│   ├── SensorLinkManager.ts      # IoT Data Stream -> VRAM mapping
│   └── WebGPUIndirectBatcher.ts   # Core `drawIndexedIndirect` Controller
├── loaders/
│   ├── AssetLibraryLoader.ts     # Global Asset Library (GAL) Parser
│   ├── CustomTileParser.ts       # 3D Tiles 2.0 Instancing Payload Parser
│   └── TilesetHierarchyParser.ts # THIE Binary Hierarchy Parser
├── plugins/
│   ├── CCTVSystem.ts             # PTZ Camera Simulation & Visualization
│   ├── IndirectRenderPlugin.ts   # Babylon bypass hooking
│   └── SemanticSearch.ts         # Logic for querying and coloring Metadata
├── shaders/
│   ├── culling.wgsl              # Compute Shader: Frustum, LOD, Hi-Z, Atomic Counters
│   ├── ghost_effect.wgsl         # Digital Ghost / Outlines / Health Checks WGSL
│   ├── hiz_generator.wgsl        # Compute Shader: Hi-Z depth mipmap construction
│   └── indirect.wgsl             # Main Shader: Batched PBR & Mappings
└── utils/
    └── Quantization.ts           # Dequantization utilities for Uint16/Int16 payloads


4. Development Pipeline

Vite + TypeScript handles blazing fast hot-reload builds. Strict TS configurations ensure error-free data handling required for memory manipulation standard to WebGPU rules (Like std430 matrix offsets and Uint32 paddings).