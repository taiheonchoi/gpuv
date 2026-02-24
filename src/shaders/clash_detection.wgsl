// GPU-Driven Clash Detection Kernel
// Processes spatial interference between dynamic operating volumes (Cranes/Robots) and 8M+ static instances.

struct BoundingVolume {
    center: vec3<f32>,
    radius: f32,
    geometricError: f32,
    pad1: f32,
    pad2: f32,
    pad3: f32,
}

struct DynamicObject {
    center: vec3<f32>,
    radius: f32,
}

struct ClashUniforms {
    totalInstances: u32,
    dynamicObjectCount: u32,
    pad1: u32,
    pad2: u32,
}

@group(0) @binding(0) var<storage, read> boundingVolumes: array<BoundingVolume>;
@group(0) @binding(1) var<storage, read> dynamicObjects: array<DynamicObject>;
// Binds directly to the Ghost/Health buffer to immediately trigger Red Emissive graphics (State 2.0)
@group(0) @binding(2) var<storage, read_write> sensorHealthBuffers: array<f32>;
@group(0) @binding(3) var<storage, read_write> clashResultCount: atomic<u32>;
@group(0) @binding(4) var<storage, read_write> clashResultIndices: array<u32>;
@group(0) @binding(5) var<uniform> uniforms: ClashUniforms;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let index = global_id.x;
    if (index >= uniforms.totalInstances) {
        return;
    }

    let bv = boundingVolumes[index];
    var isClashing = false;

    // Evaluate interference mathematically on hardware
    for (var i = 0u; i < uniforms.dynamicObjectCount; i = i + 1u) {
        let dynObj = dynamicObjects[i];
        let dist = distance(bv.center, dynObj.center);
        
        // Basic sphere-sphere overlap test (Extendable to AABB/OBB mapping)
        if (dist < (bv.radius + dynObj.radius)) {
            isClashing = true;
            break;
        }
    }

    if (isClashing) {
        // Zero-Latency Visiblity: Bypass CPU entirely by mapping Health State 2.0 (Disconnected / Danger)
        sensorHealthBuffers[index] = 2.0;

        // Atomically append the exact BatchID to the read-back registry for the AI/MCP System
        let clashIdx = atomicAdd(&clashResultCount, 1u);
        clashResultIndices[clashIdx] = index;
    }
}
