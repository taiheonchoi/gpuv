import { Scene, FreeCamera, Vector3, HemisphericLight, WebGPUEngine } from '@babylonjs/core';
import * as dat from 'dat.gui';

export class SceneSetup {
    private _scene: Scene;
    private _engine: WebGPUEngine;
    private _gui: dat.GUI;
    // GPU timestamp variables
    private _gpuFrameTimeMs: number = 0;
    private _perfIntervalId: ReturnType<typeof setInterval> | null = null;

    constructor(scene: Scene, engine: WebGPUEngine) {
        this._scene = scene;
        this._engine = engine;
        this._gui = new dat.GUI({ name: 'Performance Monitor' });
    }

    public setupBasicScene(): void {
        // Model BBOX: x=[-2252, 1832], y=[-99, 603], z=[-32, 26], center=(-210, 252, -3)
        // 191K instances at origin (0,0,0) with sub-meter mesh parts — start there
        const camera = new FreeCamera("camera1", new Vector3(0, 1, -3), this._scene);
        camera.setTarget(new Vector3(0, 0, 0));
        camera.minZ = 0.001;
        camera.maxZ = 20000;
        camera.speed = 2;

        // Use standard input attachment instead of the missing WebGPUEngine parameter
        camera.attachControl(this._engine.getRenderingCanvas(), true);

        const light = new HemisphericLight("light1", new Vector3(0, 1, 0), this._scene);
        light.intensity = 0.7;

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

        this._perfIntervalId = setInterval(() => {
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

    public dispose(): void {
        if (this._perfIntervalId !== null) {
            clearInterval(this._perfIntervalId);
            this._perfIntervalId = null;
        }
        this._gui.destroy();
    }
}
