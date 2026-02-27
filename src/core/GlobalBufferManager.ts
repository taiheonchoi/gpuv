import { WebGPUEngine, StorageBuffer, Constants } from '@babylonjs/core';

/**
 * Return type for appendMeshGeometry — tells the caller where this mesh
 * landed in the atlas so it can wire up the correct indirect draw command.
 */
export interface MeshAtlasEntry {
    drawCommandIndex: number;
    baseVertex: number;
    firstIndex: number;
    indexCount: number;
}

/**
 * Singleton class to manage large-scale WebGPU Storage Buffers.
 *
 * Geometry Atlas with Cross-Chunk Dedup Support:
 * - Shared vertex + index GPU buffers hold all unique mesh geometries
 * - Each unique mesh gets its own indirect draw command (baseVertex/firstIndex)
 * - Cross-chunk dedup: multiple chunks may contribute instances to the SAME
 *   draw command. Since instances are appended linearly to the TRS buffer,
 *   a single draw command's instances may be non-contiguous.
 *
 * Instance Remapping Strategy:
 * - visibleInstanceIndices buffer maps logical instance_index → actual TRS index
 * - Each draw command owns a region in the remap buffer starting at firstInstance
 * - addDrawCommandInstances() appends new TRS indices into the remap region
 * - This allows non-contiguous TRS data to be drawn by a single indirect command
 */
export class GlobalBufferManager {
    private static _instance: GlobalBufferManager | null = null;
    private _engine: WebGPUEngine;

    public instanceTRSBuffer!: StorageBuffer;
    public batchIdBuffer!: StorageBuffer;
    public indirectDrawBuffer!: StorageBuffer;
    public sensorStateBuffer!: StorageBuffer;

    // Native GPUBuffer for indirect draw — needs INDIRECT usage flag
    public indirectDrawGpuBuffer!: GPUBuffer;

    // Geometry Atlas — shared vertex + index GPU buffers
    public vertexAtlasBuffer!: GPUBuffer;   // VERTEX | COPY_DST
    public indexAtlasBuffer!: GPUBuffer;    // INDEX | COPY_DST

    // Visible indices remap buffer — exposed for IndirectRenderPlugin bind group
    public visibleIndicesBuffer!: GPUBuffer;

    // Culling metadata buffers (populated at finalization, read-only during loading)
    public instanceDrawCmdMapBuffer!: GPUBuffer;  // N u32: TRS index → draw command index
    public drawCmdBaseOffsetsBuffer!: GPUBuffer;  // M u32: base offset in remap per command
    public meshBoundsBuffer!: GPUBuffer;          // M × 4 f32: local bounding sphere per mesh

    private _instanceDrawCmdMap!: Uint32Array;
    private _drawCmdBaseOffsets!: Uint32Array;
    private _meshBoundsData!: Float32Array;

    private _trsData: Float32Array;
    private _batchIdData: Uint32Array;
    private _indirectDrawData: Uint32Array;

    // Geometry Atlas CPU-side tracking
    private _vertexData: Float32Array;
    private _indexData: Uint32Array;
    private _vertexCount = 0;
    private _indexCount = 0;
    private readonly INITIAL_VERTEX_CAPACITY = 10_000_000;
    private readonly INITIAL_INDEX_CAPACITY = 30_000_000;

    private _instanceCount: number = 0;
    private _maxDrawCommands: number = 50000;
    private _drawCommandCount = 0;

    // Instance remap tracking: maps logical visible-index → actual TRS index
    // Each draw command owns a contiguous slice: [firstInstance .. firstInstance+instanceCount)
    private _remapData: Uint32Array;
    private _remapCount = 0; // total entries written to remap buffer
    private _remapFinalized = false;

    // Per-draw-command tracking for cross-chunk accumulation
    // Stores [firstInstanceInRemap, instanceCount] per command
    private _drawCommandFirstInstance: number[] = [];
    private _drawCommandInstanceCount: number[] = [];

    // Deferred remap segments: accumulated during loading, compacted in finalizeDrawCommands()
    private _pendingRemapSegments: { cmdIdx: number; firstTrs: number; count: number }[] = [];

    private readonly INITIAL_INSTANCE_CAPACITY = 1000000;

    private constructor(engine: WebGPUEngine) {
        this._engine = engine;

        this._trsData = new Float32Array(this.INITIAL_INSTANCE_CAPACITY * 16);
        this._batchIdData = new Uint32Array(this.INITIAL_INSTANCE_CAPACITY * 4);
        this._indirectDrawData = new Uint32Array(this._maxDrawCommands * 5);

        this._vertexData = new Float32Array(this.INITIAL_VERTEX_CAPACITY * 6);
        this._indexData = new Uint32Array(this.INITIAL_INDEX_CAPACITY);

        // Remap buffer: same capacity as instances (each instance needs one entry)
        this._remapData = new Uint32Array(this.INITIAL_INSTANCE_CAPACITY);

        // Culling metadata CPU arrays
        this._instanceDrawCmdMap = new Uint32Array(this.INITIAL_INSTANCE_CAPACITY);
        this._drawCmdBaseOffsets = new Uint32Array(this._maxDrawCommands);
        this._meshBoundsData = new Float32Array(this._maxDrawCommands * 4);
    }

    public static getInstance(engine?: WebGPUEngine): GlobalBufferManager {
        if (!GlobalBufferManager._instance) {
            if (!engine) throw new Error("Engine required to initialize GlobalBufferManager");
            GlobalBufferManager._instance = new GlobalBufferManager(engine);
            GlobalBufferManager._instance._initializeBuffers();
        }
        return GlobalBufferManager._instance;
    }

    private _initializeBuffers(): void {
        const flags = Constants.BUFFER_CREATIONFLAG_READWRITE;

        this.instanceTRSBuffer = new StorageBuffer(this._engine, this._trsData.byteLength, flags);
        this.batchIdBuffer = new StorageBuffer(this._engine, this._batchIdData.byteLength, flags);
        this.indirectDrawBuffer = new StorageBuffer(this._engine, this._indirectDrawData.byteLength, flags);
        this.sensorStateBuffer = new StorageBuffer(this._engine, this.INITIAL_INSTANCE_CAPACITY * 4, flags);

        const device = (this._engine as any)._device as GPUDevice;
        this.indirectDrawGpuBuffer = device.createBuffer({
            label: 'indirect-draw-native',
            size: this._indirectDrawData.byteLength,
            usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
        });

        this.vertexAtlasBuffer = device.createBuffer({
            label: 'vertex-atlas',
            size: this._vertexData.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.indexAtlasBuffer = device.createBuffer({
            label: 'index-atlas',
            size: this._indexData.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });

        // Visible indices remap buffer (STORAGE for shader access)
        this.visibleIndicesBuffer = device.createBuffer({
            label: 'visible-indices-remap',
            size: this._remapData.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // Culling metadata GPU buffers
        this.instanceDrawCmdMapBuffer = device.createBuffer({
            label: 'instance-draw-cmd-map',
            size: this._instanceDrawCmdMap.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.drawCmdBaseOffsetsBuffer = device.createBuffer({
            label: 'draw-cmd-base-offsets',
            size: this._drawCmdBaseOffsets.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.meshBoundsBuffer = device.createBuffer({
            label: 'mesh-bounds',
            size: this._meshBoundsData.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        console.log(
            `GlobalBufferManager: Allocated. Capacity: ` +
            `${this.INITIAL_INSTANCE_CAPACITY} instances, ` +
            `${this.INITIAL_VERTEX_CAPACITY} vertices, ` +
            `${this.INITIAL_INDEX_CAPACITY} indices, ` +
            `${this._maxDrawCommands} draw commands`
        );
    }

    /**
     * Appends a unique mesh geometry into the shared atlas buffers.
     * Returns atlas offsets for wiring indirect draw commands.
     */
    public appendMeshGeometry(vertices: Float32Array, indices: Uint32Array): MeshAtlasEntry {
        const vertexFloatCount = vertices.length;
        const vertexCount = vertexFloatCount / 6;
        const indexCount = indices.length;

        if (this._vertexCount + vertexCount > this.INITIAL_VERTEX_CAPACITY) {
            console.error("Critical: Vertex atlas capacity exceeded!");
            return { drawCommandIndex: -1, baseVertex: 0, firstIndex: 0, indexCount: 0 };
        }
        if (this._indexCount + indexCount > this.INITIAL_INDEX_CAPACITY) {
            console.error("Critical: Index atlas capacity exceeded!");
            return { drawCommandIndex: -1, baseVertex: 0, firstIndex: 0, indexCount: 0 };
        }
        if (this._drawCommandCount >= this._maxDrawCommands) {
            console.error("Critical: Draw command capacity exceeded!");
            return { drawCommandIndex: -1, baseVertex: 0, firstIndex: 0, indexCount: 0 };
        }

        const baseVertex = this._vertexCount;
        const firstIndex = this._indexCount;
        const drawCommandIndex = this._drawCommandCount;

        // Copy to CPU atlas
        const vertexOffset = this._vertexCount * 6;
        this._vertexData.set(vertices, vertexOffset);
        this._indexData.set(indices, this._indexCount);

        // Upload partial region to GPU
        const device = (this._engine as any)._device as GPUDevice;
        if (device) {
            device.queue.writeBuffer(this.vertexAtlasBuffer, vertexOffset * 4, vertices.buffer, vertices.byteOffset, vertexFloatCount * 4);
            device.queue.writeBuffer(this.indexAtlasBuffer, this._indexCount * 4, indices.buffer, indices.byteOffset, indexCount * 4);
        }

        this._vertexCount += vertexCount;
        this._indexCount += indexCount;

        // Initialize draw command slot
        const cmdOffset = drawCommandIndex * 5;
        this._indirectDrawData[cmdOffset + 0] = indexCount;
        this._indirectDrawData[cmdOffset + 1] = 0;         // instanceCount (accumulated via addDrawCommandInstances)
        this._indirectDrawData[cmdOffset + 2] = firstIndex;
        this._indirectDrawData[cmdOffset + 3] = baseVertex;
        this._indirectDrawData[cmdOffset + 4] = 0;         // firstInstance (set on first addDrawCommandInstances)

        // Compute local-space bounding sphere for this mesh
        let cx = 0, cy = 0, cz = 0;
        for (let i = 0; i < vertexCount; i++) {
            cx += vertices[i * 6 + 0];
            cy += vertices[i * 6 + 1];
            cz += vertices[i * 6 + 2];
        }
        cx /= vertexCount; cy /= vertexCount; cz /= vertexCount;

        let maxRadSq = 0;
        for (let i = 0; i < vertexCount; i++) {
            const dx = vertices[i * 6 + 0] - cx;
            const dy = vertices[i * 6 + 1] - cy;
            const dz = vertices[i * 6 + 2] - cz;
            const rSq = dx * dx + dy * dy + dz * dz;
            if (rSq > maxRadSq) maxRadSq = rSq;
        }
        const bOff = drawCommandIndex * 4;
        this._meshBoundsData[bOff + 0] = cx;
        this._meshBoundsData[bOff + 1] = cy;
        this._meshBoundsData[bOff + 2] = cz;
        this._meshBoundsData[bOff + 3] = Math.sqrt(maxRadSq);

        // Init per-command tracking
        this._drawCommandFirstInstance.push(-1); // -1 = not yet assigned
        this._drawCommandInstanceCount.push(0);
        this._drawCommandCount++;

        return { drawCommandIndex, baseVertex, firstIndex, indexCount };
    }

    /**
     * Appends parsed instance TRS and BatchIDs into the global typed arrays and streams to GPU.
     * Returns the starting TRS index for the appended instances.
     */
    public appendInstanceData(trsData: Float32Array, batchIds: Uint32Array): number {
        const count = batchIds.length;
        if (this._instanceCount + count > this.INITIAL_INSTANCE_CAPACITY) {
            console.error("Critical: Instance capacity exceeded!");
            return this._instanceCount;
        }

        const startIndex = this._instanceCount;
        const trsOffset = this._instanceCount * 16;
        this._trsData.set(trsData, trsOffset);

        for (let i = 0; i < count; i++) {
            const batchOffset = (this._instanceCount + i) * 4;
            this._batchIdData[batchOffset] = batchIds[i];
        }

        // Partial GPU upload
        const device = (this._engine as any)._device as GPUDevice;
        const trsByteOffset = trsOffset * 4;
        const trsByteSize = count * 16 * 4;
        const batchByteOffset = this._instanceCount * 4 * 4;
        const batchByteSize = count * 4 * 4;

        const trsGpuBuffer = (this.instanceTRSBuffer.getBuffer() as any).underlyingResource as GPUBuffer | undefined;
        const batchGpuBuffer = (this.batchIdBuffer.getBuffer() as any).underlyingResource as GPUBuffer | undefined;

        if (device && trsGpuBuffer && batchGpuBuffer) {
            device.queue.writeBuffer(trsGpuBuffer, trsByteOffset, this._trsData.buffer, trsByteOffset, trsByteSize);
            device.queue.writeBuffer(batchGpuBuffer, batchByteOffset, this._batchIdData.buffer, batchByteOffset, batchByteSize);
        } else {
            this.instanceTRSBuffer.update(this._trsData);
            this.batchIdBuffer.update(this._batchIdData);
        }

        this._instanceCount += count;
        if (this._instanceCount % 10000 < count) {
            console.log(`GlobalBufferManager: ${this._instanceCount} instances total`);
        }

        return startIndex;
    }

    /**
     * Accumulates a remap segment for deferred finalization.
     *
     * During chunked loading, the same draw command may receive instances from
     * multiple chunks (cross-chunk dedup). Remap entries arrive interleaved:
     *   chunk1: cmd0(4), cmd1(3)  →  remap: [cmd0, cmd0, cmd0, cmd0, cmd1, cmd1, cmd1]
     *   chunk2: cmd0(6)           →  remap: [..., cmd0, cmd0, cmd0, cmd0, cmd0, cmd0]
     * cmd0's entries are NOT contiguous → GPU reads wrong data.
     *
     * Solution: accumulate segments during loading, then call finalizeDrawCommands()
     * to rebuild the remap buffer with contiguous entries per command.
     */
    public addDrawCommandInstances(commandIndex: number, count: number, firstTrsIndex: number): void {
        if (commandIndex < 0 || commandIndex >= this._drawCommandCount) return;

        this._pendingRemapSegments.push({ cmdIdx: commandIndex, firstTrs: firstTrsIndex, count });
        this._drawCommandInstanceCount[commandIndex] += count;
    }

    /**
     * Rebuilds the remap buffer so each draw command's entries are contiguous.
     * Must be called after all chunks are loaded.
     *
     * Before: remap = [cmd0_a, cmd0_a, cmd1_a, cmd1_a, cmd0_b, cmd0_b, cmd2_a, ...]
     * After:  remap = [cmd0_a, cmd0_a, cmd0_b, cmd0_b, cmd1_a, cmd1_a, cmd2_a, ...]
     *                  ^-- cmd0 contiguous --^  ^-- cmd1 --^    ^cmd2^
     */
    public finalizeDrawCommands(): void {
        if (this._remapFinalized) return;
        this._remapFinalized = true;

        const totalInstances = this._pendingRemapSegments.reduce((sum, s) => sum + s.count, 0);
        console.log(`GlobalBufferManager.finalizeDrawCommands: ${this._pendingRemapSegments.length} segments, ${totalInstances} total instances, ${this._drawCommandCount} commands`);

        if (totalInstances === 0) {
            console.warn('GlobalBufferManager.finalizeDrawCommands: 0 instances — skipping (isFinalized will remain false, no indirect draws).');
            return;
        }
        if (totalInstances > this.INITIAL_INSTANCE_CAPACITY) {
            console.error("Critical: Remap buffer capacity exceeded during finalization!");
            return;
        }

        // Group segments by command index
        const segmentsByCmd = new Map<number, { firstTrs: number; count: number }[]>();
        for (const seg of this._pendingRemapSegments) {
            if (!segmentsByCmd.has(seg.cmdIdx)) {
                segmentsByCmd.set(seg.cmdIdx, []);
            }
            segmentsByCmd.get(seg.cmdIdx)!.push({ firstTrs: seg.firstTrs, count: seg.count });
        }

        // Build contiguous remap buffer: iterate commands in order
        let remapOffset = 0;
        for (let cmdIdx = 0; cmdIdx < this._drawCommandCount; cmdIdx++) {
            const segments = segmentsByCmd.get(cmdIdx);
            if (!segments || segments.length === 0) {
                // No instances for this command
                this._drawCommandFirstInstance[cmdIdx] = 0;
                this._drawCommandInstanceCount[cmdIdx] = 0;
                continue;
            }

            this._drawCommandFirstInstance[cmdIdx] = remapOffset;
            let cmdInstanceCount = 0;

            for (const seg of segments) {
                for (let i = 0; i < seg.count; i++) {
                    this._remapData[remapOffset + cmdInstanceCount + i] = seg.firstTrs + i;
                }
                cmdInstanceCount += seg.count;
            }

            this._drawCommandInstanceCount[cmdIdx] = cmdInstanceCount;
            remapOffset += cmdInstanceCount;

            // Update indirect draw command
            const cmdOffset = cmdIdx * 5;
            this._indirectDrawData[cmdOffset + 1] = cmdInstanceCount;
            this._indirectDrawData[cmdOffset + 4] = this._drawCommandFirstInstance[cmdIdx];
        }

        this._remapCount = remapOffset;

        // Build culling metadata: instanceDrawCmdMap and drawCmdBaseOffsets
        for (let cmdIdx = 0; cmdIdx < this._drawCommandCount; cmdIdx++) {
            const firstInst = this._drawCommandFirstInstance[cmdIdx];
            const count = this._drawCommandInstanceCount[cmdIdx];
            this._drawCmdBaseOffsets[cmdIdx] = firstInst >= 0 ? firstInst : 0;

            for (let i = 0; i < count; i++) {
                const trsIdx = this._remapData[firstInst + i];
                this._instanceDrawCmdMap[trsIdx] = cmdIdx;
            }
        }

        // Upload all buffers to GPU
        const device = (this._engine as any)._device as GPUDevice;
        if (device && this.visibleIndicesBuffer) {
            const byteSize = remapOffset * 4;
            device.queue.writeBuffer(this.visibleIndicesBuffer, 0, this._remapData.buffer, 0, byteSize);
        }

        // Upload entire indirect draw buffer to GPU
        if (device && this.indirectDrawGpuBuffer) {
            const cmdByteSize = this._drawCommandCount * 5 * 4;
            device.queue.writeBuffer(this.indirectDrawGpuBuffer, 0, this._indirectDrawData.buffer, 0, cmdByteSize);
        }

        // Upload culling metadata
        if (device) {
            device.queue.writeBuffer(
                this.instanceDrawCmdMapBuffer, 0,
                this._instanceDrawCmdMap.buffer, 0,
                this._instanceCount * 4
            );
            device.queue.writeBuffer(
                this.drawCmdBaseOffsetsBuffer, 0,
                this._drawCmdBaseOffsets.buffer, 0,
                this._drawCommandCount * 4
            );
            device.queue.writeBuffer(
                this.meshBoundsBuffer, 0,
                this._meshBoundsData.buffer, 0,
                this._drawCommandCount * 4 * 4
            );
            console.log(`GlobalBufferManager: Culling metadata uploaded (${this._instanceCount} instanceCmdMap, ${this._drawCommandCount} baseOffsets + meshBounds)`);
        }

        // Free segment list
        this._pendingRemapSegments = [];

        // Compute bounding box of ALL instance translations
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < this._instanceCount; i++) {
            const o = i * 16;
            const tx = this._trsData[o + 12];
            const ty = this._trsData[o + 13];
            const tz = this._trsData[o + 14];
            if (tx < minX) minX = tx; if (tx > maxX) maxX = tx;
            if (ty < minY) minY = ty; if (ty > maxY) maxY = ty;
            if (tz < minZ) minZ = tz; if (tz > maxZ) maxZ = tz;
        }
        console.log(`GlobalBufferManager: Finalized. ${remapOffset} instances, ${this._drawCommandCount} cmds, ${this._vertexCount} verts, ${this._indexCount} idx`);
        console.log(`GlobalBufferManager: BBOX x=[${minX.toFixed(0)}, ${maxX.toFixed(0)}], y=[${minY.toFixed(0)}, ${maxY.toFixed(0)}], z=[${minZ.toFixed(0)}, ${maxZ.toFixed(0)}], center=(${((minX+maxX)/2).toFixed(0)}, ${((minY+maxY)/2).toFixed(0)}, ${((minZ+maxZ)/2).toFixed(0)})`);
    }

    /**
     * Sets the instance count and firstInstance for a specific draw command.
     * Use for non-dedup scenarios where instances are contiguous.
     */
    public setDrawCommandInstances(commandIndex: number, instanceCount: number, firstInstance: number): void {
        if (commandIndex < 0 || commandIndex >= this._drawCommandCount) return;
        const offset = commandIndex * 5;
        this._indirectDrawData[offset + 1] = instanceCount;
        this._indirectDrawData[offset + 4] = firstInstance;

        const device = (this._engine as any)._device as GPUDevice;
        const byteOffset = offset * 4;
        if (device && this.indirectDrawGpuBuffer) {
            device.queue.writeBuffer(this.indirectDrawGpuBuffer, byteOffset, this._indirectDrawData.buffer, byteOffset, 20);
        }
        this.indirectDrawBuffer.update(this._indirectDrawData);
    }

    /**
     * Legacy: increments instanceCount by delta.
     */
    public updateIndirectDrawCommand(commandIndex: number, instanceCountDelta: number): void {
        if (commandIndex < 0 || commandIndex >= this._maxDrawCommands) return;
        const offset = commandIndex * 5;
        this._indirectDrawData[offset + 1] = Math.max(0, this._indirectDrawData[offset + 1] + instanceCountDelta);
        this.indirectDrawBuffer.update(this._indirectDrawData);
        const device = (this._engine as any)._device as GPUDevice;
        if (device && this.indirectDrawGpuBuffer) {
            device.queue.writeBuffer(this.indirectDrawGpuBuffer, 0, this._indirectDrawData.buffer);
        }
    }

    public initializeDummyBuffer(): void { }

    public syncIndirectDrawNative(): void {
        const device = (this._engine as any)._device as GPUDevice;
        if (device && this.indirectDrawGpuBuffer) {
            device.queue.writeBuffer(this.indirectDrawGpuBuffer, 0, this._indirectDrawData.buffer);
        }
    }

    public get indirectDrawData(): Uint32Array {
        return this._indirectDrawData;
    }

    public get drawCommandCount(): number {
        return this._drawCommandCount;
    }

    public get isFinalized(): boolean {
        return this._remapFinalized;
    }

    public dispose(): void {
        this.instanceTRSBuffer?.dispose();
        this.batchIdBuffer?.dispose();
        this.indirectDrawBuffer?.dispose();
        this.sensorStateBuffer?.dispose();
        this.indirectDrawGpuBuffer?.destroy();
        this.vertexAtlasBuffer?.destroy();
        this.indexAtlasBuffer?.destroy();
        this.visibleIndicesBuffer?.destroy();
        this.instanceDrawCmdMapBuffer?.destroy();
        this.drawCmdBaseOffsetsBuffer?.destroy();
        this.meshBoundsBuffer?.destroy();

        this._trsData = new Float32Array(0);
        this._batchIdData = new Uint32Array(0);
        this._indirectDrawData = new Uint32Array(0);
        this._vertexData = new Float32Array(0);
        this._indexData = new Uint32Array(0);
        this._remapData = new Uint32Array(0);
        this._instanceCount = 0;
        this._vertexCount = 0;
        this._indexCount = 0;
        this._drawCommandCount = 0;
        this._remapCount = 0;
        this._remapFinalized = false;
        this._drawCommandFirstInstance = [];
        this._drawCommandInstanceCount = [];
        this._pendingRemapSegments = [];

        GlobalBufferManager._instance = null;
        console.log("GlobalBufferManager: Disposed and singleton reset.");
    }

    public get instanceCount(): number {
        return this._instanceCount;
    }

    /** Return first N vertex positions from CPU-side atlas for diagnostics */
    public getVertexSamples(n: number): { x: number; y: number; z: number }[] {
        const result: { x: number; y: number; z: number }[] = [];
        for (let i = 0; i < Math.min(n, this._vertexCount); i++) {
            const o = i * 6;
            result.push({ x: this._vertexData[o], y: this._vertexData[o + 1], z: this._vertexData[o + 2] });
        }
        return result;
    }

    /** Return first N TRS matrices (flat 16-float arrays) from CPU-side buffer for diagnostics */
    public getTrsSamples(n: number): Float32Array[] {
        const result: Float32Array[] = [];
        for (let i = 0; i < Math.min(n, this._instanceCount); i++) {
            result.push(this._trsData.slice(i * 16, (i + 1) * 16));
        }
        return result;
    }

    /** Diagnostic: print first few vertex positions and TRS translations */
    public debugPrintSamples(): void {
        // First 3 vertices (interleaved: pos.xyz, nrm.xyz per vertex)
        console.log('=== GlobalBufferManager Debug ===');
        console.log(`Vertices: ${this._vertexCount}, Indices: ${this._indexCount}, Instances: ${this._instanceCount}, DrawCmds: ${this._drawCommandCount}, Remap: ${this._remapCount}`);

        for (let i = 0; i < Math.min(3, this._vertexCount); i++) {
            const o = i * 6;
            console.log(`  vtx[${i}] pos=(${this._vertexData[o].toFixed(4)}, ${this._vertexData[o+1].toFixed(4)}, ${this._vertexData[o+2].toFixed(4)}) nrm=(${this._vertexData[o+3].toFixed(4)}, ${this._vertexData[o+4].toFixed(4)}, ${this._vertexData[o+5].toFixed(4)})`);
        }

        // First 5 TRS translations (column 3: indices 12,13,14 of each 4x4)
        for (let i = 0; i < Math.min(5, this._instanceCount); i++) {
            const o = i * 16;
            console.log(`  trs[${i}] tx=${this._trsData[o+12].toFixed(2)}, ty=${this._trsData[o+13].toFixed(2)}, tz=${this._trsData[o+14].toFixed(2)}, scale=(${this._trsData[o+0].toFixed(4)}, ${this._trsData[o+5].toFixed(4)}, ${this._trsData[o+10].toFixed(4)})`);
        }

        // Compute bounding box of ALL instance translations
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < this._instanceCount; i++) {
            const o = i * 16;
            const tx = this._trsData[o + 12];
            const ty = this._trsData[o + 13];
            const tz = this._trsData[o + 14];
            if (tx < minX) minX = tx; if (tx > maxX) maxX = tx;
            if (ty < minY) minY = ty; if (ty > maxY) maxY = ty;
            if (tz < minZ) minZ = tz; if (tz > maxZ) maxZ = tz;
        }
        console.log(`  BBOX: x=[${minX.toFixed(2)}, ${maxX.toFixed(2)}], y=[${minY.toFixed(2)}, ${maxY.toFixed(2)}], z=[${minZ.toFixed(2)}, ${maxZ.toFixed(2)}]`);
        console.log(`  CENTER: (${((minX+maxX)/2).toFixed(2)}, ${((minY+maxY)/2).toFixed(2)}, ${((minZ+maxZ)/2).toFixed(2)})`);

        // First 5 remap entries
        console.log(`  remap[0..4]: ${Array.from(this._remapData.slice(0, 5)).join(', ')}`);

        // First 3 draw commands
        for (let i = 0; i < Math.min(3, this._drawCommandCount); i++) {
            const o = i * 5;
            console.log(`  cmd[${i}] idxCnt=${this._indirectDrawData[o]}, instCnt=${this._indirectDrawData[o+1]}, firstIdx=${this._indirectDrawData[o+2]}, baseVtx=${this._indirectDrawData[o+3]}, firstInst=${this._indirectDrawData[o+4]}`);
        }

        // Sample draw command instance counts: find largest
        let maxInstCmd = 0, maxInstCount = 0;
        for (let i = 0; i < this._drawCommandCount; i++) {
            const cnt = this._indirectDrawData[i * 5 + 1];
            if (cnt > maxInstCount) { maxInstCount = cnt; maxInstCmd = i; }
        }
        console.log(`  Largest cmd: cmd[${maxInstCmd}] with ${maxInstCount} instances`);
    }
}
