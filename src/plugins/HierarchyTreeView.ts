import { IViewerPlugin, PluginContext, SelectionEvent } from '../core/PluginTypes';
import { HierarchyData, getNode, getNodeName, getNodeTypeName } from '../loaders/HierarchyBinaryReader';

const ROW_HEIGHT = 24;
const INDENT_PX = 16;
const OVERSCAN = 5;
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Flat-list entry for virtual scroll. Only visible rows are rendered.
 * Expansion state tracked in a Set<number> of expanded node indices.
 */
interface FlatRow {
    nodeIndex: number;
    depth: number;
    hasChildren: boolean;
}

export class HierarchyTreeView implements IViewerPlugin {
    readonly id = 'hierarchy-tree-view';

    private _ctx!: PluginContext;
    private _data: HierarchyData | null = null;
    private _root!: HTMLElement;

    // Virtual scroll
    private _scrollContainer!: HTMLElement;
    private _spacer!: HTMLElement;
    private _rowContainer!: HTMLElement;
    private _searchInput!: HTMLInputElement;

    // Flat list state
    private _expanded = new Set<number>();
    private _flatList: FlatRow[] = [];
    private _searchResults: FlatRow[] | null = null;
    private _selectedIndex = -1;

    // Rendered row pool
    private _visibleStart = 0;
    private _visibleEnd = 0;

    private _searchTimer: ReturnType<typeof setTimeout> | null = null;
    private _onSelectionChange: ((e: SelectionEvent) => void) | null = null;
    private _onSelectionClear: (() => void) | null = null;

    init(ctx: PluginContext): void {
        this._ctx = ctx;

        this._root = document.createElement('div');
        this._root.style.cssText = 'display:flex;flex-direction:column;height:100%;';

        // Search bar
        this._searchInput = document.createElement('input');
        this._searchInput.type = 'text';
        this._searchInput.placeholder = 'Search nodes...';
        this._searchInput.style.cssText = `
            width:100%;box-sizing:border-box;padding:6px 10px;
            background:#11111b;color:#cdd6f4;border:1px solid #313244;
            border-radius:0;outline:none;font-size:12px;
        `;
        this._searchInput.addEventListener('input', () => this._onSearchInput());
        this._root.appendChild(this._searchInput);

        // Scroll container
        this._scrollContainer = document.createElement('div');
        this._scrollContainer.style.cssText = 'flex:1;overflow-y:auto;position:relative;';
        this._scrollContainer.addEventListener('scroll', () => this._renderVisible());

        this._spacer = document.createElement('div');
        this._spacer.style.cssText = 'width:1px;pointer-events:none;';

        this._rowContainer = document.createElement('div');
        this._rowContainer.style.cssText = 'position:absolute;top:0;left:0;right:0;';

        this._scrollContainer.appendChild(this._spacer);
        this._scrollContainer.appendChild(this._rowContainer);
        this._root.appendChild(this._scrollContainer);

        ctx.panelManager.addPanel(this.id, 'Hierarchy', 'left', 320, this._root);

        // Listen for selection events from other sources
        this._onSelectionChange = (e: SelectionEvent) => {
            if (e.source === this.id) return; // Skip our own events
            this._selectNode(e.primaryBatchId, true);
        };
        this._onSelectionClear = () => {
            this._selectedIndex = -1;
            this._renderVisible();
        };
        ctx.eventBus.on('selection:change', this._onSelectionChange);
        ctx.eventBus.on('selection:clear', this._onSelectionClear);

        // Fetch data
        this._loadData();
    }

    activate(): void { /* Panel already visible */ }
    deactivate(): void { /* Could hide panel */ }

    dispose(): void {
        if (this._onSelectionChange) this._ctx.eventBus.off('selection:change', this._onSelectionChange);
        if (this._onSelectionClear) this._ctx.eventBus.off('selection:clear', this._onSelectionClear);
        if (this._searchTimer) clearTimeout(this._searchTimer);
        this._ctx.panelManager.removePanel(this.id);
    }

    private async _loadData(): Promise<void> {
        try {
            this._data = await this._ctx.dataServices.getHierarchyData();
            // Start with root expanded
            this._expanded.add(0);
            this._rebuildFlatList();
            this._renderVisible();
        } catch (e) {
            console.warn('HierarchyTreeView: failed to load hierarchy.bin', e);
            this._rowContainer.textContent = 'Failed to load hierarchy data.';
        }
    }

    /**
     * Rebuild the flat list from expanded state.
     * DFS walk using firstChildIdx / nextSiblingIdx pointers.
     */
    private _rebuildFlatList(): void {
        if (!this._data) return;
        const list: FlatRow[] = [];
        const data = this._data;

        // Stack-based DFS (avoid recursion for 1.1M nodes)
        const stack: number[] = [0]; // Start from root (index 0)

        while (stack.length > 0) {
            const idx = stack.pop()!;
            const node = getNode(data, idx);

            list.push({
                nodeIndex: idx,
                depth: node.depth,
                hasChildren: node.firstChildIdx >= 0,
            });

            // If expanded, push children in reverse order (so first child pops first)
            if (this._expanded.has(idx) && node.firstChildIdx >= 0) {
                // Collect children
                const children: number[] = [];
                let childIdx = node.firstChildIdx;
                while (childIdx >= 0 && childIdx < data.nodeCount) {
                    children.push(childIdx);
                    const child = getNode(data, childIdx);
                    childIdx = child.nextSiblingIdx;
                }
                // Push in reverse so first child is processed first
                for (let i = children.length - 1; i >= 0; i--) {
                    stack.push(children[i]);
                }
            }
        }

        this._flatList = list;
        const activeList = this._searchResults ?? this._flatList;
        this._spacer.style.height = (activeList.length * ROW_HEIGHT) + 'px';
    }

    private _getActiveList(): FlatRow[] {
        return this._searchResults ?? this._flatList;
    }

    /** Render only visible rows in the viewport */
    private _renderVisible(): void {
        if (!this._data) return;

        const list = this._getActiveList();
        const scrollTop = this._scrollContainer.scrollTop;
        const viewHeight = this._scrollContainer.clientHeight;

        const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
        const end = Math.min(list.length, Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + OVERSCAN);

        // Only re-render if range changed
        if (start === this._visibleStart && end === this._visibleEnd) return;
        this._visibleStart = start;
        this._visibleEnd = end;

        // Build rows
        const fragment = document.createDocumentFragment();
        for (let i = start; i < end; i++) {
            const row = list[i];
            fragment.appendChild(this._createRowElement(row, i));
        }

        this._rowContainer.innerHTML = '';
        this._rowContainer.appendChild(fragment);
    }

    private _createRowElement(row: FlatRow, flatIndex: number): HTMLElement {
        const data = this._data!;
        const el = document.createElement('div');
        const isSelected = row.nodeIndex === this._selectedIndex;

        el.style.cssText = `
            position:absolute;top:${flatIndex * ROW_HEIGHT}px;left:0;right:0;
            height:${ROW_HEIGHT}px;line-height:${ROW_HEIGHT}px;
            padding-left:${row.depth * INDENT_PX + 8}px;
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
            cursor:pointer;user-select:none;
            background:${isSelected ? '#313244' : 'transparent'};
            color:${isSelected ? '#89b4fa' : '#cdd6f4'};
            font-size:12px;
        `;

        // Expand/collapse arrow
        const arrow = document.createElement('span');
        arrow.style.cssText = 'display:inline-block;width:16px;text-align:center;font-size:10px;color:#6c7086;';
        if (row.hasChildren) {
            const isExpanded = this._expanded.has(row.nodeIndex);
            arrow.textContent = isExpanded ? '\u25BC' : '\u25B6'; // ▼ or ▶
            arrow.addEventListener('click', (e) => {
                e.stopPropagation();
                this._toggleExpand(row.nodeIndex);
            });
        }

        // Node name
        const name = getNodeName(data, row.nodeIndex);
        const node = getNode(data, row.nodeIndex);
        const typeName = getNodeTypeName(data, node.type);

        const label = document.createElement('span');
        label.textContent = name || `[${typeName} #${row.nodeIndex}]`;

        // Type badge
        const badge = document.createElement('span');
        badge.style.cssText = 'margin-left:6px;font-size:10px;color:#6c7086;';
        badge.textContent = typeName;

        el.appendChild(arrow);
        el.appendChild(label);
        el.appendChild(badge);

        // Row click → select
        el.addEventListener('click', () => this._onRowClick(row.nodeIndex));

        // Hover
        el.addEventListener('mouseenter', () => {
            if (!isSelected) el.style.background = '#1e1e2e';
        });
        el.addEventListener('mouseleave', () => {
            if (!isSelected) el.style.background = 'transparent';
        });

        return el;
    }

    private _toggleExpand(nodeIndex: number): void {
        if (this._expanded.has(nodeIndex)) {
            this._expanded.delete(nodeIndex);
        } else {
            this._expanded.add(nodeIndex);
        }
        this._rebuildFlatList();
        this._visibleStart = -1; // Force re-render
        this._renderVisible();
    }

    private _onRowClick(nodeIndex: number): void {
        this._selectedIndex = nodeIndex;

        // Highlight in 3D
        if (this._ctx.appearanceManager) {
            this._ctx.appearanceManager.setHighlight([nodeIndex]);
        }
        // Navigate camera
        if (this._ctx.navigationCore) {
            this._ctx.navigationCore.moveTo(nodeIndex);
        }

        // Emit selection event
        this._ctx.eventBus.emit('selection:change', {
            batchIds: [nodeIndex],
            source: this.id,
            primaryBatchId: nodeIndex,
        });

        this._visibleStart = -1; // Force re-render
        this._renderVisible();
    }

    /** Select a node from external event, expand ancestors, scroll into view */
    private _selectNode(nodeIndex: number, scrollTo: boolean): void {
        if (!this._data || nodeIndex < 0 || nodeIndex >= this._data.nodeCount) return;

        this._selectedIndex = nodeIndex;

        // Expand ancestors
        this._expandAncestors(nodeIndex);
        this._rebuildFlatList();

        if (scrollTo) {
            // Find flat index
            const list = this._getActiveList();
            const flatIdx = list.findIndex(r => r.nodeIndex === nodeIndex);
            if (flatIdx >= 0) {
                const targetTop = flatIdx * ROW_HEIGHT;
                const viewHeight = this._scrollContainer.clientHeight;
                const scrollTop = this._scrollContainer.scrollTop;

                // Scroll only if not visible
                if (targetTop < scrollTop || targetTop + ROW_HEIGHT > scrollTop + viewHeight) {
                    this._scrollContainer.scrollTop = targetTop - viewHeight / 2 + ROW_HEIGHT / 2;
                }
            }
        }

        this._visibleStart = -1;
        this._renderVisible();
    }

    private _expandAncestors(nodeIndex: number): void {
        if (!this._data) return;
        let idx = nodeIndex;
        while (idx >= 0) {
            const node = getNode(this._data, idx);
            const parentIdx = node.parentIdx;
            if (parentIdx < 0) break;
            this._expanded.add(parentIdx);
            idx = parentIdx;
        }
    }

    /* ---- Search ---- */

    private _onSearchInput(): void {
        if (this._searchTimer) clearTimeout(this._searchTimer);
        this._searchTimer = setTimeout(() => this._executeSearch(), SEARCH_DEBOUNCE_MS);
    }

    private _executeSearch(): void {
        const query = this._searchInput.value.trim().toLowerCase();
        if (!query || !this._data) {
            this._searchResults = null;
            this._spacer.style.height = (this._flatList.length * ROW_HEIGHT) + 'px';
            this._visibleStart = -1;
            this._renderVisible();
            return;
        }

        const data = this._data;
        const results: FlatRow[] = [];
        const maxResults = 500;

        for (let i = 0; i < data.nodeCount && results.length < maxResults; i++) {
            const name = getNodeName(data, i).toLowerCase();
            if (name.includes(query)) {
                results.push({
                    nodeIndex: i,
                    depth: 0, // Flat search results, no indentation
                    hasChildren: false,
                });
            }
        }

        this._searchResults = results;
        this._spacer.style.height = (results.length * ROW_HEIGHT) + 'px';
        this._scrollContainer.scrollTop = 0;
        this._visibleStart = -1;
        this._renderVisible();
    }
}
