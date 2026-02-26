import { WebGPUEngine, Scene } from '@babylonjs/core';
import { GlobalBufferManager } from './GlobalBufferManager';
import { SceneSetup } from './SceneSetup';
import { EventBus } from './EventBus';
import { PanelManager } from './PanelManager';
import { SelectionController } from './SelectionController';
import { DataServices } from './DataServices';
import { PickingManager } from './PickingManager';
import { AppearanceManager } from './AppearanceManager';
import { NavigationCore } from './NavigationCore';
import { SensorLinkManager } from './SensorLinkManager';
import { IViewerPlugin, PluginContext } from './PluginTypes';

export class EngineSetup {
    private _canvas: HTMLCanvasElement;
    private _engine!: WebGPUEngine;
    private _scene!: Scene;
    private _sceneSetup!: SceneSetup;
    private _bufferManager!: GlobalBufferManager;
    private _resizeHandler: (() => void) | null = null;

    // Plugin infrastructure
    private _eventBus!: EventBus;
    private _panelManager!: PanelManager;
    private _selectionController: SelectionController | null = null;
    private _dataServices!: DataServices;
    private _pickingManager: PickingManager | null = null;
    private _appearanceManager: AppearanceManager | null = null;
    private _navigationCore: NavigationCore | null = null;
    private _plugins: IViewerPlugin[] = [];

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

        // Initialize plugin infrastructure
        this._eventBus = new EventBus();
        this._panelManager = new PanelManager(this._canvas);
        this._dataServices = new DataServices('/models/1018/output/sot');

        // Initialize optional managers (may already exist in the codebase)
        try {
            this._pickingManager = new PickingManager(this._engine);
            const sensorManager = new SensorLinkManager();
            this._appearanceManager = new AppearanceManager(sensorManager);
            this._navigationCore = new NavigationCore(this._scene.activeCamera!);
        } catch (e) {
            console.warn('EngineSetup: Some managers could not be initialized:', e);
        }

        // Wire selection controller
        if (this._pickingManager) {
            this._selectionController = new SelectionController(this._canvas, this._eventBus, this._pickingManager);
        }

        // Wire EventBus to AppearanceManager and NavigationCore
        if (this._appearanceManager) {
            const am = this._appearanceManager;
            this._eventBus.on('selection:change', (e) => am.setHighlight(e.batchIds));
            this._eventBus.on('selection:clear', () => am.setHighlight([]));
        }
        if (this._navigationCore) {
            const nc = this._navigationCore;
            this._eventBus.on('selection:change', (e) => nc.moveTo(e.primaryBatchId));
        }

        this._engine.runRenderLoop(() => {
            this._sceneSetup.beginFrame();
            this._scene.render();
            this._sceneSetup.endFrame();
        });

        this._resizeHandler = () => { this._engine.resize(); };
        window.addEventListener('resize', this._resizeHandler);

        console.log("Custom Spec 2.0 WebGPU Engine Initialized.");
    }

    /** Register and initialize a viewer plugin */
    public async registerPlugin(plugin: IViewerPlugin): Promise<void> {
        const ctx: PluginContext = {
            engine: this._engine,
            scene: this._scene,
            canvas: this._canvas,
            eventBus: this._eventBus,
            panelManager: this._panelManager,
            dataServices: this._dataServices,
            pickingManager: this._pickingManager,
            appearanceManager: this._appearanceManager,
            navigationCore: this._navigationCore,
        };
        await plugin.init(ctx);
        plugin.activate();
        this._plugins.push(plugin);
        console.log(`Plugin registered: ${plugin.id}`);
    }

    public get engine(): WebGPUEngine {
        return this._engine;
    }

    public get scene(): Scene {
        return this._scene;
    }

    public get eventBus(): EventBus {
        return this._eventBus;
    }

    public get dataServices(): DataServices {
        return this._dataServices;
    }

    public dispose(): void {
        // Dispose plugins in reverse order
        for (let i = this._plugins.length - 1; i >= 0; i--) {
            this._plugins[i].deactivate();
            this._plugins[i].dispose();
        }
        this._plugins = [];

        this._selectionController?.dispose();
        this._pickingManager?.dispose();
        this._panelManager.dispose();
        this._eventBus.dispose();
        this._dataServices.dispose();

        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler);
            this._resizeHandler = null;
        }
        this._engine.stopRenderLoop();
        this._sceneSetup.dispose();
        this._bufferManager.dispose();
        this._scene.dispose();
        this._engine.dispose();
    }
}
