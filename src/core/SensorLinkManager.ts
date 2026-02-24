import { GlobalBufferManager } from './GlobalBufferManager';
import { Quaternion, Vector3, Matrix } from '@babylonjs/core';

export interface SensorData {
    batchId: number;
    position?: [number, number, number];
    rotation?: [number, number, number, number]; // Quaternion
    healthStatus: number; // 0: Normal, 1: Delayed, 2: Disconnected
}

/**
 * Handles WebSockets or MQTT incoming telemetry mapping IoT coordinates 
 * down to the WebGPU Float32Array Memory Layer directly.
 */
export class SensorLinkManager {
    private _bufferManager: GlobalBufferManager;

    // Optional metadata state buffer matching the WGSL "health status" metadata chunk
    // 1 float per instance containing metadata state
    private _sensorStateBuffer: Float32Array;
    private readonly MAX_INSTANCES = 1000000;

    constructor() {
        this._bufferManager = GlobalBufferManager.getInstance();
        this._sensorStateBuffer = new Float32Array(this.MAX_INSTANCES);
    }

    /**
     * Represents the data socket hook processing high-frequency JSON telemetry.
     */
    public processIncomingTelemetry(payload: SensorData[]): void {
        // Direct manipulation of the underlying memory allocations
        // The instances TRS buffer has 16 floats per instance
        const trsData = (this._bufferManager as any)._trsData as Float32Array;

        for (const data of payload) {
            const batchId = data.batchId;

            // Bounds validation: skip invalid batchIds to prevent out-of-range buffer access
            if (batchId < 0 || batchId >= this.MAX_INSTANCES) {
                console.warn(`SensorLinkManager: batchId ${batchId} out of range [0, ${this.MAX_INSTANCES}). Skipping.`);
                continue;
            }

            const offset = batchId * 16; // 4x4 Matrix offset per instance

            // Verify offset doesn't exceed trsData bounds
            if (offset + 16 > trsData.length) {
                console.warn(`SensorLinkManager: batchId ${batchId} exceeds TRS buffer bounds. Skipping.`);
                continue;
            }

            // Decompose existing matrix to preserve untouched components
            const existingMatrix = Matrix.FromArray(trsData, offset);
            const existingScale = new Vector3();
            const existingRot = new Quaternion();
            const existingPos = new Vector3();
            existingMatrix.decompose(existingScale, existingRot, existingPos);

            const currentPos = data.position
                ? new Vector3(data.position[0], data.position[1], data.position[2])
                : existingPos;

            const currentRot = data.rotation
                ? new Quaternion(data.rotation[0], data.rotation[1], data.rotation[2], data.rotation[3])
                : existingRot;

            // Compose final matrix preserving existing scale
            const transformMatrix = Matrix.Compose(existingScale, currentRot, currentPos);

            // Re-write straight into memory segment
            transformMatrix.copyToArray(trsData, offset);

            // Update Metadata health metric
            this._sensorStateBuffer[batchId] = data.healthStatus;
        }

        // Notify WebGPU Device Queue to COPY_DST these memory segments
        // We write the complete buffer to VRAM. For highly optimized 8M+ updates, you would only update
        // byte-specific sub-ranges utilizing `device.queue.writeBuffer` with specific byte sizes.
        this._bufferManager.instanceTRSBuffer.update(trsData);

        // Sync health/appearance state to GPU so ghost_effect.wgsl reflects telemetry changes
        this.syncStateBufferToGPU();
    }

    public getSensorStateBufferData(): Float32Array {
        return this._sensorStateBuffer;
    }

    /**
     * Uploads the CPU-side sensor state Float32Array to the GPU StorageBuffer
     * so that WGSL shaders (ghost_effect, clash_detection) can read updated states.
     */
    public syncStateBufferToGPU(): void {
        this._bufferManager.sensorStateBuffer.update(this._sensorStateBuffer);
    }
}
