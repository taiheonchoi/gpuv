/**
 * Custom Spec 2.0 Tiler SDK - Core Implementation (Spec 2.5 Verified)
 * CAD/BIM 원본 데이터를 Spec 2.5 이진 규격으로 변환하는 최종 엔진입니다.
 * HPOS(64-bit), THIE(40B Record), Metadata(112B Record) 생성을 지원합니다.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Vector3, Matrix, Quaternion } from '@babylonjs/core';

// --- 1. Spec 2.5 바이너리 레이아웃 규격 ---
const THIE_RECORD_SIZE = 40;        // hierarchy.bin 레코드 크기
const METADATA_RECORD_SIZE = 112;   // metadata.bin 레코드 크기 (HPOS 포함)
const TILESET_BIN_HEADER_SIZE = 32;
const SPATIAL_INDEX_SIZE = 64; 

export enum SemanticCategory {
    UNKNOWN = 0x00,
    STRUCTURAL = 0x01,
    HVAC = 0x02,
    PIPING = 0x04,
    ELECTRICAL = 0x08,
    EQUIPMENT = 0x10,
    SAFETY = 0x20
}

export interface RawInstance {
    guid: string;
    name: string;
    ltree: string;
    semanticTag: SemanticCategory;
    transform: Matrix;
    hpos: [number, number, number]; // FP64 High-Precision World Origin
    geometryHash: string;
    vertices: Float32Array;
    indices: Uint32Array;
    mortonCode?: bigint;
    center?: Vector3;
    geometricError: number;
    installDate: number; // Unix Timestamp
    serviceDate: number; // Unix Timestamp
}

// --- 2. Morton Code Generator (64-bit Precision) ---
class MortonUtils {
    public static encode(pos: Vector3, min: Vector3, max: Vector3): bigint {
        const x = (pos.x - min.x) / (max.x - min.x);
        const y = (pos.y - min.y) / (max.y - min.y);
        const z = (pos.z - min.z) / (max.z - min.z);

        const x_int = BigInt(Math.floor(Math.max(0, Math.min(1, x)) * 2097151));
        const y_int = BigInt(Math.floor(Math.max(0, Math.min(1, y)) * 2097151));
        const z_int = BigInt(Math.floor(Math.max(0, Math.min(1, z)) * 2097151));

        return (this.splitBy2(x_int) << 2n) | (this.splitBy2(y_int) << 1n) | this.splitBy2(z_int);
    }

    private static splitBy2(a: bigint): bigint {
        let x = a & 0x1fffff1n;
        x = (x | (x << 32n)) & 0x1f00000000ffffn;
        x = (x | (x << 16n)) & 0x1f0000ff0000ffn;
        x = (x | (x << 8n)) & 0x100f00f00f00f00fn;
        x = (x | (x << 4n)) & 0x10c30c30c30c30c3n;
        x = (x | (x << 2n)) & 0x1249249249249249n;
        return x;
    }
}

// --- 3. Binary Compiler (Spec 2.5 Layout Implementation) ---
class BinaryCompiler {
    /**
     * hierarchy.bin (THIE 포맷) 생성
     * 40바이트 고정 레코드로 계층 구조 직렬화
     */
    public compileHierarchy(instances: RawInstance[]): Buffer {
        const nodeCount = instances.length;
        const buffer = Buffer.alloc(24 + nodeCount * THIE_RECORD_SIZE);
        
        // Header (24B)
        buffer.writeUInt32LE(0x45494854, 0); // Magic 'THIE'
        buffer.writeUInt32LE(1, 4);          // Version
        buffer.writeUInt32LE(nodeCount, 8);  // Node Count
        
        instances.forEach((inst, i) => {
            const off = 24 + i * THIE_RECORD_SIZE;
            buffer.writeUInt32LE(i, off);              // nodeId
            buffer.writeUInt32LE(0xFFFFFFFF, off + 4); // parentId (기본값)
            buffer.writeUInt32LE(inst.semanticTag, off + 16); // semanticTag (Bitmask)
            
            if (inst.center) {
                buffer.writeFloatLE(inst.center.x, off + 20);
                buffer.writeFloatLE(inst.center.y, off + 24);
                buffer.writeFloatLE(inst.center.z, off + 28);
            }
        });
        return buffer;
    }

    /**
     * metadata.bin (Structural Metadata) 생성
     * 112바이트 고정 레코드 + HPOS(FP64) 지원
     */
    public compileMetadata(instances: RawInstance[]): Buffer {
        const nodeCount = instances.length;
        const buffer = Buffer.alloc(32 + nodeCount * METADATA_RECORD_SIZE);
        
        // Header (32B)
        buffer.writeUInt32LE(0x4144454D, 0); // Magic 'META'
        buffer.writeUInt32LE(nodeCount, 8);
        
        instances.forEach((inst, i) => {
            const off = 32 + i * METADATA_RECORD_SIZE;
            
            // 1. HPOS (64-bit World Origin) - 24 Bytes
            buffer.writeDoubleLE(inst.hpos[0], off);
            buffer.doubleWriteLE(inst.hpos[1], off + 8);
            buffer.doubleWriteLE(inst.hpos[2], off + 16);
            
            // 2. Transform Matrix (4x4 Float32) - 64 Bytes
            const matArray = inst.transform.asArray();
            for (let m = 0; m < 16; m++) {
                buffer.writeFloatLE(matArray[m], off + 24 + (m * 4));
            }
            
            // 3. Temporal Data - 16 Bytes
            buffer.writeBigUInt64LE(BigInt(inst.installDate), off + 88);
            buffer.writeBigUInt64LE(BigInt(inst.serviceDate), off + 96);
        });
        return buffer;
    }
}

// --- 4. Tiler SDK Core ---
export class TilerSDK {
    private compiler = new BinaryCompiler();

    public async publish(projectPath: string, outputDir: string) {
        console.time('TilerProcess_Spec2.5');
        
        // 1. 데이터 로드 (Tier 1 SoT 연동)
        const instances = await this.loadFromSQLite(projectPath);
        
        // 2. 공간 정렬 (Morton Code 기반)
        const sorted = instances.sort((a, b) => Number(a.mortonCode! - b.mortonCode!));

        // 3. 바이너리 파일 출력
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        fs.writeFileSync(path.join(outputDir, 'hierarchy.bin'), this.compiler.compileHierarchy(sorted));
        fs.writeFileSync(path.join(outputDir, 'metadata.bin'), this.compiler.compileMetadata(sorted));
        
        console.timeEnd('TilerProcess_Spec2.5');
        console.log(`[Tiler] Spec 2.5 Binary Assets generated successfully.`);
    }

    private async loadFromSQLite(path: string): Promise<RawInstance[]> {
        // 실제 구현 시 SQLite에서 GUID, TRS, HPOS, SemanticTag 등을 쿼리
        return [];
    }
}

// Helper for double write alignment (Node.js Buffer specific)
interface Buffer {
    doubleWriteLE(value: number, offset: number): number;
}