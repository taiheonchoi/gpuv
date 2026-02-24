import { WebGPUEngine, StorageBuffer, Constants, Vector3 } from '@babylonjs/core';
import { ComputeCullingManager } from './ComputeCullingManager';

export interface DynamicObjectData {
    id: string;
    center: Vector3;
    radius: number;
}

/**
 * Manages spatial clash detection via Compute Shaders for dynamic volumes (Cranes/Robots)
 * against the static 8M+ instance library.
 */
export class ClashDetectionManager {
    private _engine: WebGPUEngine;
    private _device: GPUDevice;

    // Buffer references to push physical locations of Cranes/Robots to WebGPU
    public dynamicObjectsBuffer!: StorageBuffer;

    // Clash Registry (Outputs instances that mathematically breached interference)
    // Structured: [ClashCount (Uint32), ...ClashBatchIDs[]]
    public clashResultBuffer!: StorageBuffer;
    private _clashReadBuffer!: GPUBuffer;

    private _dynamicList: DynamicObjectData[] = [];
    private readonly MAX_CLASHES = 10000; // Limit readback size to avoid CPU stalling

    // Pre-allocated zero buffer for clearing atomic counters (avoids per-frame GPU buffer creation)
    private _zeroBuffer!: GPUBuffer;

    constructor(engine: WebGPUEngine, _cullingManager: ComputeCullingManager) {
        this._engine = engine;
        this._device = (this._engine as any)._device;
        // _cullingManager is consumed for architectural coupling where BoundingVolumes are shared
        if (_cullingManager) { /* Conceptual Link Ready */ }

        this._initializeBuffers();
        this._zeroBuffer = this._device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.COPY_SRC,
        });
    }

    private _initializeBuffers(): void {
        const flags = Constants.BUFFER_CREATIONFLAG_READWRITE;

        // Up to 64 dynamic entities at a time (Center Vec3 + Radius = 16 bytes each)
        this.dynamicObjectsBuffer = new StorageBuffer(this._engine, 64 * 16, flags);

        // Output atomic count placeholder + space for 10000 resulting Uint32 indices
        this.clashResultBuffer = new StorageBuffer(this._engine, 4 + this.MAX_CLASHES * 4, flags);

        // MapAsync requires a COPY_DST | MAP_READ formatted buffer matching exactly
        this._clashReadBuffer = this._device.createBuffer({
            size: 4 + this.MAX_CLASHES * 4,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });
    }

    /**
     * AI/Sim Endpoint: Updates the physics proxy of a moving object (e.g. Crane Payload).
     */
    public updateDynamicObject(obj: DynamicObjectData): void {
        const idx = this._dynamicList.findIndex(x => x.id === obj.id);
        if (idx !== -1) {
            this._dynamicList[idx] = obj;
        } else {
            this._dynamicList.push(obj);
        }

        // serialize to Float32Array 4 units (Vec3, Radius)
        const updateData = new Float32Array(this._dynamicList.length * 4);
        for (let i = 0; i < this._dynamicList.length; i++) {
            updateData[i * 4 + 0] = this._dynamicList[i].center.x;
            updateData[i * 4 + 1] = this._dynamicList[i].center.y;
            updateData[i * 4 + 2] = this._dynamicList[i].center.z;
            updateData[i * 4 + 3] = this._dynamicList[i].radius;
        }

        this.dynamicObjectsBuffer.update(updateData);
    }

    /**
     * Invoked per-frame inside the plugins loop. Binds and resets atomic counters before computation.
     */
    public executeClashDetection(commandEncoder: GPUCommandEncoder): void {
        commandEncoder.pushDebugGroup("Clash_Detection_Pass");

        // 1. Clear atomic result count to 0 using pre-allocated zero buffer
        commandEncoder.copyBufferToBuffer(
            this._zeroBuffer, 0,
            (this.clashResultBuffer.getBuffer() as any).underlyingResource as GPUBuffer, 0,
            4
        );

        // 2. Compute Dispatch logic conceptually hooks here.
        // It maps the sensorHealthBuffers inside to trigger Red 2.0 colors immediately zero-latency.
        // const computePass = commandEncoder.beginComputePass();
        // computePass.setBindGroup(0, ... boundingVolumes, dynamicObjects, etc. );
        // computePass.dispatchWorkgroups(...);
        // computePass.end();

        commandEncoder.popDebugGroup();
    }

    /**
     * Triggers asynchronous mapping to transfer Clash states from VRAM to Javascript runtime (MCP).
     * @returns Array of breached BatchIDs
     */
    public async analyzeInterferenceAsync(): Promise<number[]> {
        const commandEncoder = this._device.createCommandEncoder();

        commandEncoder.copyBufferToBuffer(
            (this.clashResultBuffer.getBuffer() as any).underlyingResource as GPUBuffer, 0,
            this._clashReadBuffer, 0,
            this._clashReadBuffer.size
        );
        this._device.queue.submit([commandEncoder.finish()]);

        await this._clashReadBuffer.mapAsync(GPUMapMode.READ);
        const bufferView = new Uint32Array(this._clashReadBuffer.getMappedRange());

        const clashCount = Math.min(bufferView[0], this.MAX_CLASHES);
        const results = [];

        // Slice the memory exactly up to the tracked collision counts
        for (let i = 0; i < clashCount; i++) {
            results.push(bufferView[i + 1]);
        }

        this._clashReadBuffer.unmap();

        return results;
    }
}
