import { GlobalBufferManager, MeshAtlasEntry } from '../core/GlobalBufferManager';
import { Quantization } from '../utils/Quantization';
import { Scene } from '@babylonjs/core';

/** Parsed URIs from tileset.json for content and optional GAL. */
export interface TilesetUris {
    contentUri: string;
    assetLibraryUri?: string;
    instanceTrsUri?: string;
    geometricError?: number;
}

/**
 * Handles custom streaming and decoding for Custom Spec 2.0 3D Tiles.
 * Responsible for memory-efficient EXT_mesh_gpu_instancing payload handling.
 *
 * Geometry Atlas with Cross-Chunk Mesh Deduplication:
 * - Extracts actual mesh geometry (POSITION + NORMAL + indices) from GLB nodes
 * - Deduplicates meshes across ALL chunks using a vertex fingerprint
 * - Packs unique geometries into GlobalBufferManager's shared atlas buffers
 * - Each unique mesh gets its own indirect draw command
 *
 * Dedup Strategy:
 * - Fingerprint = vertexCount|indexCount|first 3 vertex positions (6 decimal places)
 * - Same fingerprint across different chunks → reuse atlas entry (no GPU re-upload)
 * - Dramatically reduces VRAM for instanced models (8M instances, ~few thousand unique meshes)
 */
export class CustomTileParser {
    private _bufferManager: GlobalBufferManager;
    private _isCustomSpec2: boolean = false;

    /**
     * Cross-chunk mesh dedup cache.
     * Key: mesh fingerprint string
     * Value: MeshAtlasEntry (offsets into GPU atlas)
     *
     * This persists across processTileGltf() calls, so meshes loaded from
     * chunk A that match chunk B's meshes will reuse the same GPU geometry.
     */
    private _globalMeshCache = new Map<string, MeshAtlasEntry>();
    private _meshCacheHits = 0;
    private _meshCacheMisses = 0;

    constructor(_scene: Scene) {
        this._bufferManager = GlobalBufferManager.getInstance();
    }

    /**
     * Evaluates the Tileset payload to detect the `custom_spec: "2.0"` override.
     */
    public parseTilesetJson(tilesetJson: any): TilesetUris {
        this._isCustomSpec2 = !!(
            tilesetJson.asset?.custom_spec === "2.0" ||
            tilesetJson.asset?.custom_spec === "2.5" ||
            tilesetJson.custom_spec === "2.0" ||
            tilesetJson.custom_spec === "2.5"
        );
        if (this._isCustomSpec2) {
            console.log("CustomTileParser: Custom Spec 2.0/2.5 detected in tileset.json.");
        } else {
            console.warn("CustomTileParser: Tileset lacks 'custom_spec: 2.0'. Using strict standard fallback.");
        }

        const contentUri = tilesetJson.root?.content?.uri ?? "";
        const ext = tilesetJson.extensions?.LCL_spatial_context;
        const assetLibraryUri = ext?.assetLibraryUri;
        const instanceTrsUri = ext?.instanceTrsUri;
        const geometricError = tilesetJson.geometricError ?? tilesetJson.root?.geometricError;
        return { contentUri, assetLibraryUri, instanceTrsUri, geometricError };
    }

    /**
     * Primary hook into tile parsing logic. Dissects GLTF/GLB internal buffers
     * and isolates Instancing overrides.
     *
     * For each node with a mesh + EXT_mesh_gpu_instancing:
     * 1. Extract mesh geometry → fingerprint → dedup via _globalMeshCache
     * 2. Extract TRS + batchId from instancing extension → append instances
     * 3. Wire up the indirect draw command for this mesh
     *
     * Nodes sharing the same mesh index within a single GLB reuse the same
     * draw command (intra-GLB dedup). The _globalMeshCache provides cross-chunk
     * dedup so identical meshes from different GLBs also share GPU geometry.
     */
    public processTileGltf(gltfJson: any, binaryBuffers: ArrayBuffer[]): void {
        if (!this._isCustomSpec2 || !gltfJson.nodes) return;

        // Intra-GLB dedup: mesh index → atlas entry (within this GLB)
        const localMeshMap = new Map<number, MeshAtlasEntry>();

        // Collect per-draw-command instances:
        // drawCommandIndex → { trsArrays[], batchIdArrays[], totalCount }
        const pendingInstances = new Map<number, {
            trsList: Float32Array[];
            batchIdList: Uint32Array[];
            totalCount: number;
        }>();

        for (const node of gltfJson.nodes) {
            const instancingExt = node.extensions?.EXT_mesh_gpu_instancing;
            if (!instancingExt) continue;

            const meshIndex: number | undefined = node.mesh;
            if (meshIndex === undefined) continue;

            // Step 1: Extract or reuse mesh geometry (intra-GLB + cross-chunk dedup)
            let atlasEntry: MeshAtlasEntry;
            if (localMeshMap.has(meshIndex)) {
                // Same mesh index within this GLB — reuse
                atlasEntry = localMeshMap.get(meshIndex)!;
            } else {
                // Try cross-chunk dedup via fingerprint
                atlasEntry = this._extractMeshGeometryDeduped(gltfJson, binaryBuffers, meshIndex);
                if (atlasEntry.drawCommandIndex < 0) continue;
                localMeshMap.set(meshIndex, atlasEntry);
            }

            // Step 2: Extract TRS + batchId from instancing extension
            const instanceData = this._extractInstancingData(gltfJson, binaryBuffers, instancingExt);
            if (!instanceData) continue;

            // Step 3: Accumulate instances for this draw command
            const cmdIdx = atlasEntry.drawCommandIndex;
            if (!pendingInstances.has(cmdIdx)) {
                pendingInstances.set(cmdIdx, { trsList: [], batchIdList: [], totalCount: 0 });
            }
            const pending = pendingInstances.get(cmdIdx)!;
            pending.trsList.push(instanceData.packedTRS);
            pending.batchIdList.push(instanceData.batchIds);
            pending.totalCount += instanceData.batchIds.length;
        }

        // Step 4: Upload all instances and update draw commands
        for (const [cmdIdx, pending] of pendingInstances) {
            const firstInstance = this._bufferManager.instanceCount;

            for (let i = 0; i < pending.trsList.length; i++) {
                this._bufferManager.appendInstanceData(pending.trsList[i], pending.batchIdList[i]);
            }

            // For cross-chunk dedup, multiple chunks may contribute instances
            // to the same draw command. Use addDrawCommandInstances() which
            // accumulates rather than overwrites.
            this._bufferManager.addDrawCommandInstances(cmdIdx, pending.totalCount, firstInstance);
        }
    }

    /**
     * Extracts mesh geometry with cross-chunk deduplication.
     *
     * Computes a fingerprint from vertex/index counts + first vertex positions.
     * If a matching fingerprint exists in _globalMeshCache, reuses the existing
     * atlas entry (no GPU re-upload). Otherwise extracts and uploads new geometry.
     */
    private _extractMeshGeometryDeduped(
        gltfJson: any,
        binaryBuffers: ArrayBuffer[],
        meshIndex: number
    ): MeshAtlasEntry {
        const mesh = gltfJson.meshes?.[meshIndex];
        if (!mesh?.primitives?.length) {
            return { drawCommandIndex: -1, baseVertex: 0, firstIndex: 0, indexCount: 0 };
        }

        const primitive = mesh.primitives[0];

        // Extract POSITION (required for fingerprinting)
        const posAccessorIdx = primitive.attributes?.POSITION;
        if (posAccessorIdx === undefined) {
            return { drawCommandIndex: -1, baseVertex: 0, firstIndex: 0, indexCount: 0 };
        }
        const posData = this._getAccessorData(gltfJson, binaryBuffers, posAccessorIdx);
        if (!posData) {
            return { drawCommandIndex: -1, baseVertex: 0, firstIndex: 0, indexCount: 0 };
        }
        const positions = posData.data as Float32Array;
        const vertexCount = positions.length / 3;

        // Extract indices count for fingerprinting
        if (primitive.indices === undefined) {
            return { drawCommandIndex: -1, baseVertex: 0, firstIndex: 0, indexCount: 0 };
        }
        const idxData = this._getAccessorData(gltfJson, binaryBuffers, primitive.indices);
        if (!idxData) {
            return { drawCommandIndex: -1, baseVertex: 0, firstIndex: 0, indexCount: 0 };
        }
        const indexCount = idxData.data.length;

        // Compute fingerprint for cross-chunk dedup
        // Format: vertexCount|indexCount|p0x|p0y|p0z|p1x|p1y|p1z|p2x|p2y|p2z
        // Using first 3 vertices (9 floats) rounded to 4 decimal places
        const fp = this._computeMeshFingerprint(positions, vertexCount, indexCount);

        // Check cross-chunk cache
        const cached = this._globalMeshCache.get(fp);
        if (cached) {
            this._meshCacheHits++;
            if ((this._meshCacheHits + this._meshCacheMisses) % 500 === 0) {
                this._logDedupStats();
            }
            return cached;
        }

        // Cache miss — extract full geometry and upload to atlas
        this._meshCacheMisses++;

        // Extract NORMAL (optional)
        let normals: Float32Array;
        const normalAccessorIdx = primitive.attributes?.NORMAL;
        if (normalAccessorIdx !== undefined) {
            const normalData = this._getAccessorData(gltfJson, binaryBuffers, normalAccessorIdx);
            normals = normalData ? normalData.data as Float32Array : new Float32Array(vertexCount * 3);
        } else {
            normals = new Float32Array(vertexCount * 3);
            for (let i = 0; i < vertexCount; i++) {
                normals[i * 3 + 1] = 1.0; // flat up normal fallback
            }
        }

        // Convert indices to Uint32
        let indices32: Uint32Array;
        if (idxData.data instanceof Uint32Array) {
            indices32 = idxData.data;
        } else {
            indices32 = new Uint32Array(idxData.data.length);
            for (let i = 0; i < idxData.data.length; i++) {
                indices32[i] = idxData.data[i];
            }
        }

        // Interleave position + normal → Float32Array (6 floats per vertex)
        const interleaved = new Float32Array(vertexCount * 6);
        for (let i = 0; i < vertexCount; i++) {
            const src = i * 3;
            const dst = i * 6;
            interleaved[dst + 0] = positions[src + 0];
            interleaved[dst + 1] = positions[src + 1];
            interleaved[dst + 2] = positions[src + 2];
            interleaved[dst + 3] = normals[src + 0];
            interleaved[dst + 4] = normals[src + 1];
            interleaved[dst + 5] = normals[src + 2];
        }

        const entry = this._bufferManager.appendMeshGeometry(interleaved, indices32);

        // Store in global cache for cross-chunk reuse
        if (entry.drawCommandIndex >= 0) {
            this._globalMeshCache.set(fp, entry);
        }

        if (this._meshCacheMisses % 200 === 0) {
            this._logDedupStats();
        }

        return entry;
    }

    /**
     * Computes a mesh fingerprint for deduplication.
     * Uses vertex count + index count + first 3 vertex positions (rounded).
     *
     * This catches the common case in instanced models where the same pipe/valve/flange
     * geometry appears in hundreds of different spatial chunks.
     */
    private _computeMeshFingerprint(positions: Float32Array, vertexCount: number, indexCount: number): string {
        // Sample first 3 vertices (or fewer if mesh is smaller)
        const sampleCount = Math.min(vertexCount, 3);
        const parts: string[] = [`${vertexCount}|${indexCount}`];

        for (let i = 0; i < sampleCount; i++) {
            const base = i * 3;
            // Round to 4 decimal places to handle minor floating-point differences
            parts.push(
                `${(positions[base] * 10000 | 0)}`,
                `${(positions[base + 1] * 10000 | 0)}`,
                `${(positions[base + 2] * 10000 | 0)}`
            );
        }

        return parts.join('|');
    }

    private _logDedupStats(): void {
        const total = this._meshCacheHits + this._meshCacheMisses;
        const hitRate = total > 0 ? ((this._meshCacheHits / total) * 100).toFixed(1) : '0.0';
        console.log(
            `CustomTileParser: Mesh dedup — ${this._globalMeshCache.size} unique meshes, ` +
            `${this._meshCacheHits} cache hits / ${total} total (${hitRate}% reuse)`
        );
    }

    /** Returns dedup stats for diagnostics */
    public getDedupStats(): { uniqueMeshes: number; cacheHits: number; cacheMisses: number; hitRate: number } {
        const total = this._meshCacheHits + this._meshCacheMisses;
        return {
            uniqueMeshes: this._globalMeshCache.size,
            cacheHits: this._meshCacheHits,
            cacheMisses: this._meshCacheMisses,
            hitRate: total > 0 ? this._meshCacheHits / total : 0,
        };
    }

    /**
     * Extracts TRS matrices and batchIds from EXT_mesh_gpu_instancing attributes.
     */
    private _extractInstancingData(
        gltfJson: any,
        binaryBuffers: ArrayBuffer[],
        instancingExt: any
    ): { packedTRS: Float32Array; batchIds: Uint32Array } | null {
        const attributes = instancingExt.attributes;
        if (!attributes) return null;

        const translationAccessor = this._getAccessorData(gltfJson, binaryBuffers, attributes.TRANSLATION);
        const batchIdAccessor = this._getAccessorData(gltfJson, binaryBuffers, attributes._BATCHID);

        if (!translationAccessor || !batchIdAccessor) {
            console.error("CustomTileParser: Missing TRANSLATION or _BATCHID attributes in EXT_mesh_gpu_instancing.");
            return null;
        }

        let finalTranslations = translationAccessor.data as Float32Array;

        // Dequantize if 16-bit payload
        if (translationAccessor.componentType === 5122 || translationAccessor.componentType === 5123) {
            const isUint = translationAccessor.componentType === 5123;
            const min = translationAccessor.min || [0, 0, 0];
            const max = translationAccessor.max || [1000, 1000, 1000];
            finalTranslations = Quantization.dequantizePositions(
                translationAccessor.data as Uint16Array, min, max, isUint
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

            let qx = 0, qy = 0, qz = 0, qw = 1;
            if (rotations) {
                const rIdx = i * 4;
                qx = rotations[rIdx]; qy = rotations[rIdx + 1];
                qz = rotations[rIdx + 2]; qw = rotations[rIdx + 3];
            }

            let sx = 1, sy = 1, sz = 1;
            if (scales) {
                const sIdx = i * 3;
                sx = scales[sIdx]; sy = scales[sIdx + 1]; sz = scales[sIdx + 2];
            }

            const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
            const xx = qx * x2, xy = qx * y2, xz = qx * z2;
            const yy = qy * y2, yz = qy * z2, zz = qz * z2;
            const wx = qw * x2, wy = qw * y2, wz = qw * z2;

            packedTRS[destIdx + 0] = (1 - (yy + zz)) * sx;
            packedTRS[destIdx + 1] = (xy + wz) * sx;
            packedTRS[destIdx + 2] = (xz - wy) * sx;
            packedTRS[destIdx + 3] = 0;
            packedTRS[destIdx + 4] = (xy - wz) * sy;
            packedTRS[destIdx + 5] = (1 - (xx + zz)) * sy;
            packedTRS[destIdx + 6] = (yz + wx) * sy;
            packedTRS[destIdx + 7] = 0;
            packedTRS[destIdx + 8] = (xz + wy) * sz;
            packedTRS[destIdx + 9] = (yz - wx) * sz;
            packedTRS[destIdx + 10] = (1 - (xx + yy)) * sz;
            packedTRS[destIdx + 11] = 0;
            packedTRS[destIdx + 12] = tx;
            packedTRS[destIdx + 13] = ty;
            packedTRS[destIdx + 14] = tz;
            packedTRS[destIdx + 15] = 1;
        }

        return { packedTRS, batchIds };
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
            case 5121: { // Uint8
                const byteLen = componentCount;
                typedArray = new Uint8Array(buffer.slice(byteOffset, byteOffset + byteLen));
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
