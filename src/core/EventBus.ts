import { EventMap } from './PluginTypes';

type Handler<T> = (data: T) => void;

/**
 * Typed synchronous pub/sub bus.
 * Synchronous dispatch ensures instant pick -> highlight feedback.
 */
export class EventBus {
    private _listeners = new Map<string, Set<Handler<any>>>();

    on<K extends keyof EventMap>(event: K, handler: Handler<EventMap[K]>): void {
        let set = this._listeners.get(event as string);
        if (!set) {
            set = new Set();
            this._listeners.set(event as string, set);
        }
        set.add(handler);
    }

    once<K extends keyof EventMap>(event: K, handler: Handler<EventMap[K]>): void {
        const wrapper: Handler<EventMap[K]> = (data) => {
            this.off(event, wrapper);
            handler(data);
        };
        this.on(event, wrapper);
    }

    off<K extends keyof EventMap>(event: K, handler: Handler<EventMap[K]>): void {
        const set = this._listeners.get(event as string);
        if (set) set.delete(handler);
    }

    emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
        const set = this._listeners.get(event as string);
        if (!set) return;
        for (const handler of set) {
            handler(data);
        }
    }

    dispose(): void {
        this._listeners.clear();
    }
}
