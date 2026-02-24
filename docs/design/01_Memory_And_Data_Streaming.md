Memory & Data Streaming (Phase 1 & 2)

Version: 2.5.0
Update: 2026-02-23

1. Global Assembly Array (VRAM Allocator)

GlobalBufferManager.ts는 대규모 데이터 처리를 위해 구동 시 대용량 GPUBufferUsage.STORAGE 배열을 사전 할당(Pre-allocation)합니다. 이는 800만 개 이상의 인스턴스를 관리하며, 런타임 중의 빈번한 메모리 재할당에 따른 지연(Latency)을 원천 차단합니다.

모든 저장소 포맷은 WebGPU std430 레이아웃 규칙에 따라 16바이트 정렬을 준수합니다:

instanceTRSBuffer: 각 인스턴스의 4x4 행렬 정보를 저장하는 Float32 SSBO (인스턴스당 16 floats).

batchIdBuffer: 개별 객체 식별을 위한 Uint32 BatchID 매핑 버퍼.

visibilityBuffer: Compute Shader가 기록하는 가시성 플래그 및 인다이렉션 인덱스 버퍼.

indirectDrawBuffer: 하드웨어 Indirect 호출을 위한 구조체 [indexCount, instanceCount, firstIndex, baseVertex, firstInstance].

2. Binary Tileset & GS-API Streaming

CustomTileParser.ts는 기존 JSON 기반의 비효율적인 파싱을 탈피하고, Spec 2.5의 tileset.bin 및 **GS-API(Geometry Streaming API)**를 활용합니다:

Memory-Mapped Parsing: tileset.bin의 이진 헤더를 로드하자마자 별도의 CPU 루프 없이 DataView 또는 mmap 방식으로 GPU Storage Buffer에 즉각 전송합니다.

Morton Order Locality: 데이터는 64-bit Morton Code로 정렬되어 저장되므로, 스트리밍 시 공간적으로 가까운 객체들이 메모리 상에서도 연속적으로 로드되어 캐시 히트율을 극대화합니다.

Fast Expansion: Quantization.ts를 통해 Int16/Uint16으로 압축된 좌표 데이터를 쉐이더 단계에서 즉시 복원하며, 전송량은 줄이되 조립 정밀도는 유지합니다.

Zero-Copy Memory Release: 스트리밍이 완료된 직후, CPU 측의 ArrayBuffer 및 Float32Array 객체를 명시적으로 null 처리하여 JavaScript 가비지 컬렉션(GC)을 유도하고 브라우저 OOM(Out of Memory) 현상을 방지합니다.

3. Asynchronous GPU Picking Core

PickingManager.ts는 렌더링 성능에 영향을 주지 않는 Asynchronous R32Uint Picking 시스템을 가동합니다.

Process: 별도의 Beauty Pass 이후, Fragment Shader가 색상이 아닌 순수 BatchID 정수를 R32Uint 포맷의 Picking 텍스처에 기록합니다.

Resolution: 사용자가 클릭한 1x1 픽셀 영역을 device.queue.copyTextureToBuffer를 통해 GPU 내부에서 처리합니다.

Non-blocking Readback: WebGPU의 buffer.mapAsync(READ)와 JavaScript의 Promise를 결합하여, CPU가 결과를 기다리며 멈추는(Blocking) 현상 없이 비동기적으로 객체 정보를 획득합니다.

4. WebGPU Indirect Batcher & Runtime Pipeline

WebGPUIndirectBatcher.ts는 IndirectRenderPlugin.ts를 통해 Babylon.js의 전통적인 순회 방식을 우회하고 하드웨어에 직접 명령을 내립니다.

// 단일 명령으로 8M 객체의 가시성이 판정된 리스트를 즉시 드로우
renderPass.drawIndexedIndirect(indirectDrawBuffer, 0);


CPU는 인스턴스 개수와 관계없이 단 1회의 Draw Call만을 수행하며, 모든 가시성(Culling)과 좌표 변환은 GPU 내부의 StorageBuffer와 Compute Shader에 의해 0ms 레이턴시로 해결됩니다.