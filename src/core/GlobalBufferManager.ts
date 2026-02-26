import { WebGPUEngine, StorageBuffer, Constants } from '@babylonjs/core';

/**
 * Singleton class to manage large-scale WebGPU Storage Buffers.
 * Prepares the framework for Custom Spec 2.0 Indirect Batcher & Instance Streaming.
 */
export class GlobalBufferManager {
    private static _instance: GlobalBufferManager | null = null;
    private _engine: WebGPUEngine;

    public instanceTRSBuffer!: StorageBuffer;
    public batchIdBuffer!: StorageBuffer;
    public indirectDrawBuffer!: StorageBuffer;
    public sensorStateBuffer!: StorageBuffer;

    // Native GPUBuffer for indirect draw — needs INDIRECT usage flag that
    // Babylon's StorageBuffer doesn't support
    public indirectDrawGpuBuffer!: GPUBuffer;

    private _trsData: Float32Array;
    private _batchIdData: Uint32Array;
    private _indirectDrawData: Uint32Array;

    private _instanceCount: number = 0;
    private _maxDrawCommands: number = 1000;

    // Allocated large memory up-front for up to 8M+ instances to avoid continuous reallocation
    // Initial size is set lower (1M) for browser safety during testing, can be scaled to 8M+.
    private readonly INITIAL_INSTANCE_CAPACITY = 1000000;

    private constructor(engine: WebGPUEngine) {
        this._engine = engine;

        // 16 floats per instance (4x4 Matrix) to ensure std430 16-byte alignment rules
        this._trsData = new Float32Array(this.INITIAL_INSTANCE_CAPACITY * 16);
        // 4 uints per instance to align to 16 bytes: [BatchID, Padding, Padding, Padding]
        this._batchIdData = new Uint32Array(this.INITIAL_INSTANCE_CAPACITY * 4);
        // 5 uints per indexed draw command for IndirectDraw
        // [indexCount, instanceCount, firstIndex, baseVertex, firstInstance]
        this._indirectDrawData = new Uint32Array(this._maxDrawCommands * 5);
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
        // Babylon.js Constants.BUFFER_CREATIONFLAG_READWRITE implements: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST internally
        const flags = Constants.BUFFER_CREATIONFLAG_READWRITE;

        this.instanceTRSBuffer = new StorageBuffer(this._engine, this._trsData.byteLength, flags);
        this.batchIdBuffer = new StorageBuffer(this._engine, this._batchIdData.byteLength, flags);
        this.indirectDrawBuffer = new StorageBuffer(this._engine, this._indirectDrawData.byteLength, flags);
        // 1 float per instance: health/appearance state for ghost_effect.wgsl & clash_detection.wgsl
        this.sensorStateBuffer = new StorageBuffer(this._engine, this.INITIAL_INSTANCE_CAPACITY * 4, flags);

        // Native indirect buffer with INDIRECT usage for drawIndexedIndirect()
        const device = (this._engine as any)._device as GPUDevice;
        this.indirectDrawGpuBuffer = device.createBuffer({
            label: 'indirect-draw-native',
            size: this._indirectDrawData.byteLength,
            usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
        });

        console.log(`Global Storage Buffers Allocated. Initial Capacity: ${this.INITIAL_INSTANCE_CAPACITY} instances.`);
    }

    /**
     * Appends parsed instance TRS and BatchIDs into the global typed arrays and streams to GPU.
     */
    public appendInstanceData(trsData: Float32Array, batchIds: Uint32Array): void {
        const count = batchIds.length;
        if (this._instanceCount + count > this.INITIAL_INSTANCE_CAPACITY) {
            console.error("Critical: Instance capacity exceeded!");
            return;
        }

        // TRS Data is expected as 16-floats per instance (Matrix4x4)
        const trsOffset = this._instanceCount * 16;
        this._trsData.set(trsData, trsOffset);

        // Batch IDs are stored with 16-byte alignment to prevent GPU struct misalignment
        for (let i = 0; i < count; i++) {
            const batchOffset = (this._instanceCount + i) * 4;
            this._batchIdData[batchOffset] = batchIds[i];
            // batchIdData[batchOffset + 1]... could hold other meta-data later
        }

        this._instanceCount += count;

        // Dispatch updates using COPY_DST underneath
        this.instanceTRSBuffer.update(this._trsData);
        this.batchIdBuffer.update(this._batchIdData); // Babylon handles mapping TypedArray -> ArrayBuffer view
    }

    /**
     * Dynamically updates the instanceCount of an Indirect Draw buffer index.
     */
    public updateIndirectDrawCommand(commandIndex: number, instanceCountDelta: number): void {
        if (commandIndex < 0 || commandIndex >= this._maxDrawCommands) return;
        const offset = commandIndex * 5;
        this._indirectDrawData[offset + 1] = Math.max(0, this._indirectDrawData[offset + 1] + instanceCountDelta);
        this.indirectDrawBuffer.update(this._indirectDrawData);
        // Also sync native indirect buffer (has INDIRECT usage flag)
        const device = (this._engine as any)._device as GPUDevice;
        if (device && this.indirectDrawGpuBuffer) {
            device.queue.writeBuffer(this.indirectDrawGpuBuffer, 0, this._indirectDrawData.buffer);
        }
    }

    // Maintained for backward compatibility with Phase 0 Setup skeleton
    public initializeDummyBuffer(): void {
        // Now handled by internal initialization
    }

    /** Sync the native indirect draw buffer (with INDIRECT flag) from current CPU data */
    public syncIndirectDrawNative(): void {
        const device = (this._engine as any)._device as GPUDevice;
        if (device && this.indirectDrawGpuBuffer) {
            device.queue.writeBuffer(this.indirectDrawGpuBuffer, 0, this._indirectDrawData.buffer);
        }
    }

    /** Direct access to indirect draw data for setting indexCount etc. */
    public get indirectDrawData(): Uint32Array {
        return this._indirectDrawData;
    }

    /**
     * Releases all GPU StorageBuffers and resets the singleton.
     * Must be called before engine re-initialization to prevent stale buffer references.
     */
    public dispose(): void {
        this.instanceTRSBuffer?.dispose();
        this.batchIdBuffer?.dispose();
        this.indirectDrawBuffer?.dispose();
        this.sensorStateBuffer?.dispose();
        this.indirectDrawGpuBuffer?.destroy();

        this._trsData = new Float32Array(0);
        this._batchIdData = new Uint32Array(0);
        this._indirectDrawData = new Uint32Array(0);
        this._instanceCount = 0;

        GlobalBufferManager._instance = null;
        console.log("GlobalBufferManager: Disposed and singleton reset.");
    }

    public get instanceCount(): number {
        return this._instanceCount;
    }
}
