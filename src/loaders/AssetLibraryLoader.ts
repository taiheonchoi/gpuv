import { Scene, SceneLoader, AbstractMesh } from '@babylonjs/core';
import '@babylonjs/loaders/glTF';

/**
 * Loads and oversees the Global Asset Library (GAL) 
 * ensuring we map master shared engineering parts without replicating geometry.
 */
export class AssetLibraryLoader {
    private _scene: Scene;
    private _meshLibrary: Map<string, AbstractMesh>;

    constructor(scene: Scene) {
        this._scene = scene;
        this._meshLibrary = new Map<string, AbstractMesh>();
    }

    /**
     * Loads the master .glb file and parses `extras.partID`
     */
    public async loadGAL(glbPath: string): Promise<void> {
        try {
            console.log(`Loading Global Asset Library (GAL) from ${glbPath}...`);
            const importResult = await SceneLoader.ImportMeshAsync("", glbPath, "", this._scene);

            for (const mesh of importResult.meshes) {
                // Ensure Library meshes are invisible, as they are drawn indirectly via Batcher
                mesh.isVisible = false;

                // Inspecting node metadata from GLB extras
                if (mesh.metadata && mesh.metadata.gltf && mesh.metadata.gltf.extras) {
                    const partID = mesh.metadata.gltf.extras.partID;
                    if (partID) {
                        this._meshLibrary.set(partID.toString(), mesh);
                    } else {
                        console.warn(`AssetLibrary: Mesh ${mesh.name} is missing 'partID' in extras.`);
                    }
                } else {
                    // Fail silently or explicitly, wait for production tilesets to match layout
                    if (mesh.name !== "__root__") {
                        console.warn(`AssetLibrary: Mesh ${mesh.name} lacks glTF extras metadata.`);
                    }
                }
            }

            console.log(`Successfully loaded GAL. Extracted ${this._meshLibrary.size} master parts into memory.`);

        } catch (error) {
            console.error("AssetLibrary: Failed to load Global Asset Library:", error);
            throw error; // Let the core engine handler catch this
        }
    }

    public getMeshByPartID(partID: string): AbstractMesh | undefined {
        return this._meshLibrary.get(partID);
    }

    public getLibrary(): Map<string, AbstractMesh> {
        return this._meshLibrary;
    }
}
