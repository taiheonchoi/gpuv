import { Scene, WebGPUEngine, Observer } from '@babylonjs/core';
import { GlobalBufferManager } from '../core/GlobalBufferManager';
import { PickingManager } from '../core/PickingManager';
import indirectWgsl from '../shaders/indirect.wgsl?raw';

/**
 * Hooks into Babylon.js render lifecycle to inject a raw WebGPU indirect draw pass,
 * bypassing Babylon's CPU-side culling. Renders all instances in GlobalBufferManager
 * using drawIndexedIndirect with the compiled indirect.wgsl shader.
 *
 * Uses Babylon's internal _renderEncoder so our pass is part of the same command batch,
 * avoiding double-submission conflicts with the swap chain texture.
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
    private _visibleIndicesBuffer!: GPUBuffer;
    private _vertexBuffer!: GPUBuffer;
    private _indexBuffer!: GPUBuffer;
    private _indexCount = 0;
    private _depthTexture!: GPUTexture;
    private _depthTextureView!: GPUTextureView;
    private _depthW = 0;
    private _depthH = 0;
    private _initialized = false;
    private _startTime = performance.now();

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

        // 1. Compile WGSL shader
        const shaderModule = this._device.createShaderModule({
            label: 'indirect.wgsl',
            code: indirectWgsl,
        });

        // 2. Create bind group layout matching WGSL @group(0) @binding(0..3)
        this._bindGroupLayout = this._device.createBindGroupLayout({
            label: 'indirect-bind-group-layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
            ],
        });

        const pipelineLayout = this._device.createPipelineLayout({
            label: 'indirect-pipeline-layout',
            bindGroupLayouts: [this._bindGroupLayout],
        });

        // 3. Create uniform buffer
        // Uniforms struct: mat4x4<f32>(64) + vec3<f32>(12) + u32(4) + f32(4) = 84 bytes → pad to 96
        this._uniformBuffer = this._device.createBuffer({
            label: 'indirect-uniforms',
            size: 96,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // 4. Create identity visible-indices buffer (no culling — all instances visible)
        this._createVisibleIndicesBuffer();

        // 5. Create procedural box mesh
        this._createBoxMesh();

        // 6. Create depth texture
        this._createDepthTexture();

        // 7. Determine color format
        const colorFormat = navigator.gpu!.getPreferredCanvasFormat();

        // 8. Create render pipeline
        this._pipeline = this._device.createRenderPipeline({
            label: 'indirect-render-pipeline',
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
                buffers: [{
                    arrayStride: 24, // position(vec3) + normal(vec3)
                    stepMode: 'vertex',
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x3' },
                        { shaderLocation: 1, offset: 12, format: 'float32x3' },
                    ],
                }],
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [
                    { format: colorFormat },
                    { format: 'r32uint' },
                ],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'back',
                frontFace: 'ccw',
            },
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: true,
                depthCompare: 'less',
            },
        });

        // 9. Create bind group
        this._rebuildBindGroup();

        // 10. Hook into render loop — use onBeforeRenderObservable so we inject our
        // pass BEFORE Babylon's scene.render() main pass. We'll end Babylon's current
        // render pass if one exists, inject ours, then let Babylon re-create its own.
        this._renderObserver = this._scene.onAfterRenderObservable.add(() => {
            this._executeIndirectPass();
        });

        this._initialized = true;
        console.log('IndirectRenderPlugin: Pipeline ready. Rendering active.');
    }

    private _createVisibleIndicesBuffer(): void {
        const capacity = 1000000; // Match GlobalBufferManager
        const indices = new Uint32Array(capacity);
        for (let i = 0; i < capacity; i++) indices[i] = i;

        this._visibleIndicesBuffer = this._device.createBuffer({
            label: 'visible-indices-identity',
            size: indices.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this._device.queue.writeBuffer(this._visibleIndicesBuffer, 0, indices);
    }

    private _createBoxMesh(): void {
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

        const vertexData = new Float32Array(v);
        const indexData = new Uint32Array(idx);
        this._indexCount = indexData.length;

        this._vertexBuffer = this._device.createBuffer({
            label: 'box-vertices',
            size: vertexData.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this._device.queue.writeBuffer(this._vertexBuffer, 0, vertexData);

        this._indexBuffer = this._device.createBuffer({
            label: 'box-indices',
            size: indexData.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        this._device.queue.writeBuffer(this._indexBuffer, 0, indexData);

        // Set indexCount in indirect draw args (slot 0)
        const indirectData = this._bufferManager.indirectDrawData;
        indirectData[0] = this._indexCount;
        this._bufferManager.indirectDrawBuffer.update(indirectData);
        this._bufferManager.syncIndirectDrawNative();
    }

    private _createDepthTexture(): void {
        const w = this._engine.getRenderWidth() || 1024;
        const h = this._engine.getRenderHeight() || 768;
        this._depthW = w;
        this._depthH = h;

        this._depthTexture = this._device.createTexture({
            label: 'indirect-depth',
            size: [w, h],
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this._depthTextureView = this._depthTexture.createView();
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
                { binding: 3, resource: { buffer: this._visibleIndicesBuffer } },
            ],
        });
    }

    /**
     * Core per-frame render pass. Injects into Babylon's render encoder to avoid
     * double-submission of the swap chain texture.
     */
    private _executeIndirectPass(): void {
        if (!this._initialized) return;
        if (this._bufferManager.instanceCount === 0) return;

        // Update uniform buffer
        this._updateUniforms();

        // End Babylon's current render pass so we can begin our own on the same encoder
        const eng = this._engine as any;

        // Babylon internally tracks _currentRenderPass. End it so we can add ours.
        if (eng._currentRenderPass) {
            eng._endCurrentRenderPass();
        }

        // Get the render encoder that Babylon will submit in flushFramebuffer()
        const renderEncoder = eng._renderEncoder as GPUCommandEncoder;
        if (!renderEncoder) return;

        // Get swap chain texture view
        const context = eng._context as GPUCanvasContext;
        if (!context) return;
        const swapChainTexture = context.getCurrentTexture();
        const colorView = swapChainTexture.createView();

        // Resize depth texture if needed
        const w = swapChainTexture.width;
        const h = swapChainTexture.height;
        if (w !== this._depthW || h !== this._depthH) {
            this._depthTexture.destroy();
            this._depthW = w;
            this._depthH = h;
            this._depthTexture = this._device.createTexture({
                label: 'indirect-depth',
                size: [w, h],
                format: 'depth24plus',
                usage: GPUTextureUsage.RENDER_ATTACHMENT,
            });
            this._depthTextureView = this._depthTexture.createView();
        }

        // Begin our custom render pass on Babylon's encoder
        const renderPass = renderEncoder.beginRenderPass({
            label: 'indirect-render-pass',
            colorAttachments: [
                {
                    view: colorView,
                    loadOp: 'load' as GPULoadOp,   // Preserve Babylon's scene background
                    storeOp: 'store' as GPUStoreOp,
                },
                {
                    view: this._pickingManager.pickingTextureView,
                    loadOp: 'clear' as GPULoadOp,
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                    storeOp: 'store' as GPUStoreOp,
                },
            ],
            depthStencilAttachment: {
                view: this._depthTextureView,
                depthLoadOp: 'clear' as GPULoadOp,
                depthClearValue: 1.0,
                depthStoreOp: 'store' as GPUStoreOp,
            },
        });

        renderPass.setPipeline(this._pipeline);
        renderPass.setBindGroup(0, this._bindGroup);
        renderPass.setVertexBuffer(0, this._vertexBuffer);
        renderPass.setIndexBuffer(this._indexBuffer, 'uint32');

        // Draw using native indirect buffer (has INDIRECT usage flag)
        renderPass.drawIndexedIndirect(this._bufferManager.indirectDrawGpuBuffer, 0);

        renderPass.end();
    }

    private _updateUniforms(): void {
        const camera = this._scene.activeCamera;
        if (!camera) return;

        // viewProjection = view * projection
        // Babylon row-major storage maps directly to WGSL column-major read
        const vp = camera.getViewMatrix().multiply(camera.getProjectionMatrix());
        const vpArr = vp.toArray();
        for (let i = 0; i < 16; i++) this._uniformData[i] = vpArr[i];

        // camera position (offset 64 bytes = float index 16)
        const camPos = camera.position;
        this._uniformData[16] = camPos.x;
        this._uniformData[17] = camPos.y;
        this._uniformData[18] = camPos.z;

        // highlightedBatchId (u32, at byte offset 76 = float index 19)
        const u32View = new Uint32Array(this._uniformData.buffer, 19 * 4, 1);
        u32View[0] = this.highlightedBatchId;

        // time (at byte offset 80 = float index 20)
        this._uniformData[20] = (performance.now() - this._startTime) / 1000.0;

        // Write full 96 bytes (struct size with padding)
        this._device.queue.writeBuffer(this._uniformBuffer, 0, this._uniformData.buffer, 0, 96);
    }

    /**
     * Seed test instances into GlobalBufferManager for pipeline verification.
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

            batchIds[i] = i + 1; // batchId 0 = miss
        }

        this._bufferManager.appendInstanceData(trs, batchIds);
        console.log(`IndirectRenderPlugin: Seeded ${count} test instances`);
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
            this._scene.onAfterRenderObservable.remove(this._renderObserver);
            this._renderObserver = null;
        }
        this._uniformBuffer?.destroy();
        this._visibleIndicesBuffer?.destroy();
        this._vertexBuffer?.destroy();
        this._indexBuffer?.destroy();
        this._depthTexture?.destroy();
    }
}
