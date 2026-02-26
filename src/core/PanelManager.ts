export type PanelSlot = 'left' | 'right';

interface PanelEntry {
    id: string;
    title: string;
    slot: PanelSlot;
    width: number;
    container: HTMLElement;
    element: HTMLElement;
}

/**
 * Manages flex layout around the canvas with collapsible sidebars.
 * Restructures DOM programmatically — no index.html changes.
 * Dark theme injected via <style>.
 */
export class PanelManager {
    private _wrapper!: HTMLElement;
    private _leftSidebar!: HTMLElement;
    private _rightSidebar!: HTMLElement;
    private _canvas: HTMLCanvasElement;
    private _panels = new Map<string, PanelEntry>();
    private _styleEl!: HTMLStyleElement;

    constructor(canvas: HTMLCanvasElement) {
        this._canvas = canvas;
        this._injectStyles();
        this._buildLayout();
    }

    private _injectStyles(): void {
        this._styleEl = document.createElement('style');
        this._styleEl.textContent = `
.gpuv-wrapper {
    display: flex;
    width: 100%; height: 100%;
    position: absolute; top: 0; left: 0;
    overflow: hidden;
}
.gpuv-sidebar {
    width: 0; min-width: 0;
    height: 100%;
    overflow-y: auto; overflow-x: hidden;
    background: #1e1e2e;
    color: #cdd6f4;
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    font-size: 13px;
    transition: width 0.2s ease;
    flex-shrink: 0;
    box-sizing: border-box;
}
.gpuv-sidebar::-webkit-scrollbar { width: 6px; }
.gpuv-sidebar::-webkit-scrollbar-track { background: #11111b; }
.gpuv-sidebar::-webkit-scrollbar-thumb { background: #45475a; border-radius: 3px; }
.gpuv-canvas-container {
    flex: 1; min-width: 0; height: 100%;
    position: relative;
}
.gpuv-canvas-container canvas {
    width: 100% !important; height: 100% !important;
    display: block;
}
.gpuv-panel { border-bottom: 1px solid #313244; }
.gpuv-panel-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px;
    background: #181825;
    font-weight: 600; font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #89b4fa;
    cursor: pointer;
    user-select: none;
}
.gpuv-panel-header:hover { background: #1e1e2e; }
.gpuv-panel-body { padding: 0; }
`;
        document.head.appendChild(this._styleEl);
    }

    private _buildLayout(): void {
        const parent = this._canvas.parentElement!;
        this._wrapper = document.createElement('div');
        this._wrapper.className = 'gpuv-wrapper';

        this._leftSidebar = document.createElement('div');
        this._leftSidebar.className = 'gpuv-sidebar';

        this._rightSidebar = document.createElement('div');
        this._rightSidebar.className = 'gpuv-sidebar';

        const canvasContainer = document.createElement('div');
        canvasContainer.className = 'gpuv-canvas-container';

        // Move canvas into container
        parent.removeChild(this._canvas);
        canvasContainer.appendChild(this._canvas);

        this._wrapper.appendChild(this._leftSidebar);
        this._wrapper.appendChild(canvasContainer);
        this._wrapper.appendChild(this._rightSidebar);
        parent.appendChild(this._wrapper);
    }

    addPanel(id: string, title: string, slot: PanelSlot, width: number, element: HTMLElement): void {
        const sidebar = slot === 'left' ? this._leftSidebar : this._rightSidebar;

        const container = document.createElement('div');
        container.className = 'gpuv-panel';

        const header = document.createElement('div');
        header.className = 'gpuv-panel-header';
        header.textContent = title;

        const body = document.createElement('div');
        body.className = 'gpuv-panel-body';
        body.appendChild(element);

        container.appendChild(header);
        container.appendChild(body);
        sidebar.appendChild(container);

        // Expand sidebar
        sidebar.style.width = width + 'px';

        this._panels.set(id, { id, title, slot, width, container, element });
    }

    removePanel(id: string): void {
        const entry = this._panels.get(id);
        if (!entry) return;
        entry.container.remove();
        this._panels.delete(id);

        // Collapse sidebar if empty
        const sidebar = entry.slot === 'left' ? this._leftSidebar : this._rightSidebar;
        const remaining = [...this._panels.values()].filter(p => p.slot === entry.slot);
        if (remaining.length === 0) {
            sidebar.style.width = '0';
        }
    }

    dispose(): void {
        this._panels.clear();
        this._styleEl.remove();
        // Restore canvas to body
        const canvasContainer = this._canvas.parentElement!;
        this._wrapper.parentElement!.appendChild(this._canvas);
        this._wrapper.remove();
        canvasContainer.remove();
    }
}
