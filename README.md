# Custom Spec 2.0 Engine Workspace

A high-performance 3D engine built on top of WebGPU, Babylon.js, and TypeScript, designed for large-scale graphics operations.

## Directory Structure
- `src/core/`: Core rendering engine (Indirect Batcher, Buffer Manager).
- `src/loaders/`: Custom 3D Tiles 1.1/2.0 loaders and GAL (Global Asset Library) parser.
- `src/shaders/`: WGSL (WebGPU Shading Language) files (Hi-Z, QEM, ID-Pass).
- `src/plugins/`: Extension system (CCTV, Sensor-Link, Clash Detection).
- `src/utils/`: Quantization, Math, and Performance Logging.
- `public/`: Static assets, GAL samples, and test tilesets.

## Quick Start

### 1. Install Dependencies
Run the following command to download dependencies:
```bash
npm install
```

### 2. Development Server
To launch the Vite development server with hot-reload:
```bash
npm run dev
```

### 3. Build for Production
To typecheck and build an optimized production bundle:
```bash
npm run build
```

### 4. Preview Build
To preview the production build locally:
```bash
npm run preview
```

## Technologies Used
- **Babylon.js** (`@babylonjs/core`): Advanced 3D rendering engine utilized specifically for WebGPU stable backend support.
- **3D-Tiles-Renderer** (`3d-tiles-renderer`): Standard implementation for geospatial massive data visualization, to be customized for GAL parser phase.
- **dat.gui**: Simplistic UI for real-time engine parameter monitoring and tweaking (FPS, GPU Time).
- **Vite & TypeScript**: Blazing fast ES module build system ensuring high code quality.

## Features Currently Implemented
- **WebGPU Initiation**: Full WebGPU async canvas setup.
- **Scene Initialization**: A basic scalable boilerplate scene object system.
- **GPU Tracker Dummy System**: A foundational skeleton performance monitor for frame-time.
- **Global Buffer Singleton**: Architecture ready to allocate and map raw SSBO / StorageBuffers for the upcoming Indirect Batcher module.
