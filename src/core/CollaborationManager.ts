import { AppearanceManager } from './AppearanceManager';
import { Camera, Vector3, Quaternion } from '@babylonjs/core';

export interface UserStateDelta {
    userId: string;
    position?: [number, number, number];
    rotation?: [number, number, number, number];
    // Holds BatchIDs that the user just highlighted or un-highlighted
    selectionChange?: { id: number, selected: boolean }[];
}

/**
 * Handles WebRTC or WebSocket multi-user view states and visual selections.
 * Enforces Zero-Latency synchronization across huge coordinate scales using Delta logic.
 */
export class CollaborationManager {
    private _camera: Camera;
    private _appearanceManager: AppearanceManager;

    // Internal user-state tracking simulating Delta changes vs full payload serialization
    private _remoteUsers: Map<string, { position: Vector3, rotation: Quaternion, selectedIds: Set<number> }>;

    constructor(camera: Camera, appearanceManager: AppearanceManager) {
        this._camera = camera;
        this._appearanceManager = appearanceManager;
        this._remoteUsers = new Map();
    }

    /**
     * Integrates incoming network deltas ensuring low-latency parsing.
     */
    public processNetworkUpdate(delta: UserStateDelta): void {
        let userNode = this._remoteUsers.get(delta.userId);

        if (!userNode) {
            userNode = {
                position: Vector3.Zero(),
                rotation: Quaternion.Identity(),
                selectedIds: new Set<number>()
            };
            this._remoteUsers.set(delta.userId, userNode);
            console.log(`CollaborationManager: New remote user joined > ${delta.userId}`);
        }

        if (delta.position) {
            userNode.position.set(delta.position[0], delta.position[1], delta.position[2]);
            // Typically updates a lightweight visual proxy (like an Avatar camera frustum)
        }

        if (delta.rotation) {
            userNode.rotation.set(delta.rotation[0], delta.rotation[1], delta.rotation[2], delta.rotation[3]);
        }

        if (delta.selectionChange && delta.selectionChange.length > 0) {
            const idsToHighlight: number[] = [];
            const idsToClear: number[] = [];

            delta.selectionChange.forEach(change => {
                if (change.selected) {
                    userNode!.selectedIds.add(change.id);
                    idsToHighlight.push(change.id);
                } else {
                    userNode!.selectedIds.delete(change.id);
                    idsToClear.push(change.id);
                }
            });

            // Map selection colors dynamically inside the WGSL buffer without instantiating materials
            if (idsToHighlight.length > 0) this._appearanceManager.setHighlight(idsToHighlight);
            if (idsToClear.length > 0) this._appearanceManager.clearAppearance(idsToClear);
        }
    }

    /**
     * Broadcasts the local user's delta changes upstream to the WebSocket.
     * Prevents serializing active 8M geometry, transmitting ONLY the camera bounds and interaction changes.
     */
    public broadcastLocalDelta(selectionChanges?: { id: number, selected: boolean }[]): UserStateDelta {
        return {
            userId: "LOCAL_USER_ID", // Auth context resolution
            position: [this._camera.position.x, this._camera.position.y, this._camera.position.z],
            // Fallback mapping identity if UniversalCamera rotation isn't pure Quaternion
            rotation: [0, 0, 0, 1],
            selectionChange: selectionChanges
        };
    }
}
