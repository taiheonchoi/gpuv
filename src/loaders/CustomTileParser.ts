import { GlobalBufferManager } from '../core/GlobalBufferManager';
import { Quantization } from '../utils/Quantization';
import { Scene } from '@babylonjs/core';

/** Parsed URIs from tileset.json for content and optional GAL. */
export interface TilesetUris {
    contentUri: string;
    assetLibraryUri?: string;
}

/**
 * Handles custom streaming and decoding for Custom Spec 2.0 3D Tiles.
 * Responsible for memory-efficient EXT_mesh_gpu_instancing payload handling.
 */
export class CustomTileParser {
    private _bufferManager: GlobalBufferManager;
    private _isCustomSpec2: boolean = false;

    constructor(_scene: Scene) {
        // Scene dependency kept for future extensions, but removed from class fields to satisfy TS strict checks.
        // Connect directly to the WebGPU SSBO handler
        this._bufferManager = GlobalBufferManager.getInstance();
    }

    /**
     * Evaluates the Tileset payload to detect the `custom_spec: "2.0"` override.
     */
    public parseTilesetJson(tilesetJson: any): TilesetUris {
        this._isCustomSpec2 = !!(tilesetJson.asset?.custom_spec === "2.0" || tilesetJson.custom_spec === "2.0");
        if (this._isCustomSpec2) {
            console.log("CustomTileParser: Custom Spec 2.0 detected in tileset.json. GAL scaling logic engaged.");
        } else {
            console.warn("CustomTileParser: Tileset lacks ‘custom_spec: 2.0’. Using strict standard fallback.");
        }

        const contentUri = tilesetJson.root?.content?.uri ?? "";
        const assetLibraryUri = tilesetJson.extensions?.LCL_spatial_context?.assetLibraryUri;
        return { contentUri, assetLibraryUri };
    }

    /**
     * Primary hook into tile parsing logic. Dissects GLTF/GLB internal buffers 
     * and isolates Instancing overrides.
     */
    public processTileGltf(gltfJson: any, binaryBuffers: ArrayBuffer[]): void {
        if (!this._isCustomSpec2 || !gltfJson.nodes) return;

        gltfJson.nodes.forEach((node: any) => {
            const instancingExt = node.extensions?.EXT_mesh_gpu_instancing;
            if (instancingExt) {
                this._extractAndStreamInstancingData(gltfJson, binaryBuffers, instancingExt);
            }
        });
    }

    /**
     * Parses the extension payload, reads translation + batchID, processes quantization,
     * formats it securely to `std430`, and routes it directly to WebGPU bounds.
     */
    private _extractAndStreamInstancingData(gltfJson: any, binaryBuffers: ArrayBuffer[], instancingExt: any): void {
        const attributes = instancingExt.attributes;
        if (!attributes) return;

        const translationAccessor = this._getAccessorData(gltfJson, binaryBuffers, attributes.TRANSLATION);
        const batchIdAccessor = this._getAccessorData(gltfJson, binaryBuffers, attributes._BATCHID);

        if (!translationAccessor || !batchIdAccessor) {
            console.error("CustomTileParser: Missing TRANSLATION or _BATCHID attributes in EXT_mesh_gpu_instancing.");
            return;
        }

        let finalTranslations = translationAccessor.data as Float32Array;

        // Dequantize positional boundaries if the component type detects 16-bit payload (Int16 / Uint16)
        if (translationAccessor.componentType === 5122 || translationAccessor.componentType === 5123) {
            const isUint = translationAccessor.componentType === 5123;
            const min = translationAccessor.min || [0, 0, 0];
            const max = translationAccessor.max || [1000, 1000, 1000];

            finalTranslations = Quantization.dequantizePositions(
                translationAccessor.data as Uint16Array,
                min,
                max,
                isUint
            );
        }

        // Optional ROTATION (VEC4 quaternion) and SCALE (VEC3)
        const rotationAccessor = attributes.ROTATION !== undefined
            ? this._getAccessorData(gltfJson, binaryBuffers, attributes.ROTATION) : null;
        const scaleAccessor = attributes.SCALE !== undefined
            ? this._getAccessorData(gltfJson, binaryBuffers, attributes.SCALE) : null;

        const rotations = rotationAccessor ? rotationAccessor.data as Float32Array : null;
        const scales = scaleAccessor ? scaleAccessor.data as Float32Array : null;

        const batchIds = new Uint32Array(batchIdAccessor.data);
        const count = batchIds.length;

        // Build 4x4 column-major TRS matrices: M = T * R * S
        const packedTRS = new Float32Array(count * 16);

        for (let i = 0; i < count; i++) {
            const tIdx = i * 3;
            const destIdx = i * 16;

            const tx = finalTranslations[tIdx + 0];
            const ty = finalTranslations[tIdx + 1];
            const tz = finalTranslations[tIdx + 2];

            // Rotation quaternion (x,y,z,w) — default identity
            let qx = 0, qy = 0, qz = 0, qw = 1;
            if (rotations) {
                const rIdx = i * 4;
                qx = rotations[rIdx]; qy = rotations[rIdx + 1];
                qz = rotations[rIdx + 2]; qw = rotations[rIdx + 3];
            }

            // Scale — default (1,1,1)
            let sx = 1, sy = 1, sz = 1;
            if (scales) {
                const sIdx = i * 3;
                sx = scales[sIdx]; sy = scales[sIdx + 1]; sz = scales[sIdx + 2];
            }

            // Compose column-major 4x4: M = T * R * S
            // Rotation matrix from quaternion, pre-multiplied with scale
            const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
            const xx = qx * x2, xy = qx * y2, xz = qx * z2;
            const yy = qy * y2, yz = qy * z2, zz = qz * z2;
            const wx = qw * x2, wy = qw * y2, wz = qw * z2;

            // Column 0
            packedTRS[destIdx + 0] = (1 - (yy + zz)) * sx;
            packedTRS[destIdx + 1] = (xy + wz) * sx;
            packedTRS[destIdx + 2] = (xz - wy) * sx;
            packedTRS[destIdx + 3] = 0;
            // Column 1
            packedTRS[destIdx + 4] = (xy - wz) * sy;
            packedTRS[destIdx + 5] = (1 - (xx + zz)) * sy;
            packedTRS[destIdx + 6] = (yz + wx) * sy;
            packedTRS[destIdx + 7] = 0;
            // Column 2
            packedTRS[destIdx + 8] = (xz + wy) * sz;
            packedTRS[destIdx + 9] = (yz - wx) * sz;
            packedTRS[destIdx + 10] = (1 - (xx + yy)) * sz;
            packedTRS[destIdx + 11] = 0;
            // Column 3 (translation)
            packedTRS[destIdx + 12] = tx;
            packedTRS[destIdx + 13] = ty;
            packedTRS[destIdx + 14] = tz;
            packedTRS[destIdx + 15] = 1;
        }

        // Write directly to GPU VRAM queue via Manager
        this._bufferManager.appendInstanceData(packedTRS, batchIds);

        // Target Indirect batch index 0. Assuming singular mesh linkage mapping out of simplicity.
        // Increments rendering scale by the number of parsed tiles
        this._bufferManager.updateIndirectDrawCommand(0, count);

        // Note: local TypedArray references (packedTRS, finalTranslations, batchIds) are
        // automatically eligible for GC when this function scope exits.
        // Do NOT delete instancingExt.attributes — it destroys tile re-parsing capability
        // which is needed for tile unload/reload cycles in streaming scenarios.
    }

    /**
     * Resolves the slice byte data directly from global GLB memory map.
     */
    private _getAccessorData(gltfJson: any, binaryBuffers: ArrayBuffer[], accessorIndex: number): any {
        if (accessorIndex === undefined) return null;

        const accessor = gltfJson.accessors[accessorIndex];
        const bufferView = gltfJson.bufferViews[accessor.bufferView];
        const buffer = binaryBuffers[bufferView.buffer];

        const byteOffset = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
        const componentCount = accessor.count * this._getComponentCount(accessor.type);
        let typedArray: any;

        // Use buffer.slice() to create an aligned copy — avoids RangeError when
        // byteOffset is not a multiple of the element size (e.g., Float32 requires 4-byte alignment)
        switch (accessor.componentType) {
            case 5126: { // Float32
                const byteLen = componentCount * 4;
                typedArray = new Float32Array(buffer.slice(byteOffset, byteOffset + byteLen));
                break;
            }
            case 5123: { // Uint16
                const byteLen = componentCount * 2;
                typedArray = new Uint16Array(buffer.slice(byteOffset, byteOffset + byteLen));
                break;
            }
            case 5122: { // Int16
                const byteLen = componentCount * 2;
                typedArray = new Int16Array(buffer.slice(byteOffset, byteOffset + byteLen));
                break;
            }
            case 5125: { // Uint32
                const byteLen = componentCount * 4;
                typedArray = new Uint32Array(buffer.slice(byteOffset, byteOffset + byteLen));
                break;
            }
            default:
                throw new Error(`CustomTileParser: Unsupported componentType > ${accessor.componentType}`);
        }

        return {
            data: typedArray,
            componentType: accessor.componentType,
            min: accessor.min,
            max: accessor.max
        };
    }

    private _getComponentCount(type: string): number {
        switch (type) {
            case 'SCALAR': return 1;
            case 'VEC2': return 2;
            case 'VEC3': return 3;
            case 'VEC4': return 4;
            case 'MAT4': return 16;
            default: return 1;
        }
    }
}
