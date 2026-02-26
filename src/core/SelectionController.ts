import { EventBus } from './EventBus';
import { PickingManager } from './PickingManager';

/**
 * Wires canvas click → PickingManager.pickAsync → EventBus selection events.
 */
export class SelectionController {
    private _canvas: HTMLCanvasElement;
    private _eventBus: EventBus;
    private _pickingManager: PickingManager;
    private _onPointerDown: ((e: PointerEvent) => void) | null = null;

    constructor(canvas: HTMLCanvasElement, eventBus: EventBus, pickingManager: PickingManager) {
        this._canvas = canvas;
        this._eventBus = eventBus;
        this._pickingManager = pickingManager;
        this._bind();
    }

    private _bind(): void {
        this._onPointerDown = async (e: PointerEvent) => {
            // Only primary button, ignore drag
            if (e.button !== 0) return;

            const rect = this._canvas.getBoundingClientRect();
            const x = Math.round((e.clientX - rect.left) * (this._canvas.width / rect.width));
            const y = Math.round((e.clientY - rect.top) * (this._canvas.height / rect.height));

            const batchId = await this._pickingManager.pickAsync(x, y);

            if (batchId === 0) {
                this._eventBus.emit('selection:clear', undefined as any);
                return;
            }

            this._eventBus.emit('pick', { batchId, x, y });
            this._eventBus.emit('selection:change', {
                batchIds: [batchId],
                source: 'picking',
                primaryBatchId: batchId,
            });
        };
        this._canvas.addEventListener('pointerdown', this._onPointerDown);
    }

    dispose(): void {
        if (this._onPointerDown) {
            this._canvas.removeEventListener('pointerdown', this._onPointerDown);
            this._onPointerDown = null;
        }
    }
}
