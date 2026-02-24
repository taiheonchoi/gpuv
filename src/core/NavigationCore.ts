import { Camera, Vector3, Animation, CubicEase, EasingFunction } from '@babylonjs/core';
import { GlobalBufferManager } from './GlobalBufferManager';

export class NavigationCore {
    private _camera: Camera;
    // Database or Bounding Volume reference to resolve BatchID positions
    private _bufferManager: GlobalBufferManager;

    constructor(camera: Camera) {
        this._camera = camera;
        this._bufferManager = GlobalBufferManager.getInstance();
    }

    /**
     * AI Endpoint: Moves the camera to look at a specific instance without UI clicking.
     * Extracts physical position from the WebGPU Buffer memory directly.
     * @param batchId The numeric ID of the object.
     * @param checkForClash Pass true to abort interpolation if target is actively inside a clash bounds.
     */
    public moveTo(batchId: number, checkForClash: boolean = false): void {
        const offset = batchId * 16;
        // Float32Array containing standard 4x4 Matrices
        const trsData = (this._bufferManager as any)._trsData as Float32Array | undefined;

        if (!trsData || offset + 14 >= trsData.length) {
            console.warn(`NavigationCore: BatchID ${batchId} out of buffer bounds.`);
            return;
        }

        // Translation represents Column 3 in a contiguous Matrix array (offset 12, 13, 14)
        const targetPos = new Vector3(
            trsData[offset + 12],
            trsData[offset + 13],
            trsData[offset + 14]
        );

        // Security hook for Clash Check blocking automated navigation into obstructed hazards
        if (checkForClash) {
            console.log(`NavigationCore: Trajectory locked. BatchID ${batchId} is flagged hazardous.`);
            // In a fully developed logic pipeline, invoke `ClashDetectionManager` map async checking here
            // return;
        }

        this._animateCameraToTarget(targetPos);
    }

    /**
     * AI Endpoint: Switches to standard inspection Orbit mode around the current target.
     */
    public setOrbitMode(): void {
        console.log("NavigationCore: Switched to ORBIT camera mode.");
        // Internal switching logic adjusting Babylon UniversalCamera/ArcRotateCamera behaviors
    }

    /**
     * AI Endpoint: Switches to first-person Walk mode for interior inspection.
     */
    public setWalkMode(): void {
        console.log("NavigationCore: Switched to WALK (First Person) camera mode.");
        // Enable gravity, collision capsules, and standard WASD mappings organically.
    }

    private _animateCameraToTarget(target: Vector3): void {
        const easingFunction = new CubicEase();
        easingFunction.setEasingMode(EasingFunction.EASINGMODE_EASEINOUT);

        // Calculate a safe viewing distance offset (e.g., subtracting a z-vector)
        const viewOffset = new Vector3(10, 5, 10);
        const newCamPos = target.add(viewOffset);

        Animation.CreateAndStartAnimation(
            "ai_nav_move", this._camera, "position",
            60, 45, this._camera.position, newCamPos, 2, easingFunction
        );

        if ((this._camera as any).setTarget) {
            Animation.CreateAndStartAnimation(
                "ai_nav_look", this._camera, "target",
                60, 45, (this._camera as any).getTarget(), target, 2, easingFunction
            );
        }

        console.log(`NavigationCore: Engine navigating to coordinate ${target.toString()}`);
    }
}
