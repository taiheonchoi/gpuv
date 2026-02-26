import { WebGPUEngine, Scene } from '@babylonjs/core';
import { EventBus } from './EventBus';
import { PanelManager, PanelSlot } from './PanelManager';
import { DataServices } from './DataServices';
import { PickingManager } from './PickingManager';
import { AppearanceManager } from './AppearanceManager';
import { NavigationCore } from './NavigationCore';

/** Typed event map for the viewer EventBus */
export interface EventMap {
    'selection:change': SelectionEvent;
    'selection:clear': void;
    'pick': { batchId: number; x: number; y: number };
}

export interface SelectionEvent {
    batchIds: number[];
    source: string;
    primaryBatchId: number;
}

export interface PanelDescriptor {
    id: string;
    title: string;
    slot: PanelSlot;
    width: number;
    element: HTMLElement;
}

/** Everything a plugin receives during init */
export interface PluginContext {
    engine: WebGPUEngine;
    scene: Scene;
    canvas: HTMLCanvasElement;
    eventBus: EventBus;
    panelManager: PanelManager;
    dataServices: DataServices;
    pickingManager: PickingManager | null;
    appearanceManager: AppearanceManager | null;
    navigationCore: NavigationCore | null;
}

export interface IViewerPlugin {
    readonly id: string;
    init(ctx: PluginContext): void | Promise<void>;
    activate(): void;
    deactivate(): void;
    dispose(): void;
}
