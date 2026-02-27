import { CustomTileParser, TilesetUris } from './CustomTileParser';
import { DataServices } from '../core/DataServices';
import { AssetLibraryLoader } from './AssetLibraryLoader';
import { GlobalBufferManager, MeshAtlasEntry } from '../core/GlobalBufferManager';
import { parseGLB } from './GlbParser';

/** ITRS binary constants (must match Tiler InstanceTrsCompiler) */
const ITRS_MAGIC = 0x53525449;
const ITRS_HEADER_SIZE = 16;
const ITRS_RECORD_SIZE = 72;

interface ChunkManifestEntry {
    file: string;
    stats?: { estimatedBytes?: number };
}

/**
 * Loads a tileset by URL: fetches tileset.json, resolves baseUrl,
 * updates DataServices, loads GAL (if assetLibraryUri), and tile GLBs into CustomTileParser.
 *
 * Supports three modes (tried in priority order):
 * 1. Atlas First: instanceTrsUri → GAL + instance_trs.bin (no chunk GLBs needed)
 * 2. Single GLB: root.content.uri points to one file
 * 3. Chunked GLBs: root.content.uri fails → falls back to chunk.manifest.json
 */
export class TilesetLoader {
    constructor(
        private _dataServices: DataServices,
        private _tileParser: CustomTileParser,
        private _assetLibraryLoader: AssetLibraryLoader | null
    ) {}

    static baseUrlFromTilesetUrl(tilesetUrl: string): string {
        const u = new URL(tilesetUrl, window.location.origin);
        const path = u.pathname;
        const dirPath = path.endsWith('/') ? path : path.substring(0, path.lastIndexOf('/') + 1);
        return u.origin + dirPath;
    }

    async fetchTileset(tilesetUrl: string): Promise<{ tilesetJson: any; baseUrl: string }> {
        const res = await fetch(tilesetUrl);
        if (!res.ok) throw new Error(`Failed to fetch tileset: ${res.status} ${tilesetUrl}`);
        const tilesetJson = await res.json();
        const baseUrl = TilesetLoader.baseUrlFromTilesetUrl(tilesetUrl);
        return { tilesetJson, baseUrl };
    }

    async loadTileset(tilesetUrl: string): Promise<void> {
        const { tilesetJson, baseUrl } = await this.fetchTileset(tilesetUrl);
        const uris: TilesetUris = this._tileParser.parseTilesetJson(tilesetJson);

        this._dataServices.setBaseUrl(baseUrl);

        // Mode 1: Atlas First — GAL + instance_trs.bin
        if (uris.instanceTrsUri && uris.assetLibraryUri) {
            console.log('TilesetLoader: Atlas First mode (GAL + instance_trs.bin)');
            await this._loadAtlasFirst(baseUrl, uris);
            return;
        }

        // Load GAL if available (non-blocking for legacy modes)
        if (uris.assetLibraryUri && this._assetLibraryLoader) {
            const galUrl = new URL(uris.assetLibraryUri, baseUrl).href;
            await this._assetLibraryLoader.loadGAL(galUrl).catch(e =>
                console.warn('TilesetLoader: GAL load failed (non-fatal):', e.message)
            );
        }

        // Mode 2: Single GLB
        if (uris.contentUri) {
            const tileUrl = new URL(uris.contentUri, baseUrl).href;
            const res = await fetch(tileUrl);
            const ct = res.headers.get('content-type') || '';
            if (res.ok && !ct.startsWith('text/html')) {
                const arrayBuffer = await res.arrayBuffer();
                const { json, binaryBuffers } = parseGLB(arrayBuffer);
                this._tileParser.processTileGltf(json, binaryBuffers);
                GlobalBufferManager.getInstance().finalizeDrawCommands();
                return;
            }
            console.warn(`TilesetLoader: Single GLB not found (${res.status}, ct=${ct}), trying chunk.manifest.json...`);
        }

        // Mode 3: Chunked GLB mode
        await this._loadChunkedGLBs(baseUrl);
    }

    /**
     * Atlas First loading: GAL GLB for geometry + instance_trs.bin for instances.
     * No chunk GLBs needed — all geometry comes from GAL, all instances from binary.
     */
    private async _loadAtlasFirst(baseUrl: string, uris: TilesetUris): Promise<void> {
        const bufferManager = GlobalBufferManager.getInstance();

        // Step 1: Fetch GAL GLB and instance_trs.bin in parallel
        const galUrl = new URL(uris.assetLibraryUri!, baseUrl).href;
        const itrsUrl = new URL(uris.instanceTrsUri!, baseUrl).href;

        console.log(`TilesetLoader: Fetching GAL from ${galUrl}`);
        console.log(`TilesetLoader: Fetching instance_trs.bin from ${itrsUrl}`);

        const [galResponse, itrsResponse] = await Promise.all([
            fetch(galUrl),
            fetch(itrsUrl),
        ]);

        if (!galResponse.ok) throw new Error(`GAL fetch failed: ${galResponse.status}`);
        if (!itrsResponse.ok) throw new Error(`instance_trs.bin fetch failed: ${itrsResponse.status}`);

        const [galBuffer, itrsBuffer] = await Promise.all([
            galResponse.arrayBuffer(),
            itrsResponse.arrayBuffer(),
        ]);

        console.log(`TilesetLoader: GAL ${(galBuffer.byteLength / 1024).toFixed(1)} KB, instance_trs.bin ${(itrsBuffer.byteLength / 1024).toFixed(1)} KB`);

        // Step 2: Parse GAL GLB → resolve all buffers (BIN chunks + data URIs)
        const { json: galJson, binaryBuffers: glbBinChunks } = parseGLB(galBuffer);
        const allBuffers = this._resolveGltfBuffers(galJson, glbBinChunks);
        const meshAtlasMap = this._extractGalMeshes(galJson, allBuffers);

        // Step 3: Parse instance_trs.bin → populate TRS + batchId buffers + route to draw commands
        this._processInstanceTrsBinary(itrsBuffer, meshAtlasMap, bufferManager);

        // Step 4: Finalize
        bufferManager.finalizeDrawCommands();
    }

    /**
     * Resolve all glTF buffer references into ArrayBuffers.
     * GLB files may have buffer[0] as the BIN chunk and buffers[1..N] as data URIs.
     * This creates a complete array matching gltfJson.buffers indices.
     */
    private _resolveGltfBuffers(gltfJson: any, glbBinChunks: ArrayBuffer[]): ArrayBuffer[] {
        const bufferDefs = gltfJson.buffers || [];
        const resolved: ArrayBuffer[] = new Array(bufferDefs.length);

        for (let i = 0; i < bufferDefs.length; i++) {
            const bufDef = bufferDefs[i];
            if (!bufDef.uri) {
                // No URI → GLB BIN chunk (typically buffer[0])
                resolved[i] = glbBinChunks[0] || new ArrayBuffer(0);
            } else if (bufDef.uri.startsWith('data:')) {
                // Data URI → decode base64
                const commaIdx = bufDef.uri.indexOf(',');
                const b64 = bufDef.uri.substring(commaIdx + 1);
                const binary = atob(b64);
                const bytes = new Uint8Array(binary.length);
                for (let j = 0; j < binary.length; j++) {
                    bytes[j] = binary.charCodeAt(j);
                }
                resolved[i] = bytes.buffer;
            } else {
                // External URI — not expected in GAL GLB, skip
                console.warn(`TilesetLoader: External buffer URI not supported: ${bufDef.uri.substring(0, 50)}...`);
                resolved[i] = new ArrayBuffer(0);
            }
        }

        return resolved;
    }

    /**
     * Extract all mesh geometries from the GAL GLB into the GPU atlas.
     * Returns a map: meshIndex (within GAL) → MeshAtlasEntry.
     *
     * GAL layout: each mesh in gltfJson.meshes is a unique part.
     * The mesh index in GAL corresponds to the unique_meshes.id from SoT DB.
     */
    private _extractGalMeshes(galJson: any, galBinaries: ArrayBuffer[]): Map<number, MeshAtlasEntry> {
        const bufferManager = GlobalBufferManager.getInstance();
        const meshMap = new Map<number, MeshAtlasEntry>();

        const meshes = galJson.meshes;
        if (!meshes || meshes.length === 0) {
            console.warn('TilesetLoader: GAL has no meshes');
            return meshMap;
        }

        // Build a mesh_id → mesh_index map from GAL nodes' extras.partID
        // If nodes have extras.partID, use that. Otherwise, index matches mesh index.
        const meshIdToGalIndex = new Map<number, number>();

        // First, try to map via nodes (extras.partID or extras.meshId)
        if (galJson.nodes) {
            for (const node of galJson.nodes) {
                if (node.mesh !== undefined) {
                    const extras = node.extras;
                    const partID = extras?.partID ?? extras?.meshId ?? extras?.mesh_id;
                    if (partID !== undefined) {
                        meshIdToGalIndex.set(Number(partID), node.mesh);
                    }
                }
            }
        }

        // If no partID mapping found, assume meshes are indexed 1-based (matching unique_meshes.id)
        if (meshIdToGalIndex.size === 0) {
            for (let i = 0; i < meshes.length; i++) {
                // unique_meshes.id starts from 1 typically, but mesh array is 0-based
                // Check if mesh has extras.id
                const meshId = meshes[i]?.extras?.id ?? meshes[i]?.extras?.meshId ?? (i + 1);
                meshIdToGalIndex.set(Number(meshId), i);
            }
        }

        console.log(`TilesetLoader: Extracting ${meshes.length} GAL meshes (${meshIdToGalIndex.size} mapped IDs)`);

        let totalVertices = 0;
        let totalIndices = 0;

        for (const [meshId, meshIndex] of meshIdToGalIndex) {
            const mesh = meshes[meshIndex];
            if (!mesh?.primitives?.length) continue;

            const primitive = mesh.primitives[0];
            const posAccessorIdx = primitive.attributes?.POSITION;
            if (posAccessorIdx === undefined) continue;

            // Extract POSITION
            const posData = this._getAccessorData(galJson, galBinaries, posAccessorIdx);
            if (!posData) continue;
            const positions = posData.data as Float32Array;
            const vertexCount = positions.length / 3;

            // Extract indices
            if (primitive.indices === undefined) continue;
            const idxData = this._getAccessorData(galJson, galBinaries, primitive.indices);
            if (!idxData) continue;

            // Extract NORMAL (optional)
            let normals: Float32Array;
            const normalAccessorIdx = primitive.attributes?.NORMAL;
            if (normalAccessorIdx !== undefined) {
                const normalData = this._getAccessorData(galJson, galBinaries, normalAccessorIdx);
                normals = normalData ? normalData.data as Float32Array : new Float32Array(vertexCount * 3);
            } else {
                normals = new Float32Array(vertexCount * 3);
                for (let i = 0; i < vertexCount; i++) normals[i * 3 + 1] = 1.0;
            }

            // Convert indices to Uint32
            let indices32: Uint32Array;
            if (idxData.data instanceof Uint32Array) {
                indices32 = idxData.data;
            } else {
                indices32 = new Uint32Array(idxData.data.length);
                for (let i = 0; i < idxData.data.length; i++) indices32[i] = idxData.data[i];
            }

            // Interleave position + normal → 6 floats per vertex
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

            const entry = bufferManager.appendMeshGeometry(interleaved, indices32);
            if (entry.drawCommandIndex >= 0) {
                meshMap.set(meshId, entry);
                totalVertices += vertexCount;
                totalIndices += indices32.length;
            }
        }

        console.log(`TilesetLoader: GAL atlas: ${meshMap.size} meshes, ${totalVertices} vertices, ${totalIndices} indices`);
        return meshMap;
    }

    /**
     * Parse instance_trs.bin binary and populate GPU buffers.
     *
     * Binary layout (from InstanceTrsCompiler):
     *   HEADER (16B): magic, version, count, meshCount
     *   RECORDS (count × 72B): nodeId(u32), meshId(u32), trs(16 × f32)
     *   MESH_TABLE (meshCount × 4B): sorted distinct meshIds
     */
    private _processInstanceTrsBinary(
        buffer: ArrayBuffer,
        meshAtlasMap: Map<number, MeshAtlasEntry>,
        bufferManager: GlobalBufferManager
    ): void {
        const view = new DataView(buffer);

        // Validate header
        const magic = view.getUint32(0, true);
        if (magic !== ITRS_MAGIC) {
            throw new Error(`instance_trs.bin: invalid magic 0x${magic.toString(16)} (expected 0x${ITRS_MAGIC.toString(16)})`);
        }
        const version = view.getUint32(4, true);
        const instanceCount = view.getUint32(8, true);
        const meshCount = view.getUint32(12, true);

        console.log(`TilesetLoader: instance_trs.bin v${version}: ${instanceCount} instances, ${meshCount} meshes`);

        // Group records by meshId for batch upload per draw command
        // meshId → { trsArrays, batchIds }
        const groupedByMesh = new Map<number, { trsList: Float32Array[]; batchIdList: number[]; count: number }>();

        let offset = ITRS_HEADER_SIZE;
        for (let i = 0; i < instanceCount; i++) {
            const nodeId = view.getUint32(offset, true);
            const meshId = view.getUint32(offset + 4, true);

            // Read 16 floats (4×4 matrix) — TRS in column-major order
            const trs = new Float32Array(16);
            for (let j = 0; j < 16; j++) {
                trs[j] = view.getFloat32(offset + 8 + j * 4, true);
            }
            offset += ITRS_RECORD_SIZE;

            if (!groupedByMesh.has(meshId)) {
                groupedByMesh.set(meshId, { trsList: [], batchIdList: [], count: 0 });
            }
            const group = groupedByMesh.get(meshId)!;
            group.trsList.push(trs);
            group.batchIdList.push(nodeId);
            group.count++;
        }

        // Upload instances grouped by meshId → each group maps to a draw command
        let totalUploaded = 0;
        let unmappedMeshes = 0;

        for (const [meshId, group] of groupedByMesh) {
            const atlasEntry = meshAtlasMap.get(meshId);
            if (!atlasEntry) {
                // Mesh not found in GAL — skip these instances
                if (unmappedMeshes < 5) {
                    console.warn(`TilesetLoader: meshId ${meshId} not found in GAL atlas (${group.count} instances skipped)`);
                }
                unmappedMeshes++;
                continue;
            }

            // Build contiguous TRS and batchId arrays for this group
            const count = group.count;
            const packedTRS = new Float32Array(count * 16);
            const batchIds = new Uint32Array(count);

            for (let i = 0; i < count; i++) {
                packedTRS.set(group.trsList[i], i * 16);
                batchIds[i] = group.batchIdList[i];
            }

            const firstTrs = bufferManager.appendInstanceData(packedTRS, batchIds);
            bufferManager.addDrawCommandInstances(atlasEntry.drawCommandIndex, count, firstTrs);
            totalUploaded += count;
        }

        if (unmappedMeshes > 0) {
            console.warn(`TilesetLoader: ${unmappedMeshes} meshIds not found in GAL atlas`);
        }

        console.log(`TilesetLoader: ${totalUploaded}/${instanceCount} instances uploaded to GPU (${groupedByMesh.size} mesh groups)`);
    }

    /**
     * Resolves accessor data from glTF JSON + binary buffers.
     * Same logic as CustomTileParser._getAccessorData but accessible here.
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
                throw new Error(`TilesetLoader: Unsupported componentType ${accessor.componentType}`);
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

    // ── Legacy loading modes (kept for backward compatibility) ──

    private async _loadChunkedGLBs(baseUrl: string): Promise<void> {
        const manifestUrl = new URL('chunk.manifest.json', baseUrl).href;
        const manifestRes = await fetch(manifestUrl);
        if (!manifestRes.ok) {
            console.error(`TilesetLoader: chunk.manifest.json not found (${manifestRes.status})`);
            return;
        }

        const manifestJson = await manifestRes.json();
        const chunks: ChunkManifestEntry[] = manifestJson.chunks || manifestJson;
        console.log(`TilesetLoader: Loading ${chunks.length} chunk GLBs...`);

        const sorted = [...chunks].sort((a, b) =>
            (b.stats?.estimatedBytes || 0) - (a.stats?.estimatedBytes || 0)
        );

        const BATCH_SIZE = 8;
        let loaded = 0;
        for (let i = 0; i < sorted.length; i += BATCH_SIZE) {
            const batch = sorted.slice(i, i + BATCH_SIZE);
            const results = await Promise.allSettled(
                batch.map(chunk => this._loadSingleChunk(baseUrl, chunk.file))
            );
            for (const r of results) {
                if (r.status === 'fulfilled') loaded++;
            }
            if (loaded % 50 === 0 || i + BATCH_SIZE >= sorted.length) {
                console.log(`TilesetLoader: ${loaded}/${chunks.length} chunks loaded`);
            }
        }

        console.log(`TilesetLoader: Finished loading ${loaded}/${chunks.length} chunk GLBs`);
        GlobalBufferManager.getInstance().finalizeDrawCommands();
    }

    private async _loadSingleChunk(baseUrl: string, filename: string): Promise<void> {
        const url = new URL(filename, baseUrl).href;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Chunk ${filename}: ${res.status}`);
        const arrayBuffer = await res.arrayBuffer();
        const { json, binaryBuffers } = parseGLB(arrayBuffer);
        this._tileParser.processTileGltf(json, binaryBuffers);
    }
}
