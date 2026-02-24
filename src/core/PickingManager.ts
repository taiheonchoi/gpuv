import { WebGPUEngine } from '@babylonjs/core';

/**
 * Manages the GPU-Side ID picking render target system, drastically reducing 
 * CPU ray-cast checks by offloading selection buffers mapped directly to visual pixels.
 */
export class PickingManager {
    private _engine: WebGPUEngine;
    private _device: GPUDevice;

    private _pickingTexture!: GPUTexture;
    private _pickingTextureView!: GPUTextureView;
    private _readBuffer!: GPUBuffer;

    private _width: number;
    private _height: number;
    private _pickInProgress = false;
    private _resizeObserver: ReturnType<typeof this._engine.onResizeObservable.add> | null = null;

    constructor(engine: WebGPUEngine) {
        this._engine = engine;
        // Direct extraction of private WebGPU API endpoint.
        this._device = (this._engine as any)._device;

        this._width = this._engine.getRenderWidth() || 1024;
        this._height = this._engine.getRenderHeight() || 768;

        this._initializeTargets();

        // Auto-scale target buffers seamlessly during DOM resizes
        this._resizeObserver = this._engine.onResizeObservable.add(() => {
            this._width = this._engine.getRenderWidth();
            this._height = this._engine.getRenderHeight();
            this._initializeTargets();
        });
    }

    private _initializeTargets(): void {
        if (this._pickingTexture) {
            this._pickingTexture.destroy();
        }

        // Deploy an R32Uint specific attachment ensuring absolute data fidelity 
        // (BatchIDs up to 4.2 billion handles seamlessly uncompressed).
        this._pickingTexture = this._device.createTexture({
            size: [this._width, this._height, 1],
            format: 'r32uint',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
        });

        if (this._readBuffer) {
            this._readBuffer.destroy();
        }

        // Standard 256 byte padding rules to comply safely across generic WebGPU backend architectures.
        this._readBuffer = this._device.createBuffer({
            size: 256,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });

        // Cache the texture view — avoid creating a new GPUTextureView per frame
        this._pickingTextureView = this._pickingTexture.createView();

        console.log(`PickingManager Targets Initialized: ${this._width}x${this._height} R32Uint.`);
    }

    public get pickingTextureView(): GPUTextureView {
        return this._pickingTextureView;
    }

    public dispose(): void {
        if (this._resizeObserver) {
            this._engine.onResizeObservable.remove(this._resizeObserver);
            this._resizeObserver = null;
        }
        if (this._pickingTexture) {
            this._pickingTexture.destroy();
        }
        if (this._readBuffer) {
            this._readBuffer.destroy();
        }
    }

    /**
     * Maps the GPU R32Uint memory buffer back to CPU scope completely asynchronously.
     * Guaranteed to prevent thread blocking against the main rendering timeline.
     * 
     * @param x Canvas pointer dimension
     * @param y Canvas pointer dimension
     * @returns The resolved batchID numeric. Evaluates to 0 if skybox or miss.
     */
    public async pickAsync(x: number, y: number): Promise<number> {
        // OOB checking filter out
        if (x < 0 || x >= this._width || y < 0 || y >= this._height) {
            return 0;
        }

        // Prevent concurrent mapAsync — WebGPU rejects mapping an already-pending/mapped buffer
        if (this._pickInProgress) return 0;
        this._pickInProgress = true;

        try {
            const commandEncoder = this._device.createCommandEncoder();

            // Buffer limits extraction of exactly 1 hardware pixel (4 bytes) safely against aligned widths
            commandEncoder.copyTextureToBuffer(
                { texture: this._pickingTexture, origin: [x, y, 0] },
                { buffer: this._readBuffer, bytesPerRow: 256 },
                { width: 1, height: 1, depthOrArrayLayers: 1 }
            );

            this._device.queue.submit([commandEncoder.finish()]);

            // Trigger safe Read Map sequence bridging the hardware to standard DOM typed streams
            await this._readBuffer.mapAsync(GPUMapMode.READ);
            const mappedData = this._readBuffer.getMappedRange();

            // Output mapped standard 32-bit Uint index array pointing to offset 0 resolving pixel value
            const copyArray = new Uint32Array(mappedData);
            const batchId = copyArray[0];

            // Decapitalize lock preventing VRAM memory hoarding
            this._readBuffer.unmap();

            return batchId;
        } catch (e) {
            console.warn('PickingManager: pickAsync failed', e);
            return 0;
        } finally {
            this._pickInProgress = false;
        }
    }
}
