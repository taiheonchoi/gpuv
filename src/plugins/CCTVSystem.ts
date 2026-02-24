import { Scene, Camera, Vector3, MeshBuilder, StandardMaterial, Color3, Matrix, Quaternion, Animation, CubicEase, EasingFunction, Animatable } from '@babylonjs/core';

export interface CCTVData {
    id: string;
    position: Vector3;
    target: Vector3;
    fov: number; // in radians
    range: number;
}

/**
 * Simulates a physical CCTV Camera network inside the Custom Spec 2.0 Digital Twin.
 */
export class CCTVSystem {
    private _scene: Scene;
    private _mainCamera: Camera;
    private _cctvMap: Map<string, { model: any; frustum: any; data: CCTVData }>;
    // Track running animations to stop them before starting new ones (prevents stacking)
    private _modelAnims: Map<string, Animatable> = new Map();
    private _coneAnims: Map<string, Animatable> = new Map();

    constructor(scene: Scene, mainCamera: Camera) {
        this._scene = scene;
        this._mainCamera = mainCamera;
        this._cctvMap = new Map();
    }

    /**
     * Initializes a CCTV camera entity with its Frustum visualizer.
     */
    public addCCTV(data: CCTVData): void {
        // Dispose existing CCTV entry if re-adding with same ID to prevent mesh/material leak
        const existing = this._cctvMap.get(data.id);
        if (existing) {
            existing.model.material?.dispose();
            existing.model.dispose();
            existing.frustum.material?.dispose();
            existing.frustum.dispose();
            this._modelAnims.get(data.id)?.stop();
            this._coneAnims.get(data.id)?.stop();
        }

        // Physical CCTV Body Stub
        const cameraBox = MeshBuilder.CreateBox(`cctv_body_${data.id}`, { width: 0.5, height: 0.5, depth: 1 }, this._scene);
        cameraBox.position = data.position;

        // Frustum Visualizer (Cone)
        const diameter = Math.tan(data.fov / 2) * data.range * 2;
        const frustumCone = MeshBuilder.CreateCylinder(`cctv_frustum_${data.id}`, {
            height: data.range,
            diameterTop: 0,
            diameterBottom: diameter,
            tessellation: 32
        }, this._scene);

        // Offset cone pivot to its tip
        frustumCone.setPivotMatrix(Matrix.Translation(0, -data.range / 2, 0), false);

        const mat = new StandardMaterial(`cctv_mat_${data.id}`, this._scene);
        mat.diffuseColor = new Color3(1, 0.2, 0.2);
        mat.alpha = 0.3; // Semi-transparent vision cone
        mat.emissiveColor = new Color3(0.5, 0.1, 0.1);
        frustumCone.material = mat;

        // Position and orient the frustum matching the camera targeting
        frustumCone.position = data.position;

        // Default orientation calculation
        const matrix = Matrix.LookAtLH(data.position, data.target, Vector3.Up());
        matrix.invert();
        const rotation = Quaternion.FromRotationMatrix(matrix);
        // Cylinder default matches Y up, align it to Z forward (LookAt)
        const offsetRot = Quaternion.RotationAxis(new Vector3(1, 0, 0), Math.PI / 2);
        const finalRot = rotation.multiply(offsetRot);

        cameraBox.rotationQuaternion = rotation;
        frustumCone.rotationQuaternion = finalRot;

        this._cctvMap.set(data.id, { model: cameraBox, frustum: frustumCone, data });
    }

    /**
     * Re-syncs the Pan/Tilt/Zoom targeting for a specific CCTV real-time.
     */
    public syncPTZ(id: string, newTarget: Vector3, newFov?: number): void {
        const cctv = this._cctvMap.get(id);
        if (!cctv) return;

        cctv.data.target = newTarget;
        if (newFov) cctv.data.fov = newFov;

        const matrix = Matrix.LookAtLH(cctv.data.position, newTarget, Vector3.Up());
        matrix.invert();
        const rotation = Quaternion.FromRotationMatrix(matrix);

        const offsetRot = Quaternion.RotationAxis(new Vector3(1, 0, 0), Math.PI / 2);

        // Slerp for smooth transition (avoiding immediate snaps from live data)
        if (cctv.model.rotationQuaternion) {
            // Stop any running animations to prevent stacking (memory leak + visual jitter)
            this._modelAnims.get(id)?.stop();
            this._coneAnims.get(id)?.stop();

            // Loop mode 0 = CONSTANT: play once and hold final value (not 2=RELATIVE which spirals)
            const modelAnim = Animation.CreateAndStartAnimation("cctv_ptz_anim", cctv.model, "rotationQuaternion", 60, 30, cctv.model.rotationQuaternion, rotation, 0);
            const coneAnim = Animation.CreateAndStartAnimation("cctv_cone_anim", cctv.frustum, "rotationQuaternion", 60, 30, cctv.frustum.rotationQuaternion, rotation.multiply(offsetRot), 0);

            if (modelAnim) this._modelAnims.set(id, modelAnim);
            if (coneAnim) this._coneAnims.set(id, coneAnim);
        }

        if (newFov) {
            // Update frustum scale based on zoom
            // const newDiameter = Math.tan(newFov / 2) * cctv.data.range * 2;
            // Scale logic application...
        }
    }

    /**
     * Smoothly transitions the user view to the perspective of the specified CCTV camera.
     */
    public viewSwitchToCCTV(id: string): void {
        const cctv = this._cctvMap.get(id);
        if (!cctv) return;

        // Ensure current camera can animate
        const easingFunction = new CubicEase();
        easingFunction.setEasingMode(EasingFunction.EASINGMODE_EASEINOUT);

        // Interpolate Position
        // Loop mode 0 = CONSTANT: play once and hold final value (not 2=RELATIVE which drifts)
        Animation.CreateAndStartAnimation(
            "cameraPosMove",
            this._mainCamera,
            "position",
            60, 60,
            this._mainCamera.position,
            cctv.data.position,
            0,
            easingFunction
        );

        // Interpolate Target (Assumes a TargetCamera structure)
        if ((this._mainCamera as any).setTarget) {
            const currentTarget = (this._mainCamera as any).getTarget();
            // Loop mode 0 = CONSTANT: play once and hold final value (not 2=RELATIVE which drifts)
            Animation.CreateAndStartAnimation(
                "cameraTargetMove",
                this._mainCamera,
                "target",
                60, 60,
                currentTarget,
                cctv.data.target,
                0,
                easingFunction
            );
        }
    }
}
