import { Scene, FreeCamera, Vector3, HemisphericLight, MeshBuilder, WebGPUEngine } from '@babylonjs/core';
import * as dat from 'dat.gui';

export class SceneSetup {
    private _scene: Scene;
    private _engine: WebGPUEngine;
    private _gui: dat.GUI;
    // GPU timestamp variables
    private _gpuFrameTimeMs: number = 0;

    constructor(scene: Scene, engine: WebGPUEngine) {
        this._scene = scene;
        this._engine = engine;
        this._gui = new dat.GUI({ name: 'Performance Monitor' });
    }

    public setupBasicScene(): void {
        const camera = new FreeCamera("camera1", new Vector3(0, 5, -10), this._scene);
        camera.setTarget(Vector3.Zero());

        // Use standard input attachment instead of the missing WebGPUEngine parameter
        camera.attachControl(this._engine.getRenderingCanvas(), true);

        const light = new HemisphericLight("light1", new Vector3(0, 1, 0), this._scene);
        light.intensity = 0.7;

        // Visual anchor
        MeshBuilder.CreateSphere("sphere", { diameter: 2, segments: 32 }, this._scene);
        MeshBuilder.CreateGround("ground", { width: 10, height: 10 }, this._scene);
    }

    public setupPerformanceMonitoring(): void {
        const perfFolder = this._gui.addFolder('Performance');

        const monitorParams = {
            fps: "0",
            gpuFrameTime: "0.00 ms"
        };

        perfFolder.add(monitorParams, 'fps').name('FPS').listen();
        perfFolder.add(monitorParams, 'gpuFrameTime').name('GPU Frame Time').listen();
        perfFolder.open();

        setInterval(() => {
            monitorParams.fps = this._engine.getFps().toFixed(2);
            monitorParams.gpuFrameTime = this._gpuFrameTimeMs.toFixed(2) + " ms";
        }, 500);
    }

    public beginFrame(): void {
        // High-precision custom GPU metrics can begin here
    }

    public endFrame(): void {
        // Retrieve and calculate GPU frame times
        // Note: Actual WebGPU timestamp queries require specific WebGPU extensions enabled
        // and using timestamp write queues.
        // This calculates an estimated frame time as a fallback for the timestamp query system.
        this._gpuFrameTimeMs = 1000 / (this._engine.getFps() + 0.001);
    }
}
