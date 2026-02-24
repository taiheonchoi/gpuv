import { ClashDetectionManager } from './ClashDetectionManager';
import { AppearanceManager } from './AppearanceManager';
import { NavigationCore } from './NavigationCore';
import { SensorLinkManager } from './SensorLinkManager';

export interface ScanReport {
    timestamp: number;
    scannedSectors: number;
    faultyNodes: number[];
    breachedClashInstances: number[];
    diagnostics: string;
}

/**
 * Autonomous Self-Diagnostic Agent.
 * Sweeps through the 8M+ object database during engine idle-time
 * verifying spatial clearances and sensor telemetry health metrics automatically.
 */
export class AutonomousAgent {
    private _clashManager: ClashDetectionManager;
    private _appearanceManager: AppearanceManager;
    private _navigationCore: NavigationCore;
    private _sensorManager: SensorLinkManager;

    private _isScanning: boolean = false;
    private _idleTimer: any = null;
    private _logHistory: ScanReport[] = [];
    private _disposed: boolean = false;

    // Trigger proactive scans after 10 seconds of user inactivity
    private readonly IDLE_THRESHOLD_MS = 10000;

    constructor(
        clashManager: ClashDetectionManager,
        appearanceManager: AppearanceManager,
        navigationCore: NavigationCore,
        sensorManager: SensorLinkManager
    ) {
        this._clashManager = clashManager;
        this._appearanceManager = appearanceManager;
        this._navigationCore = navigationCore;
        this._sensorManager = sensorManager;

        this._setupIdleTracking();
    }

    private _setupIdleTracking(): void {
        this.pingUserActivity();
    }

    /**
     * Resets the idle timer when user interacts with the canvas or UI.
     */
    public pingUserActivity(): void {
        if (this._disposed) return;
        if (this._idleTimer) clearTimeout(this._idleTimer);
        this._isScanning = false;

        this._idleTimer = setTimeout(() => {
            if (!this._isScanning && !this._disposed) {
                this.executeDiagnosticSweep();
            }
        }, this.IDLE_THRESHOLD_MS);
    }

    /**
     * Executes an automated background sweep validating physical clashes and sensor states.
     * Generates an actionable MCP context report and acts proactively on critical threats.
     */
    public async executeDiagnosticSweep(): Promise<void> {
        if (this._disposed) return;
        this._isScanning = true;
        console.log("AutonomousAgent: Initiating deep diagnostic sweep across 8M structure...");

        // 1. Evaluate Math Clash Registry natively pulled from GPU Memory
        const clashBreaches = await this._clashManager.analyzeInterferenceAsync();

        // Check cancellation after async operation
        if (this._disposed) {
            this._isScanning = false;
            return;
        }

        // 2. Evaluate Telemetry Disconnects (Health state > 1.5 corresponds to Disconnected)
        const faultyNodes: number[] = [];
        const stateBuffer = this._sensorManager.getSensorStateBufferData();
        for (let i = 0; i < stateBuffer.length; i++) {
            if (stateBuffer[i] >= 2.0 && stateBuffer[i] < 3.0) {
                faultyNodes.push(i);
            }
        }

        // 3. Proactive Auto-Intervention if critical hazards exist
        if (clashBreaches.length > 0) {
            console.warn(`AutonomousAgent: Critical Interference Detected. Auto-Navigating to Node ${clashBreaches[0]}`);

            // Force Red Emissive bounding visualization
            this._appearanceManager.setGhostMode(clashBreaches);

            // Immediately fly the user camera to supervise the dangerous coordination
            this._navigationCore.moveTo(clashBreaches[0], false);
        } else if (faultyNodes.length > 0) {
            console.log(`AutonomousAgent: ${faultyNodes.length} IoT disconnects observed. Flagging visual warnings.`);
            this._appearanceManager.setGhostMode(faultyNodes);
        }

        // 4. Record deterministic logs ensuring AI's logic chain is verifiable
        const report: ScanReport = {
            timestamp: Date.now(),
            scannedSectors: 100, // Concept mapping
            faultyNodes: faultyNodes,
            breachedClashInstances: clashBreaches,
            diagnostics: clashBreaches.length > 0 ? "CRITICAL_CLASH" : (faultyNodes.length > 0 ? "SENSOR_WARN" : "SECURE")
        };

        this._logHistory.push(report);
        // Cap log history to prevent unbounded memory growth in long-running sessions
        if (this._logHistory.length > 100) {
            this._logHistory.shift();
        }
        this._isScanning = false;
    }

    public getDiagnosticHistory(): ScanReport[] {
        return this._logHistory;
    }

    /**
     * Stops all pending/active sweeps and clears the idle timer.
     */
    public dispose(): void {
        this._disposed = true;
        this._isScanning = false;
        if (this._idleTimer) {
            clearTimeout(this._idleTimer);
            this._idleTimer = null;
        }
    }
}
