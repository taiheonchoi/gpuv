import { HierarchyData, readHierarchyBin } from '../loaders/HierarchyBinaryReader';
import { MetadataData, readMetadataBin } from '../loaders/MetadataBinaryReader';

/**
 * Shared fetch-once cache for hierarchy.bin and metadata.bin.
 * Both plugins share one fetch instead of fetching twice.
 */
export class DataServices {
    private _baseUrl: string;
    private _hierarchyPromise: Promise<HierarchyData> | null = null;
    private _metadataPromise: Promise<MetadataData> | null = null;

    constructor(baseUrl: string) {
        // baseUrl is the directory containing tileset.json, hierarchy.bin, metadata.bin
        this._baseUrl = baseUrl.replace(/\/$/, '');
    }

    get baseUrl(): string { return this._baseUrl; }

    /** Updates baseUrl (e.g. after loading a tileset). Clears cached hierarchy/metadata. */
    setBaseUrl(baseUrl: string): void {
        const normalized = baseUrl.replace(/\/$/, '');
        if (this._baseUrl === normalized) return;
        this._baseUrl = normalized;
        this._hierarchyPromise = null;
        this._metadataPromise = null;
    }

    async getHierarchyData(): Promise<HierarchyData> {
        if (!this._hierarchyPromise) {
            this._hierarchyPromise = fetch(`${this._baseUrl}/hierarchy.bin`)
                .then(r => {
                    if (!r.ok) throw new Error(`Failed to fetch hierarchy.bin: ${r.status}`);
                    return r.arrayBuffer();
                })
                .then(buf => readHierarchyBin(buf));
        }
        return this._hierarchyPromise;
    }

    async getMetadataData(): Promise<MetadataData> {
        if (!this._metadataPromise) {
            this._metadataPromise = fetch(`${this._baseUrl}/metadata.bin`)
                .then(r => {
                    if (!r.ok) throw new Error(`Failed to fetch metadata.bin: ${r.status}`);
                    return r.arrayBuffer();
                })
                .then(buf => readMetadataBin(buf));
        }
        return this._metadataPromise;
    }

    dispose(): void {
        this._hierarchyPromise = null;
        this._metadataPromise = null;
    }
}
