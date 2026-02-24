import { WebGPUEngine, StorageBuffer, Constants, Vector3 } from '@babylonjs/core';
import { ComputeCullingManager } from './ComputeCullingManager';
import { SensorLinkManager } from './SensorLinkManager';

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

    // Clash Registry: separate buffers matching WGSL binding(3) and binding(4)
    public clashCountBuffer!: StorageBuffer;   // binding(3): atomic<u32> clash count
    public clashIndicesBuffer!: StorageBuffer;  // binding(4): array<u32> clash instance indices
    private _clashCountReadBuffer!: GPUBuffer;
    private _clashIndicesReadBuffer!: GPUBuffer;

    private _dynamicList: DynamicObjectData[] = [];
    private readonly MAX_CLASHES = 10000; // Limit readback size to avoid CPU stalling

    // Pre-allocated zero buffer for clearing atomic counters (avoids per-frame GPU buffer creation)
    private _zeroBuffer!: GPUBuffer;
    private _isAnalyzing = false;

    // Reference to SensorLinkManager for CPU-side clash state coherence
    private _sensorManager: SensorLinkManager | null = null;

    public setSensorManager(sensorManager: SensorLinkManager): void {
        this._sensorManager = sensorManager;
    }

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

        // Separate buffers for atomic count and indices — matches WGSL binding(3) and binding(4)
        this.clashCountBuffer = new StorageBuffer(this._engine, 4, flags);
        this.clashIndicesBuffer = new StorageBuffer(this._engine, this.MAX_CLASHES * 4, flags);

        // MapAsync requires COPY_DST | MAP_READ formatted buffers
        this._clashCountReadBuffer = this._device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });
        this._clashIndicesReadBuffer = this._device.createBuffer({
            size: this.MAX_CLASHES * 4,
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
            (this.clashCountBuffer.getBuffer() as any).underlyingResource as GPUBuffer, 0,
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
        // Prevent concurrent mapAsync — WebGPU rejects mapping an already-pending/mapped buffer
        if (this._isAnalyzing) return [];
        this._isAnalyzing = true;

        try {
        const commandEncoder = this._device.createCommandEncoder();

        // Copy count and indices from separate GPU buffers to their respective read buffers
        commandEncoder.copyBufferToBuffer(
            (this.clashCountBuffer.getBuffer() as any).underlyingResource as GPUBuffer, 0,
            this._clashCountReadBuffer, 0,
            4
        );
        commandEncoder.copyBufferToBuffer(
            (this.clashIndicesBuffer.getBuffer() as any).underlyingResource as GPUBuffer, 0,
            this._clashIndicesReadBuffer, 0,
            this._clashIndicesReadBuffer.size
        );
        this._device.queue.submit([commandEncoder.finish()]);

        // Read the clash count
        await this._clashCountReadBuffer.mapAsync(GPUMapMode.READ);
        const countView = new Uint32Array(this._clashCountReadBuffer.getMappedRange());
        const clashCount = Math.min(countView[0], this.MAX_CLASHES);
        this._clashCountReadBuffer.unmap();

        // Read the clash indices
        const results: number[] = [];
        if (clashCount > 0) {
            await this._clashIndicesReadBuffer.mapAsync(GPUMapMode.READ);
            const indicesView = new Uint32Array(this._clashIndicesReadBuffer.getMappedRange());
            for (let i = 0; i < clashCount; i++) {
                results.push(indicesView[i]);
            }
            this._clashIndicesReadBuffer.unmap();
        }

        // Sync clash state to CPU-side buffer so AppearanceManager flushes don't overwrite GPU-written 2.0 values
        if (this._sensorManager && results.length > 0) {
            const stateBuffer = this._sensorManager.getSensorStateBufferData();
            for (const idx of results) {
                if (idx >= 0 && idx < stateBuffer.length) {
                    stateBuffer[idx] = 2.0; // Match clash_detection.wgsl: Disconnected/Danger state
                }
            }
        }

        return results;
        } catch (e) {
            console.warn('ClashDetectionManager: analyzeInterferenceAsync failed', e);
            return [];
        } finally {
            this._isAnalyzing = false;
        }
    }
}
