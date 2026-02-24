import { WebGPUEngine, Scene } from '@babylonjs/core';
import { GlobalBufferManager } from './GlobalBufferManager';
import { SceneSetup } from './SceneSetup';

export class EngineSetup {
    private _canvas: HTMLCanvasElement;
    private _engine!: WebGPUEngine;
    private _scene!: Scene;
    private _sceneSetup!: SceneSetup;
    private _bufferManager!: GlobalBufferManager;

    constructor(canvas: HTMLCanvasElement) {
        this._canvas = canvas;
    }

    public async init(): Promise<void> {
        const supported = await WebGPUEngine.IsSupportedAsync;
        if (!supported) {
            console.error("WebGPU is not supported on this browser.");
            alert("WebGPU is not supported. Please use a compatible browser.");
            return;
        }

        console.log("WebGPU supported. Initializing engine...");

        this._engine = new WebGPUEngine(this._canvas, {
            antialias: true,
        });

        await this._engine.initAsync();

        this._scene = new Scene(this._engine);

        // Initialize components
        this._sceneSetup = new SceneSetup(this._scene, this._engine);
        this._sceneSetup.setupBasicScene();
        this._sceneSetup.setupPerformanceMonitoring();

        this._bufferManager = GlobalBufferManager.getInstance(this._engine);
        this._bufferManager.initializeDummyBuffer();

        this._engine.runRenderLoop(() => {
            this._sceneSetup.beginFrame();
            this._scene.render();
            this._sceneSetup.endFrame();
        });

        window.addEventListener('resize', () => {
            this._engine.resize();
        });

        console.log("Custom Spec 2.0 WebGPU Engine Initialized.");
    }

    public get engine(): WebGPUEngine {
        return this._engine;
    }

    public get scene(): Scene {
        return this._scene;
    }
}
