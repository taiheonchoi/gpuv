import { SensorLinkManager } from './SensorLinkManager';

/**
 * Headless AI rendering controller. Allows the LLM MCP system to command
 * direct memory overrides altering the WebGPU scene without visual interaction paradigms.
 */
export class AppearanceManager {
    private _sensorManager: SensorLinkManager;

    // Track which batchIds were highlighted by this manager to avoid erasing SemanticSearch highlights
    private _highlightedIds: Set<number> = new Set();
    // Track which batchIds are in clash state (2.0) written by GPU shader, to preserve on flush
    private _clashIds: Set<number> = new Set();

    constructor(sensorManager: SensorLinkManager) {
        this._sensorManager = sensorManager;
    }

    /**
     * AI Endpoint: Emphasizes a specific set of instances by rendering them with
     * the blue semantic glow shader logic natively.
     * @param batchIds Array of specific instances to highlight
     */
    public setHighlight(batchIds: number[]): void {
        const floatStateBuffer = this._sensorManager.getSensorStateBufferData();

        // Clear only previously highlighted IDs owned by this manager
        for (const id of this._highlightedIds) {
            if (id >= 0 && id < floatStateBuffer.length && floatStateBuffer[id] === 3.0) {
                floatStateBuffer[id] = 0.0;
            }
        }
        this._highlightedIds.clear();

        for (const id of batchIds) {
            if (id >= 0 && id < floatStateBuffer.length) {
                floatStateBuffer[id] = 3.0; // Shader state index mapping for Highlight
                this._highlightedIds.add(id);
            }
        }

        this._flushToGPU();
        console.log(`AppearanceManager: Highlight applied to ${batchIds.length} instances.`);
    }

    /**
     * AI Endpoint: Forces specified components into a disconnected/ghosted state visually.
     * Maps to ID 2.0 (Red pulsing hologram).
     */
    public setGhostMode(batchIds: number[]): void {
        const floatStateBuffer = this._sensorManager.getSensorStateBufferData();

        for (const id of batchIds) {
            if (id >= 0 && id < floatStateBuffer.length) {
                floatStateBuffer[id] = 2.0; // Shader state index mapping for Digital Ghost
            }
        }

        this._flushToGPU();
        console.log(`AppearanceManager: Ghost mode applied to ${batchIds.length} instances.`);
    }

    /**
     * AI Endpoint: Reset specific instances to their solid normal physical layout representation.
     */
    public clearAppearance(batchIds: number[]): void {
        const floatStateBuffer = this._sensorManager.getSensorStateBufferData();

        for (const id of batchIds) {
            if (id >= 0 && id < floatStateBuffer.length) {
                floatStateBuffer[id] = 0.0; // Base solid state
            }
        }

        this._flushToGPU();
    }

    /**
     * Marks specific batchIds as in clash state (2.0) on the CPU side.
     * Called after clash detection readback to keep CPU and GPU in sync.
     */
    public syncClashState(clashIds: number[]): void {
        this._clashIds.clear();
        const floatStateBuffer = this._sensorManager.getSensorStateBufferData();
        for (const id of clashIds) {
            if (id >= 0 && id < floatStateBuffer.length) {
                this._clashIds.add(id);
                // Ensure CPU buffer reflects the GPU-written clash state
                if (floatStateBuffer[id] !== 3.0) {
                    floatStateBuffer[id] = 2.0;
                }
            }
        }
    }

    /**
     * Triggers the GPU StorageBuffer upload through SensorLinkManager,
     * ensuring WGSL shaders immediately reflect appearance state changes.
     * Preserves clash states (2.0) that were written by GPU shaders.
     */
    private _flushToGPU(): void {
        // Re-apply clash states before uploading to prevent CPU flush from overwriting GPU-written 2.0 values
        const floatStateBuffer = this._sensorManager.getSensorStateBufferData();
        for (const id of this._clashIds) {
            if (id >= 0 && id < floatStateBuffer.length && floatStateBuffer[id] === 0.0) {
                floatStateBuffer[id] = 2.0;
            }
        }
        this._sensorManager.syncStateBufferToGPU();
    }
}
