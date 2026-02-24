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

    // Track which batchIds were highlighted by search to avoid erasing AppearanceManager highlights
    private _searchHighlightedIds: Set<number> = new Set();

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

        // Clear only previously search-highlighted IDs owned by this SemanticSearch instance
        const floatStateBuffer = this._sensorManager.getSensorStateBufferData();
        for (const id of this._searchHighlightedIds) {
            if (id >= 0 && id < floatStateBuffer.length && floatStateBuffer[id] === 3.0) {
                floatStateBuffer[id] = 0.0;
            }
        }
        this._searchHighlightedIds.clear();

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
                if (meta.batchId >= 0 && meta.batchId < floatStateBuffer.length) {
                    floatStateBuffer[meta.batchId] = 3.0; // Shader maps 3.0 to Blue Glowing
                    this._searchHighlightedIds.add(meta.batchId);
                }
            }
        });

        console.log(`Semantic Search ['${attribute}' ${operator} ${value}] yielded ${results.length} matches.`);

        // Flush updated health states to GPU so ghost_effect.wgsl reflects highlights immediately
        this._sensorManager.syncStateBufferToGPU();

        return results;
    }
}
