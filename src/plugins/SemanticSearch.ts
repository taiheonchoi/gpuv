import { SensorLinkManager } from '../core/SensorLinkManager';

export interface EntityMetadata {
    batchId: number;
    partName: string;
    diameter?: number; // Configurable numeric properties
    systemType?: string; // e.g. "HVAC", "Plumbing"
}

/**
 * High-performance semantic querying executing attribute searches dynamically.
 * Instead of altering thousands of meshes on CPU, writes states directly to WebGPU bounds.
 */
export class SemanticSearch {
    private _sensorManager: SensorLinkManager;

    // Simulated Metadata Database 
    // In production, this would be an IndexedDB or compressed JSON lookup loaded from 3D Tiles Batch Table
    private _database: Map<number, EntityMetadata>;

    constructor(sensorManager: SensorLinkManager) {
        this._sensorManager = sensorManager;
        this._database = new Map<number, EntityMetadata>();
    }

    /**
     * Seeds the query database mapping logical parts to graphical BatchIDs.
     */
    public indexEntity(data: EntityMetadata): void {
        this._database.set(data.batchId, data);
    }

    /**
     * Executes an attribute search applying immediate GPU highlights.
     * e.g. queryAttributeSearch("diameter", ">=", 100);
     */
    public queryAttributeSearch(attribute: keyof EntityMetadata, operator: string, value: any): number[] {
        const results: number[] = [];

        // Reset global highlighted states using the IoT Sensor Metadata buffer (Status 3.0 = Highlight)
        // This is O(N) but accessing raw Float32Array is extremely fast. 
        const floatStateBuffer = this._sensorManager.getSensorStateBufferData();
        for (let i = 0; i < floatStateBuffer.length; i++) {
            // Restore highlighted pins back to 'Normal' (0) if they were previously searched
            if (floatStateBuffer[i] === 3.0) {
                floatStateBuffer[i] = 0.0;
            }
        }

        // Evaluate Search Query mapped directly
        this._database.forEach((meta) => {
            const attrValue = meta[attribute];
            if (attrValue === undefined) return;

            let isMatch = false;

            if (typeof value === 'number' && typeof attrValue === 'number') {
                switch (operator) {
                    case '>': isMatch = attrValue > value; break;
                    case '>=': isMatch = attrValue >= value; break;
                    case '<': isMatch = attrValue < value; break;
                    case '<=': isMatch = attrValue <= value; break;
                    case '===': isMatch = attrValue === value; break;
                }
            } else if (typeof value === 'string' && typeof attrValue === 'string') {
                if (operator === 'contains') isMatch = attrValue.includes(value);
                else isMatch = attrValue === value;
            }

            if (isMatch) {
                results.push(meta.batchId);
                // Flag WebGPU metadata buffer index for highlighting
                floatStateBuffer[meta.batchId] = 3.0; // Shader maps 3.0 to Blue Glowing
            }
        });

        console.log(`Semantic Search ['${attribute}' ${operator} ${value}] yielded ${results.length} matches.`);

        // Flush updated health states to GPU so ghost_effect.wgsl reflects highlights immediately
        this._sensorManager.syncStateBufferToGPU();

        return results;
    }
}
