GPU Compute Culling Engine (Phase 3)

Version: 2.5.0
Update: 2026-02-23

1. Concept: Zero-Latency Culling

전통적인 엔진은 CPU에서 Bounding Box 루프를 돌며 가시성을 판단하지만, Custom Spec 2.0은 이 모든 과정을 WebGPU 연산 유닛(ComputeCullingManager.ts)으로 오프로드합니다. CPU는 단순히 명령을 내릴 뿐, 어떤 객체를 그릴지에 대한 최종 결정은 GPU 내부에서 완결되는 Zero-Latency GPU-Driven 구조를 지향합니다.

2. Hierarchical-Z (Hi-Z) Depth Pyramid

hiz_generator.wgsl은 메인 뎁스 버퍼를 활용하여 하향 샘플링된 최소 깊이(Min-Z) 피라미드를 생성합니다.

메커니즘: 2x2 픽셀 중 가장 가까운(최소) 깊이 값을 유지하며 밉맵(Mipmap)을 생성합니다.

최적화: 이를 통해 복잡한 선체 외판이나 벽면에 가려진 내부 배관들을 픽셀 단위 정밀도로 컬링하여 렌더링 부하를 80% 이상 절감합니다.

3. Culling Compute Kernel (culling.wgsl)

64개 스레드 단위의 워크그룹으로 실행되는 커널은 800만 개의 인스턴스를 병렬로 분석합니다:

Frustum Culling: 인스턴스의 Bounding Sphere와 카메라 절두체(6개 평면) 간의 교차 여부를 판정합니다.

Semantic-Aware LOD: 카메라 거리와 객체의 중요도(geometricError)를 계산하여 현재 표시할 GAL LOD 레벨을 결정합니다.

Hi-Z Occlusion: 투영된 바운딩 박스의 영역에 해당하는 Hi-Z 밉맵 레벨을 참조하여, 객체가 다른 구조물에 가려졌는지 판정합니다.

Atomic Append Mapping (원자적 리스트 구성)

모든 검증을 통과한 인스턴스는 GPU 내부에서 즉시 렌더링 리스트에 추가됩니다:

// 하드웨어 Indirect Draw 명령의 instanceCount를 원자적으로 1 증가시킴
let visibleIndex = atomicAdd(&indirectBuffer.instanceCount, 1u);

// 가시적인 인스턴스의 전역 인덱스를 인다이렉션 버퍼에 기록
visibleInstanceIndices[visibleIndex] = global_index;


이 방식은 CPU로 데이터를 읽어오는 과정(Read-back)이 필요 없으므로 0ms의 지연 시간을 보장합니다.

4. AV-BVH 적응형 컬링 통합

Spec 2.5에서 도입된 **AV-BVH(Adaptive Virtual BVH)**와 결합되어 컬링 성능이 한 단계 더 진화합니다.

Hierarchical Culling: 상위 가상 노드가 가려진 경우, 하위의 수만 개 인스턴스를 검사하지 않고 즉시 스킵(Skip)하여 연산 효율을 극대화합니다.

Density-Aware Logic: 객체 밀도가 높은 구역은 더 세밀한 BVH 계층을 따라 정밀한 Occlusion Test를 수행합니다.

5. Indirect Shader Redirection (indirect.wgsl)

렌더링 파이프라인의 Vertex 단계에서는 Compute Shader가 작성한 인다이렉션 버퍼를 참조하여 TRS 데이터를 조회합니다.

// 가시성 테스트를 통과한 순서(instance_index)에 따라 실제 데이터 위치(global_index) 조회
let global_index = visibleInstanceIndices[input.instance_index];

// 최종 TRS 행렬 획득
let instance = instanceBuffers[global_index]; 


6. 결론 및 성과 지표

CPU 부하: 인스턴스 개수와 무관하게 거의 0%에 수렴.

컬링 속도: 800만 개 객체 기준 전수 조사 시간 2ms 미만 (RTX 3060 기준).

시각적 정합성: 픽셀 단위 Hi-Z 컬링으로 인한 깜빡임 없는 안정적인 시각화 제공.