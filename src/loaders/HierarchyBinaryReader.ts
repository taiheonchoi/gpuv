/**
 * Browser ArrayBuffer parser for hierarchy.bin V2.
 * Ported from rx-sidecar-binary-reader.ts (Node.js fs → ArrayBuffer).
 *
 * Does NOT eagerly decode all name strings — uses lazy decode with LRU cache
 * since only ~50 rows are visible at a time in the virtual-scroll tree.
 */

const HIERARCHY_FLAG_HAS_BOUNDS = 0x01;
const HIERARCHY_FLAG_BOUNDS_F16 = 0x02;
const HIERARCHY_FLAG_HAS_TYPE_TABLE = 0x04;

export interface HierarchyData {
    nodeCount: number;
    version: number;
    hasBounds: boolean;
    boundsF16: boolean;
    typeTable: string[] | null;
    /** Raw DataView over the records section (32 bytes/node) */
    recordsView: DataView;
    recordsOffset: number;
    /** Raw DataView over bounds section (if present) */
    boundsView: DataView | null;
    boundsOffset: number;
    boundsPerNode: number;
    /** String heap as Uint8Array for lazy name decode */
    stringHeap: Uint8Array;
    /** Offset in string heap where names start (after type table) */
    nameStartOffset: number;
}

/** Decoded node record — returned by getNode() */
export interface HierarchyNode {
    index: number;
    parentIdx: number;
    firstChildIdx: number;
    nextSiblingIdx: number;
    childCount: number;
    nameOffset: number;
    ltreeOffset: number;
    nameLen: number;
    ltreeLen: number;
    type: number;
    depth: number;
    hasGeometry: boolean;
}

/* ---- float16 decoding (browser-compatible) ---- */
const _f32Arr = new Float32Array(1);
const _u32Arr = new Uint32Array(_f32Arr.buffer);

function f16BitsToF32(h: number): number {
    const sign = (h >>> 15) & 1;
    const exp = (h >>> 10) & 0x1f;
    const frac = h & 0x3ff;
    if (exp === 0) {
        if (frac === 0) return sign ? -0 : 0;
        let e = -14;
        let f = frac;
        while ((f & 0x400) === 0) { f <<= 1; e--; }
        f &= 0x3ff;
        _u32Arr[0] = ((sign << 31) | ((e + 127) << 23) | (f << 13)) >>> 0;
        return _f32Arr[0];
    }
    if (exp === 31) return frac === 0 ? (sign ? -Infinity : Infinity) : NaN;
    _u32Arr[0] = ((sign << 31) | ((exp - 15 + 127) << 23) | (frac << 13)) >>> 0;
    return _f32Arr[0];
}

const _nameCache = new Map<number, string>();
const NAME_CACHE_MAX = 10000;
const _textDecoder = new TextDecoder('utf-8');

/**
 * Parse hierarchy.bin ArrayBuffer into a HierarchyData structure.
 * Keeps raw views — does not allocate per-node objects for 1.1M nodes.
 */
export function readHierarchyBin(buffer: ArrayBuffer): HierarchyData {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // Header
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic !== 'HIER') throw new Error(`Invalid hierarchy.bin magic: ${magic}`);

    const version = view.getUint32(4, true);
    const nodeCount = view.getUint32(8, true);
    const stringHeapSize = view.getUint32(12, true);

    let flags = 0;
    let headerSize = 16;
    if (version >= 2) {
        flags = view.getUint32(16, true);
        headerSize = 20;
    }

    const hasBounds = (flags & HIERARCHY_FLAG_HAS_BOUNDS) !== 0;
    const boundsF16 = (flags & HIERARCHY_FLAG_BOUNDS_F16) !== 0;
    const hasTypeTable = (flags & HIERARCHY_FLAG_HAS_TYPE_TABLE) !== 0;

    const recordSize = 32;
    const boundsPerNode = hasBounds ? (boundsF16 ? 12 : 24) : 0;

    const recordsOffset = headerSize;
    const boundsOffset = recordsOffset + nodeCount * recordSize;
    const stringHeapOffset = boundsOffset + nodeCount * boundsPerNode;

    const stringHeap = bytes.subarray(stringHeapOffset, stringHeapOffset + stringHeapSize);

    // Decode type table if present
    let typeTable: string[] | null = null;
    let nameStartOffset = 0;
    if (hasTypeTable && stringHeap.length >= 2) {
        const heapView = new DataView(stringHeap.buffer, stringHeap.byteOffset, stringHeap.byteLength);
        const typeCount = heapView.getUint16(0, true);
        typeTable = [];
        let cursor = 2;
        for (let t = 0; t < typeCount; t++) {
            const len = heapView.getUint16(cursor, true);
            cursor += 2;
            typeTable.push(_textDecoder.decode(stringHeap.subarray(cursor, cursor + len)));
            cursor += len;
        }
        nameStartOffset = cursor;
    }

    const recordsView = new DataView(buffer, recordsOffset, nodeCount * recordSize);
    const boundsView = hasBounds
        ? new DataView(buffer, boundsOffset, nodeCount * boundsPerNode)
        : null;

    console.log(`HierarchyBinaryReader: parsed ${nodeCount} nodes (v${version}, bounds=${hasBounds}, f16=${boundsF16}, types=${typeTable?.length ?? 0})`);

    return {
        nodeCount, version, hasBounds, boundsF16, typeTable,
        recordsView, recordsOffset,
        boundsView, boundsOffset, boundsPerNode,
        stringHeap, nameStartOffset,
    };
}

/** Read a single node record without allocating name strings */
export function getNode(data: HierarchyData, index: number): HierarchyNode {
    const rv = data.recordsView;
    const off = index * 32;
    const hasTypeTable = data.typeTable !== null;

    let type: number, depth: number, hasGeometry = false;
    if (hasTypeTable) {
        type = rv.getUint8(off + 28);
        depth = rv.getUint8(off + 29);
        hasGeometry = (rv.getUint8(off + 30) & 0x01) !== 0;
    } else {
        type = rv.getUint16(off + 28, true);
        depth = rv.getUint8(off + 30);
    }

    return {
        index,
        parentIdx: rv.getInt32(off, true),
        firstChildIdx: rv.getInt32(off + 4, true),
        nextSiblingIdx: rv.getInt32(off + 8, true),
        childCount: rv.getInt32(off + 12, true),
        nameOffset: rv.getUint32(off + 16, true),
        ltreeOffset: rv.getUint32(off + 20, true),
        nameLen: rv.getUint16(off + 24, true),
        ltreeLen: rv.getUint16(off + 26, true),
        type, depth, hasGeometry,
    };
}

/** Lazy name decode with LRU cache */
export function getNodeName(data: HierarchyData, index: number): string {
    const cached = _nameCache.get(index);
    if (cached !== undefined) return cached;

    const rv = data.recordsView;
    const off = index * 32;
    const nameOff = rv.getUint32(off + 16, true);
    const nameLen = rv.getUint16(off + 24, true);

    if (nameLen === 0) return '';

    const name = _textDecoder.decode(data.stringHeap.subarray(nameOff, nameOff + nameLen));

    // LRU eviction: simple random evict when full
    if (_nameCache.size >= NAME_CACHE_MAX) {
        const firstKey = _nameCache.keys().next().value!;
        _nameCache.delete(firstKey);
    }
    _nameCache.set(index, name);
    return name;
}

/** Get node type as string */
export function getNodeTypeName(data: HierarchyData, typeIdx: number): string {
    if (data.typeTable && typeIdx < data.typeTable.length) {
        return data.typeTable[typeIdx];
    }
    return `type_${typeIdx}`;
}

/** Get bounds for a node (returns null if no bounds) */
export function getNodeBounds(data: HierarchyData, index: number): { min: [number, number, number]; max: [number, number, number] } | null {
    if (!data.boundsView) return null;
    const bv = data.boundsView;
    const off = index * data.boundsPerNode;

    let minX: number, minY: number, minZ: number;
    let maxX: number, maxY: number, maxZ: number;

    if (data.boundsF16) {
        minX = f16BitsToF32(bv.getUint16(off, true));
        minY = f16BitsToF32(bv.getUint16(off + 2, true));
        minZ = f16BitsToF32(bv.getUint16(off + 4, true));
        maxX = f16BitsToF32(bv.getUint16(off + 6, true));
        maxY = f16BitsToF32(bv.getUint16(off + 8, true));
        maxZ = f16BitsToF32(bv.getUint16(off + 10, true));
    } else {
        minX = bv.getFloat32(off, true);
        minY = bv.getFloat32(off + 4, true);
        minZ = bv.getFloat32(off + 8, true);
        maxX = bv.getFloat32(off + 12, true);
        maxY = bv.getFloat32(off + 16, true);
        maxZ = bv.getFloat32(off + 20, true);
    }

    if (isNaN(minX)) return null;
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** Clear the name decode cache (e.g. when loading a new dataset) */
export function clearNameCache(): void {
    _nameCache.clear();
}
