// Hierarchical Z-Buffer Generation Compute Shader
// Constructs the depth pyramid mipmap chain by reading the previous mip level and capturing the minimum depth.

@group(0) @binding(0) var srcTexture: texture_2d<f32>;
@group(0) @binding(1) var dstTexture: texture_storage_2d<r32float, write>;

@compute @workgroup_size(16, 16, 1)
fn generate_mip(@builtin(global_invocation_id) id: vec3<u32>) {
    let dstSize = textureDimensions(dstTexture);
    if (id.x >= dstSize.x || id.y >= dstSize.y) {
        return;
    }

    // Compute the starting coordinate of the 2x2 footprint in the source texture
    let srcPos = vec2<i32>(i32(id.x * 2u), i32(id.y * 2u));
    
    // Sample the 4 texels from the previous level
    let d0 = textureLoad(srcTexture, srcPos, 0).r;
    let d1 = textureLoad(srcTexture, srcPos + vec2<i32>(1, 0), 0).r;
    let d2 = textureLoad(srcTexture, srcPos + vec2<i32>(0, 1), 0).r;
    let d3 = textureLoad(srcTexture, srcPos + vec2<i32>(1, 1), 0).r;

    // Determine the minimum depth (furthest from camera in standard OpenGL, but closer in Reversed-Z)
    // Assuming Babylon WebGPU runs 0.0 (near) to 1.0 (far), min depth represents the most conservative occluder depth
    let minDepth = min(min(d0, d1), min(d2, d3));

    // Store the computed min-Z value into the current mip level
    textureStore(dstTexture, vec2<i32>(i32(id.x), i32(id.y)), vec4<f32>(minDepth, 0.0, 0.0, 0.0));
}
