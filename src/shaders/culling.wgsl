// GPU-Driven Multi-Draw Frustum Culling
// Two entry points:
//   resetCounts   — zeros instanceCount per draw command
//   cullInstances  — frustum test + atomic remap write per instance

struct IndirectDrawArgs {
    indexCount:     u32,
    instanceCount:  atomic<u32>,
    firstIndex:     u32,
    baseVertex:     u32,
    firstInstance:  u32,
}

struct MeshBounds {
    center: vec3<f32>,
    radius: f32,
}

struct InstanceTRS {
    col0: vec4<f32>,
    col1: vec4<f32>,
    col2: vec4<f32>,
    col3: vec4<f32>,
}

struct CullingUniforms {
    frustumPlanes:    array<vec4<f32>, 6>,
    totalInstances:   u32,
    drawCommandCount: u32,
    _pad0:            u32,
    _pad1:            u32,
}

@group(0) @binding(0) var<uniform> uniforms: CullingUniforms;
@group(0) @binding(1) var<storage, read> instanceTRS: array<InstanceTRS>;
@group(0) @binding(2) var<storage, read_write> indirectBuffer: array<IndirectDrawArgs>;
@group(0) @binding(3) var<storage, read_write> visibleIndices: array<u32>;
@group(0) @binding(4) var<storage, read> instanceCmdMap: array<u32>;
@group(0) @binding(5) var<storage, read> cmdBaseOffsets: array<u32>;
@group(0) @binding(6) var<storage, read> meshBounds: array<MeshBounds>;

// ─── Entry Point 1: Reset all commands' instanceCount to 0 ───
@compute @workgroup_size(64)
fn resetCounts(@builtin(global_invocation_id) gid: vec3<u32>) {
    let cmdIdx = gid.x;
    if (cmdIdx >= uniforms.drawCommandCount) {
        return;
    }
    atomicStore(&indirectBuffer[cmdIdx].instanceCount, 0u);
}

// ─── Entry Point 2: Per-instance frustum cull + atomic remap write ───
@compute @workgroup_size(64)
fn cullInstances(@builtin(global_invocation_id) gid: vec3<u32>) {
    let instanceIdx = gid.x;
    if (instanceIdx >= uniforms.totalInstances) {
        return;
    }

    // Which draw command does this instance belong to?
    let cmdIdx = instanceCmdMap[instanceIdx];

    // Per-mesh local bounding sphere
    let localBounds = meshBounds[cmdIdx];

    // Instance TRS matrix (column-major 4x4)
    let trs = instanceTRS[instanceIdx];
    let modelMatrix = mat4x4<f32>(trs.col0, trs.col1, trs.col2, trs.col3);

    // Transform bounding sphere center to world space
    let worldCenter = (modelMatrix * vec4<f32>(localBounds.center, 1.0)).xyz;

    // Conservative radius: scale by max column length (handles non-uniform scale)
    let sx = length(trs.col0.xyz);
    let sy = length(trs.col1.xyz);
    let sz = length(trs.col2.xyz);
    let worldRadius = localBounds.radius * max(sx, max(sy, sz));

    // Frustum test: 6 planes, reject if sphere is entirely behind any plane
    for (var i = 0u; i < 6u; i = i + 1u) {
        let plane = uniforms.frustumPlanes[i];
        let dist = dot(plane.xyz, worldCenter) + plane.w;
        if (dist < -worldRadius) {
            return;
        }
    }

    // Visible: atomically claim a slot in this command's remap region
    let slot = atomicAdd(&indirectBuffer[cmdIdx].instanceCount, 1u);
    let baseOffset = cmdBaseOffsets[cmdIdx];
    visibleIndices[baseOffset + slot] = instanceIdx;
}
