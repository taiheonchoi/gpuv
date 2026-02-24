import { SensorLinkManager } from './SensorLinkManager';

/**
 * Headless AI rendering controller. Allows the LLM MCP system to command
 * direct memory overrides altering the WebGPU scene without visual interaction paradigms.
 */
export class AppearanceManager {
    private _sensorManager: SensorLinkManager;

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

        // Reset old highlights manually leveraging high-speed Float array parsing
        for (let i = 0; i < floatStateBuffer.length; i++) {
            if (floatStateBuffer[i] === 3.0) floatStateBuffer[i] = 0.0;
        }

        for (const id of batchIds) {
            // Out of bounds check
            if (id < floatStateBuffer.length) {
                floatStateBuffer[id] = 3.0; // Shader state index mapping for Highlight
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
            if (id < floatStateBuffer.length) {
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
            if (id < floatStateBuffer.length) {
                floatStateBuffer[id] = 0.0; // Base solid state
            }
        }

        this._flushToGPU();
    }

    /**
     * Triggers the `device.queue.writeBuffer` command through the sensor hierarchy bridging updates to WebGPU.
     */
    private _flushToGPU(): void {
        // Concept mapping for Phase 4:
        // this._sensorManager.syncStateBufferToGPU(); 
    }
}
