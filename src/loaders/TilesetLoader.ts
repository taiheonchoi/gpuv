import { CustomTileParser, TilesetUris } from './CustomTileParser';
import { DataServices } from '../core/DataServices';
import { AssetLibraryLoader } from './AssetLibraryLoader';
import { parseGLB } from './GlbParser';

/**
 * Loads a tileset by URL: fetches tileset.json, resolves baseUrl,
 * updates DataServices, loads GAL (if assetLibraryUri), and tile GLB (content.uri) into CustomTileParser.
 */
export class TilesetLoader {
    constructor(
        private _dataServices: DataServices,
        private _tileParser: CustomTileParser,
        private _assetLibraryLoader: AssetLibraryLoader | null
    ) {}

    /**
     * Resolves directory of a URL as base URL (with trailing slash for resolution).
     */
    static baseUrlFromTilesetUrl(tilesetUrl: string): string {
        const u = new URL(tilesetUrl);
        const path = u.pathname;
        const dirPath = path.endsWith('/') ? path : path.substring(0, path.lastIndexOf('/') + 1);
        return u.origin + dirPath;
    }

    /**
     * Fetches tileset JSON and returns parsed JSON and baseUrl.
     */
    async fetchTileset(tilesetUrl: string): Promise<{ tilesetJson: any; baseUrl: string }> {
        const res = await fetch(tilesetUrl);
        if (!res.ok) throw new Error(`Failed to fetch tileset: ${res.status} ${tilesetUrl}`);
        const tilesetJson = await res.json();
        const baseUrl = TilesetLoader.baseUrlFromTilesetUrl(tilesetUrl);
        return { tilesetJson, baseUrl };
    }

    /**
     * Full load: fetch tileset -> set baseUrl -> load GAL (if any) -> load tile GLB -> processTileGltf.
     */
    async loadTileset(tilesetUrl: string): Promise<void> {
        const { tilesetJson, baseUrl } = await this.fetchTileset(tilesetUrl);
        const uris: TilesetUris = this._tileParser.parseTilesetJson(tilesetJson);

        this._dataServices.setBaseUrl(baseUrl);

        if (uris.assetLibraryUri && this._assetLibraryLoader) {
            const galUrl = new URL(uris.assetLibraryUri, baseUrl).href;
            await this._assetLibraryLoader.loadGAL(galUrl);
        }

        if (uris.contentUri) {
            const tileUrl = new URL(uris.contentUri, baseUrl).href;
            const res = await fetch(tileUrl);
            if (!res.ok) throw new Error(`Failed to fetch tile GLB: ${res.status} ${tileUrl}`);
            const arrayBuffer = await res.arrayBuffer();
            const { json, binaryBuffers } = parseGLB(arrayBuffer);
            this._tileParser.processTileGltf(json, binaryBuffers);
        }
    }
}
