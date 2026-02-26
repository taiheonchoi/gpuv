import { CustomTileParser, TilesetUris } from './CustomTileParser';
import { DataServices } from '../core/DataServices';
import { AssetLibraryLoader } from './AssetLibraryLoader';
import { parseGLB } from './GlbParser';

interface ChunkManifestEntry {
    file: string;
    stats?: { estimatedBytes?: number };
}

/**
 * Loads a tileset by URL: fetches tileset.json, resolves baseUrl,
 * updates DataServices, loads GAL (if assetLibraryUri), and tile GLBs into CustomTileParser.
 *
 * Supports two modes:
 * 1. Single GLB: root.content.uri points to one file
 * 2. Chunked GLBs: root.content.uri fails → falls back to chunk.manifest.json
 */
export class TilesetLoader {
    constructor(
        private _dataServices: DataServices,
        private _tileParser: CustomTileParser,
        private _assetLibraryLoader: AssetLibraryLoader | null
    ) {}

    static baseUrlFromTilesetUrl(tilesetUrl: string): string {
        const u = new URL(tilesetUrl);
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

        if (uris.assetLibraryUri && this._assetLibraryLoader) {
            const galUrl = new URL(uris.assetLibraryUri, baseUrl).href;
            await this._assetLibraryLoader.loadGAL(galUrl).catch(e =>
                console.warn('TilesetLoader: GAL load failed (non-fatal):', e.message)
            );
        }

        if (uris.contentUri) {
            const tileUrl = new URL(uris.contentUri, baseUrl).href;
            const res = await fetch(tileUrl);
            if (res.ok) {
                // Single GLB mode
                const arrayBuffer = await res.arrayBuffer();
                const { json, binaryBuffers } = parseGLB(arrayBuffer);
                this._tileParser.processTileGltf(json, binaryBuffers);
                return;
            }
            console.warn(`TilesetLoader: Single GLB not found (${res.status}), trying chunk.manifest.json...`);
        }

        // Chunked GLB mode: load chunk.manifest.json from same directory
        await this._loadChunkedGLBs(baseUrl);
    }

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

        // Sort by estimated size descending for largest-first loading
        const sorted = [...chunks].sort((a, b) =>
            (b.stats?.estimatedBytes || 0) - (a.stats?.estimatedBytes || 0)
        );

        // Load in batches of 8 for network concurrency
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
