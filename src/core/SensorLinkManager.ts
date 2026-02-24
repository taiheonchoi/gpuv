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
            const offset = batchId * 16; // 4x4 Matrix offset per instance

            // Extract existing transformation components
            // Instead of parsing entire matrices back and forth, build a new matrix locally
            let currentPos = Vector3.Zero();
            let currentRot = Quaternion.Identity();
            const currentScale = Vector3.One(); // Assumes 1,1,1 for IoT moving parts

            // Apply new network coordinates if provided (Lerp/Slerp ideally handled conceptually or via double-buffering target queues)
            if (data.position) {
                currentPos = new Vector3(data.position[0], data.position[1], data.position[2]);
            } else {
                // Read existing translation from column 3 of row-major WGSL matrix
                currentPos = new Vector3(trsData[offset + 12], trsData[offset + 13], trsData[offset + 14]);
            }

            if (data.rotation) {
                currentRot = new Quaternion(data.rotation[0], data.rotation[1], data.rotation[2], data.rotation[3]);
            }

            // Compose final matrix
            const transformMatrix = Matrix.Compose(currentScale, currentRot, currentPos);

            // Re-write straight into memory segment
            transformMatrix.copyToArray(trsData, offset);

            // Update Metadata health metric
            this._sensorStateBuffer[batchId] = data.healthStatus;
        }

        // Notify WebGPU Device Queue to COPY_DST these memory segments
        // We write the complete buffer to VRAM. For highly optimized 8M+ updates, you would only update 
        // byte-specific sub-ranges utilizing `device.queue.writeBuffer` with specific byte sizes.
        this._bufferManager.instanceTRSBuffer.update(trsData);

        // Similarly, update a secondary Metadata Buffer if injected into the WGSL...
        // e.g. this._sensorStateGPUBuffer.update(this._sensorStateBuffer);
    }

    public getSensorStateBufferData(): Float32Array {
        return this._sensorStateBuffer;
    }
}
