// Custom Spec 2.0 Digital Ghost & Health Check Effect
// Expands standard rendering to visualize physical latency and telemetry health

struct Uniforms {
    viewProjection: mat4x4<f32>,
    cameraPosition: vec3<f32>,
    time: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

// Align to 16 bytes: standard TRS matrix
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

// Culling indirection buffer: maps draw instance_index → global instance index
@group(0) @binding(3) var<storage, read> visibleInstanceIndices: array<u32>;

// Sensor metadata. Example: 0.0 = Normal, 1.0 = Delayed, 2.0 = Disconnected, 3.0 = Selected/Highlighted
@group(0) @binding(4) var<storage, read> sensorHealthBuffers: array<f32>;

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
    @location(3) @interpolate(flat) healthState: f32, // Passed to fragment for Outline logic
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    // Fetch real global index from the indirection buffer populated by the Culling Compute Shader
    let global_index = visibleInstanceIndices[input.instance_index];

    let instance = instanceBuffers[global_index];
    let batchId = batchIdBuffers[global_index].id;
    let healthState = sensorHealthBuffers[global_index];

    let modelMatrix = mat4x4<f32>(
        instance.modelMatrix0,
        instance.modelMatrix1,
        instance.modelMatrix2,
        instance.modelMatrix3
    );

    let worldPosition = modelMatrix * vec4<f32>(input.position, 1.0);
    output.position = uniforms.viewProjection * worldPosition;
    output.worldPos = worldPosition.xyz;
    output.normal = (modelMatrix * vec4<f32>(input.normal, 0.0)).xyz;
    
    output.batchId = batchId;
    output.healthState = healthState;

    return output;
}

struct FragmentOutput {
    @location(0) color: vec4<f32>,
}

@fragment
fn fs_main(input: VertexOutput) -> FragmentOutput {
    var output: FragmentOutput;
    
    let normal = normalize(input.normal);
    let viewDir = normalize(uniforms.cameraPosition - input.worldPos);
    
    // Core Edge Detect (Outline algorithm mapping angle of incidence)
    let rimDot = 1.0 - max(dot(viewDir, normal), 0.0);
    let rimIntensity = smoothstep(0.6, 1.0, rimDot);
    
    // Default Digital Twin Solid State
    var baseColor = vec3<f32>(0.3, 0.5, 0.7);
    var emissiveColor = vec3<f32>(0.0);
    var alpha = 1.0;

    // Health-Check Logic mappings based exactly on requirements
    if (input.healthState < 0.5) {
        // 0: Normal (< 100ms) -> Green Solid Outline
        emissiveColor = vec3<f32>(0.0, 1.0, 0.2) * rimIntensity;
    } 
    else if (input.healthState < 1.5) {
        // 1: Delayed (100ms~500ms) -> Yellow Dotted (Simulated using screen coord noise/sine)
        let pattern = sin(input.position.x * 20.0 + input.position.y * 20.0) * 0.5 + 0.5;
        if (pattern > 0.5) {
            emissiveColor = vec3<f32>(1.0, 0.8, 0.0) * rimIntensity * 1.5;
        } else {
            emissiveColor = vec3<f32>(1.0, 0.8, 0.0) * rimIntensity * 0.2; // Dotted gap
        }
    } 
    else if (input.healthState < 2.5) {
        // 2: Disconnected (> 500ms) -> Red Emissive Glowing Ghost
        baseColor = vec3<f32>(1.0, 0.1, 0.1);
        emissiveColor = vec3<f32>(1.0, 0.0, 0.0) * (0.5 + sin(uniforms.time * 5.0) * 0.5); // Pulsing
        alpha = 0.5; // Ghost state
    }
    else if (input.healthState > 2.5) {
        // 3: Highlighted Search Query Visual
        baseColor = vec3<f32>(1.0, 1.0, 1.0);
        emissiveColor = vec3<f32>(0.0, 0.5, 1.0) * rimIntensity * 2.0;
    }

    // Accumulate Color Maps
    let finalColor = baseColor * 0.5 + emissiveColor;

    output.color = vec4<f32>(finalColor, alpha);

    return output;
}
