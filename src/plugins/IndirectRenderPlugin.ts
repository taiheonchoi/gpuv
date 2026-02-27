import { Scene, WebGPUEngine, Observer } from '@babylonjs/core';
import { GlobalBufferManager } from '../core/GlobalBufferManager';
import { PickingManager } from '../core/PickingManager';
import { ComputeCullingManager } from '../core/ComputeCullingManager';
import indirectWgsl from '../shaders/indirect.wgsl?raw';



/**
 * Hooks into Babylon.js render lifecycle to inject a raw WebGPU indirect draw pass,
 * bypassing Babylon's CPU-side culling.
 *
 * Geometry Atlas mode:
 * - Uses shared vertex/index atlas buffers from GlobalBufferManager
 * - Issues one drawIndexedIndirect per unique mesh (multi-draw loop)
 * - Instance remapping via GlobalBufferManager.visibleIndicesBuffer
 *   supports cross-chunk mesh deduplication
 */
export class IndirectRenderPlugin {
    private _scene: Scene;
    private _engine: WebGPUEngine;
    private _pickingManager: PickingManager;
    private _bufferManager: GlobalBufferManager;
    private _renderObserver: Observer<Scene> | null = null;

    // GPU resources
    private _device!: GPUDevice;
    private _pipeline!: GPURenderPipeline;
    private _bindGroupLayout!: GPUBindGroupLayout;
    private _bindGroup!: GPUBindGroup;
    private _uniformBuffer!: GPUBuffer;
    private _uniformData = new Float32Array(24); // padded to 96 bytes
    private _depthTexture!: GPUTexture;
    private _depthTextureView!: GPUTextureView;
    private _depthW = 0;
    private _depthH = 0;
    private _pipelineLayout!: GPUPipelineLayout;
    private _shaderModule!: GPUShaderModule;
    private _currentSampleCount = 0;
    private _initialized = false;
    private _startTime = performance.now();
    private _frameCount = 0;
    private _needsBindGroupRebuild = false;

    private _cullingManager: ComputeCullingManager | null = null;

    public highlightedBatchId: number = 0;

    constructor(scene: Scene, engine: WebGPUEngine, pickingManager: PickingManager) {
        this._scene = scene;
        this._engine = engine;
        this._pickingManager = pickingManager;
        this._bufferManager = GlobalBufferManager.getInstance();
    }

    public async initialize(): Promise<void> {
        this._device = (this._engine as any)._device as GPUDevice;
        if (!this._device) {
            console.error('IndirectRenderPlugin: No GPUDevice available');
            return;
        }

        console.log('IndirectRenderPlugin: Compiling shader and creating pipeline...');

        const shaderModule = this._device.createShaderModule({
            label: 'indirect.wgsl',
            code: indirectWgsl,
        });

        this._bindGroupLayout = this._device.createBindGroupLayout({
            label: 'indirect-bind-group-layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
            ],
        });

        this._pipelineLayout = this._device.createPipelineLayout({
            label: 'indirect-pipeline-layout',
            bindGroupLayouts: [this._bindGroupLayout],
        });

        this._uniformBuffer = this._device.createBuffer({
            label: 'indirect-uniforms',
            size: 96,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this._shaderModule = shaderModule;

        // Bind group uses GlobalBufferManager's visibleIndicesBuffer (remap buffer)
        this._rebuildBindGroup();

        // Hook into engine's onEndFrameObservable — fires AFTER Babylon finishes
        // its render pass AND submits the command buffer. This means Babylon's
        // resolved MSAA output is already on the swap chain, and we can render
        // on top with our own independent encoder + submit.
        const engineAny = this._engine as any;
        if (engineAny.onEndFrameObservable) {
            this._renderObserver = engineAny.onEndFrameObservable.add(() => {
                this._executeIndirectPass();
            });
            console.log('IndirectRenderPlugin: Hooked into engine.onEndFrameObservable');
        } else {
            // Fallback: use scene.onAfterRenderObservable
            this._renderObserver = this._scene.onAfterRenderObservable.add(() => {
                this._executeIndirectPass();
            });
            console.log('IndirectRenderPlugin: Hooked into scene.onAfterRenderObservable (fallback)');
        }

        // Initialize compute culling
        this._cullingManager = new ComputeCullingManager(this._engine);
        this._cullingManager.initialize();

        this._initialized = true;
        console.log('IndirectRenderPlugin: Pipeline ready (Geometry Atlas + cross-chunk dedup + GPU frustum culling).');
    }

    /** Call after GlobalBufferManager.finalizeDrawCommands() to wire culling bind group */
    public rebuildCullingBindGroup(): void {
        if (this._cullingManager) {
            this._cullingManager.rebuildBindGroup();
        }
    }

    /** Rebuild render bind group after data finalization (TRS/batchId/remap buffers populated) */
    public rebuildRenderBindGroup(): void {
        if (!this._device || !this._bindGroupLayout) return;
        this._rebuildBindGroup();
        this._needsBindGroupRebuild = false;
        console.log('IndirectRenderPlugin: Render bind group rebuilt after data finalization');
    }

    private _createPipeline(sampleCount: number): void {
        if (sampleCount === this._currentSampleCount && this._pipeline) return;
        this._currentSampleCount = sampleCount;

        // Babylon.js WebGPU uses reversed-Z depth by default.
        // Detect via engine property; fallback to checking scene's depth function.
        const useReversedZ = !!(this._engine as any).useReverseDepthBuffer;
        const depthCompare: GPUCompareFunction = useReversedZ ? 'greater' : 'less';

        const colorFormat = navigator.gpu!.getPreferredCanvasFormat();
        this._pipeline = this._device.createRenderPipeline({
            label: 'indirect-render-pipeline',
            layout: this._pipelineLayout,
            vertex: {
                module: this._shaderModule,
                entryPoint: 'vs_main',
                buffers: [{
                    arrayStride: 24,
                    stepMode: 'vertex',
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x3' },
                        { shaderLocation: 1, offset: 12, format: 'float32x3' },
                    ],
                }],
            },
            fragment: {
                module: this._shaderModule,
                entryPoint: 'fs_main',
                targets: [{ format: colorFormat }],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',
            },
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: true,
                depthCompare,
            },
            multisample: {
                count: sampleCount,
            },
        });
        console.log(`IndirectRenderPlugin: Pipeline created (sampleCount=${sampleCount}, depthCompare=${depthCompare}, reversedZ=${useReversedZ})`);
    }

    private _rebuildBindGroup(): void {
        const trsGpuBuffer = (this._bufferManager.instanceTRSBuffer.getBuffer() as any).underlyingResource as GPUBuffer;
        const batchIdGpuBuffer = (this._bufferManager.batchIdBuffer.getBuffer() as any).underlyingResource as GPUBuffer;

        this._bindGroup = this._device.createBindGroup({
            label: 'indirect-bind-group',
            layout: this._bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this._uniformBuffer } },
                { binding: 1, resource: { buffer: trsGpuBuffer } },
                { binding: 2, resource: { buffer: batchIdGpuBuffer } },
                { binding: 3, resource: { buffer: this._bufferManager.visibleIndicesBuffer } },
            ],
        });
    }

    /**
     * Core per-frame render pass using an INDEPENDENT command encoder,
     * submitted AFTER Babylon finishes its frame (via engine.onEndFrameObservable).
     *
     * Gets the swap chain texture from the canvas GPU context and renders
     * with loadOp='load' to preserve Babylon's output underneath.
     */
    private _executeIndirectPass(): void {
        if (!this._initialized) return;
        if (!this._bufferManager.isFinalized) return;
        if (this._bufferManager.instanceCount === 0) return;
        if (this._bufferManager.drawCommandCount === 0) return;

        // Deferred bind group rebuild: ensures we reference the correct GPU buffers
        // after data has been uploaded (StorageBuffer may recreate underlyingResource)
        if (this._needsBindGroupRebuild) {
            this._rebuildBindGroup();
            this._needsBindGroupRebuild = false;
            console.log('[IndirectRender] Bind group rebuilt (deferred)');
        }

        this._updateUniforms();

        // Get the swap chain texture directly from the canvas GPU context
        const canvas = this._engine.getRenderingCanvas();
        if (!canvas) return;

        const gpuContext = (canvas as any).getContext('webgpu') as GPUCanvasContext;
        if (!gpuContext) {
            if (this._frameCount++ % 300 === 0) {
                console.warn('[IndirectRender] BAIL: no GPUCanvasContext');
            }
            return;
        }

        const currentTexture = gpuContext.getCurrentTexture();
        if (!currentTexture) {
            if (this._frameCount++ % 300 === 0) {
                console.warn('[IndirectRender] BAIL: no currentTexture');
            }
            return;
        }

        const targetView = currentTexture.createView();
        const sampleCount = 1;

        // Depth clear: reversed-Z → clear to 0.0, normal → clear to 1.0
        const useReversedZ = !!(this._engine as any).useReverseDepthBuffer;
        const depthClearValue = useReversedZ ? 0.0 : 1.0;

        try {
            this._createPipeline(sampleCount);

            const w = currentTexture.width;
            const h = currentTexture.height;
            if (w !== this._depthW || h !== this._depthH) {
                if (this._depthTexture) this._depthTexture.destroy();
                this._depthW = w;
                this._depthH = h;
                this._depthTexture = this._device.createTexture({
                    label: 'indirect-depth',
                    size: [w, h],
                    format: 'depth24plus',
                    sampleCount: 1,
                    usage: GPUTextureUsage.RENDER_ATTACHMENT,
                });
                this._depthTextureView = this._depthTexture.createView();
            }

            // Create our OWN command encoder
            const commandEncoder = this._device.createCommandEncoder({
                label: 'indirect-render-encoder',
            });

            // GPU frustum culling: temporarily disabled for Atlas First debugging
            // TODO: re-enable after verifying geometry renders correctly
            // if (this._cullingManager?.isReady && this._scene.activeCamera) {
            //     this._cullingManager.dispatchCulling(commandEncoder, this._scene.activeCamera);
            // }

            const renderPass = commandEncoder.beginRenderPass({
                label: 'indirect-render-pass',
                colorAttachments: [{
                    view: targetView,
                    loadOp: 'load' as GPULoadOp,
                    storeOp: 'store' as GPUStoreOp,
                }],
                depthStencilAttachment: {
                    view: this._depthTextureView,
                    depthLoadOp: 'clear' as GPULoadOp,
                    depthClearValue,
                    depthStoreOp: 'store' as GPUStoreOp,
                },
            });

            renderPass.setPipeline(this._pipeline);
            renderPass.setBindGroup(0, this._bindGroup);
            renderPass.setVertexBuffer(0, this._bufferManager.vertexAtlasBuffer);
            renderPass.setIndexBuffer(this._bufferManager.indexAtlasBuffer, 'uint32');

            // Multi-draw loop: one drawIndexedIndirect per unique mesh.
            // WebGPU instance_index = firstInstance + i, so the indirect buffer's
            // firstInstance field already offsets into the remap buffer — no per-draw
            // uniform write needed.
            const cmdCount = this._bufferManager.drawCommandCount;
            for (let i = 0; i < cmdCount; i++) {
                renderPass.drawIndexedIndirect(this._bufferManager.indirectDrawGpuBuffer, i * 20);
            }

            renderPass.end();

            // Submit our independent command buffer
            this._device.queue.submit([commandEncoder.finish()]);

            this._frameCount++;
            if (this._frameCount === 1) {
                this._logFirstFrameDiagnostics(cmdCount, w, h, useReversedZ);
            }
        } catch (e: any) {
            if (this._frameCount++ % 300 === 0) {
                console.error('IndirectRenderPlugin render error:', e.message);
            }
        }
    }

    /** First-frame diagnostics: summary of render state */
    private _logFirstFrameDiagnostics(cmdCount: number, w: number, h: number, reversedZ: boolean): void {
        console.log(`[IndirectRender] First frame: ${cmdCount} draw cmds, ${this._bufferManager.instanceCount} instances, ${w}x${h}, reversedZ=${reversedZ}`);
    }

    private _updateUniforms(): void {
        const camera = this._scene.activeCamera;
        if (!camera) return;

        const vp = camera.getTransformationMatrix();
        const src = vp.toArray();
        for (let i = 0; i < 16; i++) this._uniformData[i] = src[i];

        const camPos = camera.position;
        this._uniformData[16] = camPos.x;
        this._uniformData[17] = camPos.y;
        this._uniformData[18] = camPos.z;

        const u32View = new Uint32Array(this._uniformData.buffer, 19 * 4, 1);
        u32View[0] = this.highlightedBatchId;

        this._uniformData[20] = (performance.now() - this._startTime) / 1000.0;

        this._device.queue.writeBuffer(this._uniformBuffer, 0, this._uniformData.buffer, 0, 96);
    }

    /**
     * Seed test instances for pipeline verification.
     */
    public seedTestInstances(count: number = 100): void {
        const trs = new Float32Array(count * 16);
        const batchIds = new Uint32Array(count);
        const gridSize = Math.ceil(Math.cbrt(count));
        const spacing = 2.0;

        for (let i = 0; i < count; i++) {
            const x = (i % gridSize) * spacing - (gridSize * spacing) / 2;
            const y = (Math.floor(i / gridSize) % gridSize) * spacing;
            const z = Math.floor(i / (gridSize * gridSize)) * spacing - (gridSize * spacing) / 2;

            const base = i * 16;
            trs[base + 0] = 1; trs[base + 5] = 1; trs[base + 10] = 1;
            trs[base + 12] = x;
            trs[base + 13] = y;
            trs[base + 14] = z;
            trs[base + 15] = 1;

            batchIds[i] = i + 1;
        }

        // Create a test box mesh in the atlas
        this._seedBoxGeometry();

        const firstTrs = this._bufferManager.appendInstanceData(trs, batchIds);
        this._bufferManager.addDrawCommandInstances(0, count, firstTrs);
        this._bufferManager.finalizeDrawCommands();
        console.log(`IndirectRenderPlugin: Seeded ${count} test instances (finalizeDrawCommands called)`);
    }

    private _seedBoxGeometry(): void {
        const v: number[] = [];
        const idx: number[] = [];
        const faces: [number[], number[], number[], number[], number[]][] = [
            [[-0.5,-0.5,0.5],[0.5,-0.5,0.5],[0.5,0.5,0.5],[-0.5,0.5,0.5],[0,0,1]],
            [[0.5,-0.5,-0.5],[-0.5,-0.5,-0.5],[-0.5,0.5,-0.5],[0.5,0.5,-0.5],[0,0,-1]],
            [[-0.5,0.5,0.5],[0.5,0.5,0.5],[0.5,0.5,-0.5],[-0.5,0.5,-0.5],[0,1,0]],
            [[-0.5,-0.5,-0.5],[0.5,-0.5,-0.5],[0.5,-0.5,0.5],[-0.5,-0.5,0.5],[0,-1,0]],
            [[0.5,-0.5,0.5],[0.5,-0.5,-0.5],[0.5,0.5,-0.5],[0.5,0.5,0.5],[1,0,0]],
            [[-0.5,-0.5,-0.5],[-0.5,-0.5,0.5],[-0.5,0.5,0.5],[-0.5,0.5,-0.5],[-1,0,0]],
        ];
        for (const face of faces) {
            const base = v.length / 6;
            const n = face[4];
            for (let i = 0; i < 4; i++) {
                const p = face[i];
                v.push(p[0], p[1], p[2], n[0], n[1], n[2]);
            }
            idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
        this._bufferManager.appendMeshGeometry(new Float32Array(v), new Uint32Array(idx));
    }

    public async clickPickAsync(x: number, y: number): Promise<number> {
        const id = await this._pickingManager.pickAsync(x, y);
        if (id > 0) {
            this.highlightedBatchId = id;
        }
        return id;
    }

    public dispose(): void {
        if (this._renderObserver) {
            const engAny = this._engine as any;
            if (engAny.onEndFrameObservable) {
                engAny.onEndFrameObservable.remove(this._renderObserver);
            } else {
                this._scene.onAfterRenderObservable.remove(this._renderObserver);
            }
            this._renderObserver = null;
        }
        this._cullingManager?.dispose();
        this._cullingManager = null;
        this._pipeline = null as any;
        this._currentSampleCount = 0;
        this._uniformBuffer?.destroy();
        this._depthTexture?.destroy();
    }
}
