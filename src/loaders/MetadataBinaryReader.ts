/**
 * Browser ArrayBuffer parser for metadata.bin V2.
 * Ported from rx-sidecar-binary-reader.ts (Node.js fs → ArrayBuffer).
 *
 * Supports:
 *   v1 (40B header, dense transforms)
 *   v2 (32B header, sparse/split transforms, no hpos/tpos)
 */

const META_FLAG_SPARSE_TRANSFORMS = 0x01;
const META_FLAG_HAS_PROP_OFFSETS = 0x08;
const META_FLAG_SPARSE_SPLIT = 0x10;

export interface MetadataData {
    version: number;
    nodeCount: number;
    /** Dense 3x4 transforms: N * 12 floats (identity for nodes without transform) */
    transforms: Float32Array;
    /** Property JSON strings keyed by node index (sparse — only nodes with properties) */
    properties: Map<number, string>;
}

/**
 * Parse metadata.bin ArrayBuffer.
 * Returns dense transforms + sparse property map.
 */
export function readMetadataBin(buffer: ArrayBuffer): MetadataData {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic !== 'META') throw new Error(`Invalid metadata.bin magic: ${magic}`);

    const version = view.getUint32(4, true);
    const nodeCount = view.getUint32(8, true);

    let flags = 0;
    let transformOffset = 0;
    let propOffsetsOffset = 0;
    let propDataOffset = 0;
    let propDataSize = 0;

    if (version >= 2) {
        // v2 header (32B)
        flags = view.getUint32(12, true);
        transformOffset = view.getUint32(16, true);
        propOffsetsOffset = view.getUint32(20, true);
        propDataOffset = view.getUint32(24, true);
        propDataSize = view.getUint32(28, true);
    } else {
        // v1 header (40B)
        transformOffset = view.getUint32(12, true);
        // hposOffset = view.getUint32(16, true); // removed in v2
        // tposOffset = view.getUint32(20, true); // removed in v2
        propOffsetsOffset = view.getUint32(24, true);
        propDataOffset = view.getUint32(28, true);
        propDataSize = view.getUint32(32, true);
    }

    const sparseTransforms = (flags & META_FLAG_SPARSE_TRANSFORMS) !== 0;
    const sparseSplit = (flags & META_FLAG_SPARSE_SPLIT) !== 0;

    // Parse transforms
    const transforms = _readTransforms(view, nodeCount, transformOffset, sparseTransforms, sparseSplit, propOffsetsOffset || propDataOffset || buffer.byteLength);

    // Parse properties
    const properties = _readProperties(view, bytes, nodeCount, flags, propOffsetsOffset, propDataOffset, propDataSize);

    console.log(`MetadataBinaryReader: parsed ${nodeCount} nodes (v${version}, sparse=${sparseTransforms}, props=${properties.size})`);

    return { version, nodeCount, transforms, properties };
}

function _readTransforms(
    view: DataView,
    nodeCount: number,
    transformOffset: number,
    sparseTransforms: boolean,
    sparseSplit: boolean,
    _sectionEnd: number,
): Float32Array {
    // Initialize with identity
    const transforms = new Float32Array(nodeCount * 12);
    for (let i = 0; i < nodeCount; i++) {
        const base = i * 12;
        transforms[base] = 1; transforms[base + 5] = 1; transforms[base + 10] = 1;
    }

    if (transformOffset === 0) return transforms;

    if (sparseTransforms && sparseSplit) {
        // v2 sparse split: two sub-lists
        let off = transformOffset;

        // Sub-list 1: translate-only
        const translateCount = view.getUint32(off, true); off += 4;
        for (let t = 0; t < translateCount; t++) {
            const idx = view.getUint32(off, true); off += 4;
            const tx = view.getFloat32(off, true); off += 4;
            const ty = view.getFloat32(off, true); off += 4;
            const tz = view.getFloat32(off, true); off += 4;
            if (idx < nodeCount) {
                const base = idx * 12;
                transforms[base] = 1; transforms[base + 1] = 0; transforms[base + 2] = 0; transforms[base + 3] = tx;
                transforms[base + 4] = 0; transforms[base + 5] = 1; transforms[base + 6] = 0; transforms[base + 7] = ty;
                transforms[base + 8] = 0; transforms[base + 9] = 0; transforms[base + 10] = 1; transforms[base + 11] = tz;
            }
        }

        // Sub-list 2: full 3x4
        const fullCount = view.getUint32(off, true); off += 4;
        for (let f = 0; f < fullCount; f++) {
            const idx = view.getUint32(off, true); off += 4;
            if (idx < nodeCount) {
                const base = idx * 12;
                for (let k = 0; k < 12; k++) {
                    transforms[base + k] = view.getFloat32(off, true);
                    off += 4;
                }
            } else {
                off += 48;
            }
        }
    } else {
        // Dense: N * 12 floats
        for (let i = 0; i < nodeCount; i++) {
            const base = i * 12;
            const byteOff = transformOffset + i * 48;
            for (let k = 0; k < 12; k++) {
                transforms[base + k] = view.getFloat32(byteOff + k * 4, true);
            }
        }
    }

    return transforms;
}

const _propDecoder = new TextDecoder('utf-8');

function _readProperties(
    view: DataView,
    bytes: Uint8Array,
    nodeCount: number,
    flags: number,
    propOffsetsOffset: number,
    propDataOffset: number,
    propDataSize: number,
): Map<number, string> {
    const properties = new Map<number, string>();

    if (propDataOffset === 0 || propDataSize === 0) return properties;

    const hasPropOffsets = (flags & META_FLAG_HAS_PROP_OFFSETS) !== 0;

    if (hasPropOffsets && propOffsetsOffset > 0) {
        // Offset table: N * 8 bytes (offset u32 + length u32) per node
        for (let i = 0; i < nodeCount; i++) {
            const entryOff = propOffsetsOffset + i * 8;
            const dataOff = view.getUint32(entryOff, true);
            const dataLen = view.getUint32(entryOff + 4, true);
            if (dataLen > 0) {
                const absOff = propDataOffset + dataOff;
                const json = _propDecoder.decode(bytes.subarray(absOff, absOff + dataLen));
                properties.set(i, json);
            }
        }
    } else if (propDataSize > 0) {
        // Fallback: try to read as concatenated JSON blobs with index headers
        // This handles simple dense property formats
        try {
            const propBytes = bytes.subarray(propDataOffset, propDataOffset + propDataSize);
            const propStr = _propDecoder.decode(propBytes);
            // If the entire section is one big JSON array, split by node
            if (propStr.startsWith('[')) {
                const arr = JSON.parse(propStr) as any[];
                for (let i = 0; i < arr.length && i < nodeCount; i++) {
                    if (arr[i] !== null && arr[i] !== undefined) {
                        properties.set(i, JSON.stringify(arr[i]));
                    }
                }
            }
        } catch {
            // Properties not parseable — skip silently
        }
    }

    return properties;
}

/**
 * Get world transform for a node as a 3x4 matrix (12 floats).
 * Returns null if index out of range.
 */
export function getNodeTransform(data: MetadataData, index: number): Float32Array | null {
    if (index < 0 || index >= data.nodeCount) return null;
    return data.transforms.subarray(index * 12, (index + 1) * 12);
}

/**
 * Get properties JSON for a node.
 * Returns null if no properties.
 */
export function getNodeProperties(data: MetadataData, index: number): Record<string, any> | null {
    const json = data.properties.get(index);
    if (!json) return null;
    try {
        return JSON.parse(json);
    } catch {
        return null;
    }
}
