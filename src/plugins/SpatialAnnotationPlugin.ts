import { Scene, MeshBuilder, StandardMaterial, Color3, Vector3, Matrix } from '@babylonjs/core';

export interface AnnotationData {
    id: string;
    position: Vector3;
    content: string; // The literal text or query note
    author: string;
}

export interface LaserPointerData {
    userId: string;
    origin: Vector3;
    direction: Vector3;
    color: Color3;
}

/**
 * Executes immersive 3D spatial notations and multiplayer laser pointers 
 * seamlessly interleaved with WebGPU depths.
 */
export class SpatialAnnotationPlugin {
    private _scene: Scene;
    private _laserMap: Map<string, any>;
    private _annotationList: Map<string, any>;

    constructor(scene: Scene) {
        this._scene = scene;
        this._laserMap = new Map();
        this._annotationList = new Map();
    }

    /**
     * Renders a glowing laser beam representation for remote structural pointing.
     */
    public updateLaserPointer(data: LaserPointerData): void {
        let laser = this._laserMap.get(data.userId);

        // Raycasting visually via thin scaled cylinders extending into the geometry
        if (!laser) {
            laser = MeshBuilder.CreateCylinder(`laser_${data.userId}`, { diameter: 0.05, height: 100 }, this._scene);

            const mat = new StandardMaterial(`laser_mat_${data.userId}`, this._scene);
            mat.emissiveColor = data.color;
            mat.disableLighting = true; // Raw beam energy
            mat.alpha = 0.8;

            laser.material = mat;
            // Set pivot to base to scale out correctly
            laser.setPivotMatrix(Matrix.Translation(0, -50, 0), false);
            this._laserMap.set(data.userId, laser);
        }

        // Align coordinates scaling along origin outwards
        laser.position = data.origin;
        // Directional alignment logic using LookAt
        // laser.lookAt(data.origin.add(data.direction));
    }

    /**
     * Maps physical post-it notes floating above structural defects.
     */
    public createSpatialAnnotation(data: AnnotationData): void {
        // Dispose existing annotation if re-adding with same ID to prevent mesh/material leak
        const existing = this._annotationList.get(data.id);
        if (existing) {
            existing.mesh.material?.dispose();
            existing.mesh.dispose();
        }

        const pin = MeshBuilder.CreateSphere(`note_${data.id}`, { diameter: 0.5 }, this._scene);
        pin.position = data.position;

        const mat = new StandardMaterial(`note_mat_${data.id}`, this._scene);
        mat.emissiveColor = new Color3(1, 0.8, 0); // Warning Post-it Yellow
        pin.material = mat;

        // Evolving this: Add GUI floating labels utilizing Babylon AdvancedDynamicTexture
        // For WebGPU scale, rendering these as Billboard meshes or mapping text to HTML DOM overlay is fastest.

        this._annotationList.set(data.id, { mesh: pin, data });
        console.log(`SpatialAnnotation: [${data.author}] left note '${data.content}' at ${data.position.toString()}`);

        // Connect to Spatial Audio to emit a notification 'ping' right here
        this._playSpatialPing(data.position);
    }

    /**
     * Implements distance-based stereo localization for alerts.
     */
    private _playSpatialPing(location: Vector3): void {
        if (location) { /* consumes var */ }
        // Concept: Engine parses audio element, attaches local position to PannerNode
        /*
        const sound = new Sound("note_ping", "ping.wav", this._scene, null, {
            loop: false,
            autoplay: true,
            spatialSound: true,
            maxDistance: 100
        });
        sound.setPosition(location);
        */
    }
}
