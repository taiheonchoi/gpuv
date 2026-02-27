// Custom Spec 2.0 WebGPU Indirect Shader
// Handles high-scale PBR lighting, batch ID instance reading, and LOD Dissolve logic.

struct Uniforms {
    viewProjection: mat4x4<f32>,
    cameraPosition: vec3<f32>,
    highlightedBatchId: u32,   // Reserved: selection highlight (blue glow when batchId matches)
    time: f32,                 // Reserved: LOD dissolve dither, pulse effects
    _pad0: u32,                // Reserved (was firstInstance — now using builtin instance_index)
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

// Align structured Matrix4 bytes carefully to 16-byte step parameters globally mapped during CustomTileLoader parsing
struct InstanceTRS {
    modelMatrix0: vec4<f32>,
    modelMatrix1: vec4<f32>,
    modelMatrix2: vec4<f32>,
    modelMatrix3: vec4<f32>,
}

@group(0) @binding(1) var<storage, read> instanceBuffers: array<InstanceTRS>;
// 16-byte aligned: [BatchID, pad, pad, pad] per instance — matches GlobalBufferManager._batchIdData stride of 4 u32s
struct BatchIdEntry {
    id: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}
@group(0) @binding(2) var<storage, read> batchIdBuffers: array<BatchIdEntry>;
@group(0) @binding(3) var<storage, read> visibleInstanceIndices: array<u32>; // Added for Compute Culling output mapping

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @builtin(instance_index) instance_index: u32,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) worldPos: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) @interpolate(flat) batchId: u32,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    // WebGPU instance_index = firstInstance + i (i=0..instanceCount-1).
    // firstInstance is set per-draw in the indirect args buffer, so instance_index
    // already points to the correct region of the remap buffer.
    let trsIndex = visibleInstanceIndices[input.instance_index];
    let instance = instanceBuffers[trsIndex];
    let batchId = batchIdBuffers[trsIndex].id;
    let modelMatrix = mat4x4<f32>(
        instance.modelMatrix0,
        instance.modelMatrix1,
        instance.modelMatrix2,
        instance.modelMatrix3
    );

    // Babylon.js stores matrices row-major. WGSL reads buffer as column-major.
    // So model/VP matrices in WGSL are effectively transposed.
    // Use vec*mat (row-vector multiplication) which computes M^T * v = correct result.
    let worldPosition = vec4<f32>(input.position, 1.0) * modelMatrix;

    output.position = worldPosition * uniforms.viewProjection;
    output.worldPos = worldPosition.xyz;
    output.normal = (vec4<f32>(input.normal, 0.0) * modelMatrix).xyz;
    output.batchId = batchId;

    return output;
}

// Hash a u32 to a pseudo-random RGB color for per-object visualization
fn hashColor(id: u32) -> vec3<f32> {
    let r = fract(f32(id) * 0.3183099 + 0.1);
    let g = fract(f32(id) * 0.1517823 + 0.7);
    let b = fract(f32(id) * 0.0714321 + 0.4);
    return vec3<f32>(r, g, b);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    // Per-instance color from batchId hash
    let baseColor = hashColor(input.batchId);

    // Simple hemisphere lighting
    let N = normalize(input.normal);
    let L = normalize(vec3<f32>(0.3, 1.0, 0.5));
    let NdotL = max(dot(N, L), 0.0);
    let ambient = 0.3;
    let lit = baseColor * (ambient + (1.0 - ambient) * NdotL);

    return vec4<f32>(lit, 1.0);
}
