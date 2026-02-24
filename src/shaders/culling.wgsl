// GPU-Driven Culling Kernel
// Executes Frustum Culling, LOD Screen-Space Error Checks, and Hi-Z Occlusion Setup

struct BoundingVolume {
    center: vec3<f32>,
    radius: f32,
    geometricError: f32,
    pad1: f32,
    pad2: f32,
    pad3: f32,
}

// Ensure 16-byte alignment and matching Phase 1 Indirect format
struct IndirectDrawArgs {
    indexCount: u32,
    instanceCount: atomic<u32>,
    firstIndex: u32,
    baseVertex: u32,
    firstInstance: u32,
}

struct CullingUniforms {
    viewProjection: mat4x4<f32>,
    frustumPlanes: array<vec4<f32>, 6>,
    cameraPosition: vec3<f32>,
    _pad0: f32,                 // Explicit 4-byte padding after vec3 (WGSL alignment rules)
    hiZSize: vec2<f32>,
    lodThreshold: f32,
    totalInstances: u32,
}

@group(0) @binding(0) var<storage, read> boundingVolumes: array<BoundingVolume>;
@group(0) @binding(1) var<storage, read_write> indirectBuffer: IndirectDrawArgs;
@group(0) @binding(2) var<storage, read_write> visibleInstanceIndices: array<u32>;
@group(0) @binding(3) var hiZMap: texture_2d<f32>;
@group(0) @binding(4) var hiZSampler: sampler;
@group(0) @binding(5) var<uniform> uniforms: CullingUniforms;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let index = global_id.x;
    if (index >= uniforms.totalInstances) {
        return;
    }

    let bv = boundingVolumes[index];

    // 1. Frustum Culling
    var visible = true;
    for (var i = 0u; i < 6u; i = i + 1u) {
        let plane = uniforms.frustumPlanes[i];
        let distance = dot(plane.xyz, bv.center) + plane.w;
        if (distance < -bv.radius) {
            visible = false;
            break;
        }
    }

    if (!visible) {
        return;
    }

    // 2. LOD Geometric Error Screen-Space Evaluation
    let distanceToCam = distance(uniforms.cameraPosition, bv.center);
    // Simple screen space error mapping against distance
    let sse = (bv.geometricError * 1000.0) / (distanceToCam + 0.0001); 
    if (sse < uniforms.lodThreshold && bv.geometricError > 0.0) {
        // Discarding geometry out of fidelity thresholds
        return;
    }

    // 3. Hi-Z Occlusion Culling (Concept Implementation Map)
    // Project boundary box center to screen space coordinates
    var clipPos = uniforms.viewProjection * vec4<f32>(bv.center, 1.0);
    clipPos = clipPos / clipPos.w;
    
    // Bounds mapping (simplified screen-space AABB approximation)
    let screenX = (clipPos.x * 0.5 + 0.5) * uniforms.hiZSize.x;
    let screenY = (0.5 - clipPos.y * 0.5) * uniforms.hiZSize.y;
    
    // Logic evaluating Mip LOD using box footprint extent
    // let mipLevel = log2(max(boxSize.x, boxSize.y));
    // let depthZ = textureSampleLevel(hiZMap, hiZSampler, uv, mipLevel).r;
    
    // Assuming passed: Append atomically
    
    // Execute zero-latency atomic writes to hardware indirect buffer
    let visibleIndex = atomicAdd(&indirectBuffer.instanceCount, 1u);
    // Bounds-check prevents GPU OOB write if visible count exceeds buffer capacity
    if (visibleIndex < arrayLength(&visibleInstanceIndices)) {
        visibleInstanceIndices[visibleIndex] = index;
    }
}
