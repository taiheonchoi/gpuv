import { IViewerPlugin, PluginContext, SelectionEvent } from '../core/PluginTypes';
import { HierarchyData, getNode, getNodeName, getNodeTypeName, getNodeBounds } from '../loaders/HierarchyBinaryReader';
import { MetadataData, getNodeTransform, getNodeProperties } from '../loaders/MetadataBinaryReader';

export class PropertyView implements IViewerPlugin {
    readonly id = 'property-view';

    private _ctx!: PluginContext;
    private _root!: HTMLElement;
    private _content!: HTMLElement;

    private _hierarchyData: HierarchyData | null = null;
    private _metadataData: MetadataData | null = null;

    private _onSelectionChange: ((e: SelectionEvent) => void) | null = null;
    private _onSelectionClear: (() => void) | null = null;

    init(ctx: PluginContext): void {
        this._ctx = ctx;

        this._root = document.createElement('div');
        this._root.style.cssText = 'height:100%;overflow-y:auto;';

        this._content = document.createElement('div');
        this._content.style.cssText = 'padding:8px 12px;';
        this._content.innerHTML = '<span style="color:#6c7086;font-size:12px;">Select an object to view properties.</span>';
        this._root.appendChild(this._content);

        ctx.panelManager.addPanel(this.id, 'Properties', 'right', 300, this._root);

        this._onSelectionChange = (e: SelectionEvent) => {
            this._showNode(e.primaryBatchId);
        };
        this._onSelectionClear = () => {
            this._content.innerHTML = '<span style="color:#6c7086;font-size:12px;">Select an object to view properties.</span>';
        };
        ctx.eventBus.on('selection:change', this._onSelectionChange);
        ctx.eventBus.on('selection:clear', this._onSelectionClear);

        this._loadData();
    }

    activate(): void { }
    deactivate(): void { }

    dispose(): void {
        if (this._onSelectionChange) this._ctx.eventBus.off('selection:change', this._onSelectionChange);
        if (this._onSelectionClear) this._ctx.eventBus.off('selection:clear', this._onSelectionClear);
        this._ctx.panelManager.removePanel(this.id);
    }

    private async _loadData(): Promise<void> {
        try {
            const [h, m] = await Promise.all([
                this._ctx.dataServices.getHierarchyData(),
                this._ctx.dataServices.getMetadataData(),
            ]);
            this._hierarchyData = h;
            this._metadataData = m;
        } catch (e) {
            console.warn('PropertyView: failed to load data', e);
        }
    }

    private _showNode(nodeIndex: number): void {
        if (!this._hierarchyData) {
            this._content.innerHTML = '<span style="color:#f38ba8;">Hierarchy data not loaded.</span>';
            return;
        }

        const hd = this._hierarchyData;
        const node = getNode(hd, nodeIndex);
        const name = getNodeName(hd, nodeIndex);
        const typeName = getNodeTypeName(hd, node.type);

        let html = '';

        // Identity section
        html += this._sectionHeader('Identity');
        html += this._row('Name', name || '(unnamed)');
        html += this._row('Index', String(nodeIndex));
        html += this._row('Type', typeName);
        html += this._row('Depth', String(node.depth));
        html += this._row('Children', String(node.childCount));
        if (node.hasGeometry) {
            html += this._row('Geometry', 'Yes');
        }

        // Bounds section
        const bounds = getNodeBounds(hd, nodeIndex);
        if (bounds) {
            html += this._sectionHeader('Bounds');
            html += this._row('Min', this._formatVec3(bounds.min));
            html += this._row('Max', this._formatVec3(bounds.max));
            const size = [
                bounds.max[0] - bounds.min[0],
                bounds.max[1] - bounds.min[1],
                bounds.max[2] - bounds.min[2],
            ];
            html += this._row('Size', this._formatVec3(size as [number, number, number]));
        }

        // World Transform section
        if (this._metadataData) {
            const transform = getNodeTransform(this._metadataData, nodeIndex);
            if (transform) {
                const isIdentity = transform[0] === 1 && transform[5] === 1 && transform[10] === 1
                    && transform[1] === 0 && transform[2] === 0 && transform[3] === 0
                    && transform[4] === 0 && transform[6] === 0 && transform[7] === 0
                    && transform[8] === 0 && transform[9] === 0 && transform[11] === 0;

                if (!isIdentity) {
                    html += this._sectionHeader('World Transform');
                    // 3x4 matrix displayed as rows
                    for (let r = 0; r < 3; r++) {
                        const base = r * 4;
                        html += this._row(
                            `Row ${r}`,
                            `${transform[base].toFixed(3)}, ${transform[base + 1].toFixed(3)}, ${transform[base + 2].toFixed(3)}, ${transform[base + 3].toFixed(3)}`
                        );
                    }
                } else {
                    // Show translation if present in TRS buffer
                    html += this._sectionHeader('Position');
                    html += this._row('Translation', `${transform[3].toFixed(3)}, ${transform[7].toFixed(3)}, ${transform[11].toFixed(3)}`);
                }
            }
        }

        // Properties section (JSON from metadata.bin)
        if (this._metadataData) {
            const props = getNodeProperties(this._metadataData, nodeIndex);
            if (props && Object.keys(props).length > 0) {
                html += this._sectionHeader('Properties');
                for (const [key, value] of Object.entries(props)) {
                    const displayVal = typeof value === 'object' ? JSON.stringify(value) : String(value);
                    html += this._row(key, displayVal);
                }
            }
        }

        this._content.innerHTML = html;
    }

    private _sectionHeader(title: string): string {
        return `<div style="padding:8px 0 4px;margin-top:8px;border-top:1px solid #313244;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#89b4fa;">${title}</div>`;
    }

    private _row(label: string, value: string): string {
        return `<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;">
            <span style="color:#a6adc8;min-width:80px;flex-shrink:0;">${label}</span>
            <span style="color:#cdd6f4;text-align:right;word-break:break-all;">${value}</span>
        </div>`;
    }

    private _formatVec3(v: [number, number, number]): string {
        return `${v[0].toFixed(2)}, ${v[1].toFixed(2)}, ${v[2].toFixed(2)}`;
    }
}
