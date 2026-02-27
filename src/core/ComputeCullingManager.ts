import { WebGPUEngine, Camera } from '@babylonjs/core';
import { GlobalBufferManager } from './GlobalBufferManager';
import cullingWgsl from '../shaders/culling.wgsl?raw';

/**
 * GPU frustum culling via two compute passes per frame:
 *   1. resetCounts  — zero all indirect draw commands' instanceCount
 *   2. cullInstances — test each instance against 6 frustum planes,
 *      atomically write survivors into the per-command remap regions
 *
 * Runs on the same GPUCommandEncoder as the render pass, ensuring
 * implicit barriers between compute → render.
 */
export class ComputeCullingManager {
    private _device: GPUDevice;
    private _bufferManager: GlobalBufferManager;

    private _resetPipeline!: GPUComputePipeline;
    private _cullPipeline!: GPUComputePipeline;
    private _bindGroupLayout!: GPUBindGroupLayout;
    private _bindGroup: GPUBindGroup | null = null;
    private _uniformBuffer!: GPUBuffer;
    // 112 bytes: 6 planes × 16B + 4 u32
    private _uniformData = new Float32Array(28);

    private _initialized = false;

    constructor(engine: WebGPUEngine) {
        this._device = (engine as any)._device as GPUDevice;
        this._bufferManager = GlobalBufferManager.getInstance();
    }

    public initialize(): void {
        const shaderModule = this._device.createShaderModule({
            label: 'culling-compute',
            code: cullingWgsl,
        });

        this._bindGroupLayout = this._device.createBindGroupLayout({
            label: 'culling-bgl',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            ],
        });

        const pipelineLayout = this._device.createPipelineLayout({
            label: 'culling-pl',
            bindGroupLayouts: [this._bindGroupLayout],
        });

        this._resetPipeline = this._device.createComputePipeline({
            label: 'culling-reset',
            layout: pipelineLayout,
            compute: { module: shaderModule, entryPoint: 'resetCounts' },
        });

        this._cullPipeline = this._device.createComputePipeline({
            label: 'culling-cull',
            layout: pipelineLayout,
            compute: { module: shaderModule, entryPoint: 'cullInstances' },
        });

        this._uniformBuffer = this._device.createBuffer({
            label: 'culling-uniforms',
            size: 112,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this._initialized = true;
        console.log('ComputeCullingManager: Initialized (resetCounts + cullInstances pipelines)');
    }

    /** Must be called after GlobalBufferManager.finalizeDrawCommands() */
    public rebuildBindGroup(): void {
        if (!this._initialized) return;

        const bm = this._bufferManager;
        const trsGpu = (bm.instanceTRSBuffer.getBuffer() as any).underlyingResource as GPUBuffer;

        this._bindGroup = this._device.createBindGroup({
            label: 'culling-bg',
            layout: this._bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this._uniformBuffer } },
                { binding: 1, resource: { buffer: trsGpu } },
                { binding: 2, resource: { buffer: bm.indirectDrawGpuBuffer } },
                { binding: 3, resource: { buffer: bm.visibleIndicesBuffer } },
                { binding: 4, resource: { buffer: bm.instanceDrawCmdMapBuffer } },
                { binding: 5, resource: { buffer: bm.drawCmdBaseOffsetsBuffer } },
                { binding: 6, resource: { buffer: bm.meshBoundsBuffer } },
            ],
        });
        console.log('ComputeCullingManager: Bind group rebuilt');
    }

    /**
     * Dispatch culling compute passes on the given encoder.
     * Call BEFORE the render pass in the same command buffer.
     */
    public dispatchCulling(encoder: GPUCommandEncoder, camera: Camera): void {
        if (!this._initialized || !this._bindGroup) return;

        const totalInstances = this._bufferManager.instanceCount;
        const drawCmdCount = this._bufferManager.drawCommandCount;
        if (totalInstances === 0 || drawCmdCount === 0) return;

        this._updateUniforms(camera, totalInstances, drawCmdCount);

        // Pass 1: Reset all instanceCount to 0
        const resetPass = encoder.beginComputePass({ label: 'cull-reset' });
        resetPass.setPipeline(this._resetPipeline);
        resetPass.setBindGroup(0, this._bindGroup);
        resetPass.dispatchWorkgroups(Math.ceil(drawCmdCount / 64));
        resetPass.end();

        // Pass 2: Frustum cull each instance
        const cullPass = encoder.beginComputePass({ label: 'cull-frustum' });
        cullPass.setPipeline(this._cullPipeline);
        cullPass.setBindGroup(0, this._bindGroup);
        cullPass.dispatchWorkgroups(Math.ceil(totalInstances / 64));
        cullPass.end();
    }

    private _updateUniforms(camera: Camera, totalInstances: number, drawCmdCount: number): void {
        // Extract 6 frustum planes from VP matrix (Gribb/Hartmann method)
        const vp = camera.getTransformationMatrix();
        const m = vp.toArray(); // Babylon row-major

        // Plane extraction for WebGPU NDC (z in [0,1]):
        // Left:   row3 + row0
        // Right:  row3 - row0
        // Bottom: row3 + row1
        // Top:    row3 - row1
        // Near:   row2          (z >= 0)
        // Far:    row3 - row2   (z <= 1)
        const planes: number[][] = [
            [m[12]+m[0], m[13]+m[1], m[14]+m[2],  m[15]+m[3]],
            [m[12]-m[0], m[13]-m[1], m[14]-m[2],  m[15]-m[3]],
            [m[12]+m[4], m[13]+m[5], m[14]+m[6],  m[15]+m[7]],
            [m[12]-m[4], m[13]-m[5], m[14]-m[6],  m[15]-m[7]],
            [m[8],       m[9],       m[10],        m[11]],
            [m[12]-m[8], m[13]-m[9], m[14]-m[10], m[15]-m[11]],
        ];

        for (let i = 0; i < 6; i++) {
            const [a, b, c, d] = planes[i];
            const len = Math.sqrt(a * a + b * b + c * c);
            const inv = len > 1e-6 ? 1 / len : 0;
            this._uniformData[i * 4 + 0] = a * inv;
            this._uniformData[i * 4 + 1] = b * inv;
            this._uniformData[i * 4 + 2] = c * inv;
            this._uniformData[i * 4 + 3] = d * inv;
        }

        const u32 = new Uint32Array(this._uniformData.buffer);
        u32[24] = totalInstances;
        u32[25] = drawCmdCount;
        u32[26] = 0;
        u32[27] = 0;

        this._device.queue.writeBuffer(this._uniformBuffer, 0, this._uniformData);
    }

    public get isReady(): boolean {
        return this._initialized && this._bindGroup !== null;
    }

    public dispose(): void {
        this._uniformBuffer?.destroy();
        this._bindGroup = null;
    }
}
