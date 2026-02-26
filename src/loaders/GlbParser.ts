/**
 * Minimal GLB parser: extracts JSON and BIN chunk(s) for use with CustomTileParser.processTileGltf.
 * GLB layout: 12-byte header (magic, version, length) then [length, type, payload] chunks.
 */

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942;  // 'BIN'

export interface GlbParseResult {
    json: any;
    binaryBuffers: ArrayBuffer[];
}

export function parseGLB(arrayBuffer: ArrayBuffer): GlbParseResult {
    const dataView = new DataView(arrayBuffer);
    if (dataView.byteLength < 12) throw new Error("GLB: buffer too short");
    const magic = dataView.getUint32(0, true);
    if (magic !== GLB_MAGIC) throw new Error("GLB: invalid magic");
    const version = dataView.getUint32(4, true);
    if (version !== 2) throw new Error("GLB: unsupported version");
    const totalLength = dataView.getUint32(8, true);

    const binaryBuffers: ArrayBuffer[] = [];
    let json: any = null;
    let offset = 12;

    while (offset < dataView.byteLength && offset < totalLength) {
        if (offset + 8 > dataView.byteLength) break;
        const chunkLength = dataView.getUint32(offset, true);
        const chunkType = dataView.getUint32(offset + 4, true);
        const chunkStart = offset + 8;
        const chunkEnd = chunkStart + chunkLength;
        if (chunkEnd > dataView.byteLength) throw new Error("GLB: chunk overflow");

        if (chunkType === CHUNK_JSON) {
            const dec = new TextDecoder("utf-8");
            const jsonStr = dec.decode(arrayBuffer.slice(chunkStart, chunkEnd));
            json = JSON.parse(jsonStr);
        } else if (chunkType === CHUNK_BIN) {
            binaryBuffers.push(arrayBuffer.slice(chunkStart, chunkEnd));
        }
        offset = chunkEnd;
    }

    if (!json) throw new Error("GLB: no JSON chunk");
    return { json, binaryBuffers };
}
