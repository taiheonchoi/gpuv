// Custom Spec 2.0 WebGPU Indirect Shader
// Handles high-scale PBR lighting, batch ID instance reading, Picking, and LOD Dissolve logic.

struct Uniforms {
    viewProjection: mat4x4<f32>,
    cameraPosition: vec3<f32>,
    highlightedBatchId: u32,
    time: f32, // Passed from CPU frame interval
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
@group(0) @binding(2) var<storage, read> batchIdBuffers: array<u32>;
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

    // Fetch the real global index from the indirection buffer populated by the Culling Compute Shader
    let global_index = visibleInstanceIndices[input.instance_index];

    let instance = instanceBuffers[global_index];
    let batchId = batchIdBuffers[global_index];

    // Reconstruct 4x4 matrix from standard std430 contiguous streams mapped in Phase 1
    let modelMatrix = mat4x4<f32>(
        instance.modelMatrix0,
        instance.modelMatrix1,
        instance.modelMatrix2,
        instance.modelMatrix3
    );

    let worldPosition = modelMatrix * vec4<f32>(input.position, 1.0);
    output.position = uniforms.viewProjection * worldPosition;
    output.worldPos = worldPosition.xyz;
    
    // Normal transform (assuming orthogonal TRS without nonuniform scaling for simplicity)
    output.normal = (modelMatrix * vec4<f32>(input.normal, 0.0)).xyz;
    output.batchId = batchId;

    return output;
}

struct FragmentOutput {
    @location(0) color: vec4<f32>,
    // R32Uint Picking Render Target output hook
    @location(1) idOutput: u32, 
}

// Interleaved Gradient Noise formula for efficient GPU Dither Dissolve
fn rand(uv: vec2<f32>) -> f32 {
    let magic = vec3<f32>(0.06711056, 0.00583715, 52.9829189);
    return fract(magic.z * fract(dot(uv, magic.xy)));
}

@fragment
fn fs_main(input: VertexOutput) -> FragmentOutput {
    var output: FragmentOutput;

    // LOD Dissolve blending effect (Hides sudden popping of geometry)
    let dither = rand(input.position.xy);
    let dissolveThreshold = 0.05 + sin(uniforms.time) * 0.02; // Subtle pulsing blend example limit
    if (dither < dissolveThreshold) {
        discard;
    }

    let normal = normalize(input.normal);
    
    // Core PBR directional lighting stub mapped specifically for complex structure
    let lightDir = normalize(vec3<f32>(0.5, 1.0, 0.3));
    let diffuse = max(dot(normal, lightDir), 0.0);
    
    var baseColor = vec3<f32>(0.5, 0.7, 0.9) * (diffuse * 0.8 + 0.2); // Engineering Blueprint Theme Default

    // Interactive GPU ID highlight override mapped statically from uniforms
    if (input.batchId == uniforms.highlightedBatchId) {
        // Emit vivid warning hue for selecting an instance component
        baseColor = vec3<f32>(1.0, 0.3, 0.1); 
    }

    output.color = vec4<f32>(baseColor, 1.0);
    // Explicit BatchID propagation mapped safely outside traditional visual color limits
    output.idOutput = input.batchId;

    return output;
}
