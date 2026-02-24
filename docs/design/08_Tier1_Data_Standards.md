Custom Spec 2.0: Tier 1 데이터 무결성 및 GAL 엄격 기준 (Strict Standards)

문서 번호: CS-T1-STD-2024-05-REV3
버전: 2.5.0 (Ultimate Edition Sync)
업데이트: 2026-02-23
적용 대상: Tiler Publisher, GAL Optimizer, SoT Database 전처리 파이프라인

1. 개요 (Introduction)

Custom Spec 2.0 엔진의 초고성능(8M+ Instances)과 AI 지능형 관제 성능은 데이터 원천인 **Tier 1 SoT(Source of Truth)**의 정밀도에 의존한다. 본 문서는 원본 CAD/BIM 데이터를 바이너리 타일셋으로 변환하기 전, 반드시 준수해야 할 물리적/논리적 무결성 표준을 정의한다. 본 표준을 미준수한 데이터는 Tiler SDK의 수용이 거부된다.

2. SoT (Source of Truth) Database 엄격 기준

엔진이 참조하는 모든 인스턴스의 데이터 원천(SQLite/PostgreSQL 등)은 다음 규격을 100% 만족해야 한다.

2.1 인스턴스 식별 및 시맨틱 무결성 (ID & Semantic Integrity)

GUID Lineage: 모든 인스턴스는 원천 설계 도구에서 부여된 고유 GUID를 유지해야 하며, 이는 metadata.bin의 featureId와 1:1 매핑되어 전 생애주기 이력 추적을 보장한다.

Hierarchical Tagging (L1-L3): 모든 객체는 최소 3단계 이상의 계층 태그를 포함해야 한다.

L1 (Site/Zone): 프로젝트 공간 대분류 (예: DOCK_01, ENGINE_ROOM)

L2 (System): 엔지니어링 계통 분류 (예: SYSTEM_FIRE_PUMP, HVAC_SUPPLY)

L3 (Part Type): 부품 속성 분류 (예: VALVE_GATE, PIPE_BEND)

AI Context Mapping: AI 에이전트가 자연어로 검색할 수 있도록 각 객체에 대한 'Human-readable Name'이 100% 존재해야 하며, 이는 String Heap에 기록된다.

2.2 좌표계 및 초정밀도 규격 (Coordinate Precision)

World Origin Alignment: 모든 데이터는 프로젝트 전역 원점(0,0,0)을 기준으로 한 절대 좌표(World Space)로 변환되어야 한다.

HPOS (High-Precision Origin): XR 트래킹 및 정밀 조립 검수를 위해 위치 데이터는 FP64 (64-bit Double) 정밀도로 SoT에 저장되어야 하며, 최종 metadata.bin 추출 시 1cm 미만의 실질 오차를 보장해야 한다.

Orthonormal Rotation: 회전 값은 사원수(Quaternion) 형태로 저장되어야 하며, 데이터 정규화(Normalization)를 통해 짐벌 락(Gimbal Lock)을 방지하고 상보성을 유지해야 한다.

3. GAL (Global Asset Library) .glb 생성 엄격 기준

GAL은 수백만 번 재활용되는 공유 자원이므로, 개별 자산의 최적화 상태가 전체 렌더링 프레임(FPS)의 임계값을 결정한다.

3.1 지오메트리 및 피벗 규격 (Mesh & Pivot Specs)

Pivot Point Alignment (Strict): 모든 GAL 자산의 로컬 원점(0,0,0)은 해당 부품의 기하학적 중심 또는 **설계상의 결합점(Point of Attachment)**에 위치해야 한다. 불일치 시 하이퍼 인스턴싱 단계에서 시각적 지터(Jitter)와 충돌 판정 오류가 발생한다.

Polygon Budgeting: - Micro Assets (밸브, 볼트 등): 2,000 Triangles 미만 권장.

Macro Assets (탱크, 엔진 블록 등): 15,000 Triangles 미만 권장.

Vertex Attributes: Normal, Tangent 데이터는 필수 포함한다. Vertex Color 및 사용하지 않는 UV 채널은 VRAM 점유 최소화를 위해 삭제한다.

3.2 텍스처 및 머티리얼 표준 (PBR Workflow)

Unified PBR: Metallic-Roughness 워크플로우를 준수한다.

Texture Packing: 전송 효율을 위해 Roughness(G), Metallic(B), Ambient Occlusion(R) 데이터를 하나의 RGB 텍스처 채널로 패킹(ORM Texture)하는 것을 원칙으로 한다.

4. Tier 1 지오메트리 유사도 분석 (Matching) 기준

퍼블리셔가 원본 모델에서 GAL 자산을 추출할 때 적용되는 엄격한 판정 알고리즘 기준이다.

4.1 유사도 판정 및 형상 스냅핑 (Similarity & Snapping)

Topology Hashing: 정점 수, 면 수, 정점 간 상대적 거리 해시를 생성하여 1차 필터링을 수행한다.

Similarity Threshold (98%): 형상 유사도가 98% 이상인 경우, 퍼블리셔는 미세한 모델링 오차를 무시하고 **GAL 표준 형상으로 강제 병합(Snap)**한다. 이는 드로콜(Draw Call)을 획기적으로 줄이는 하이퍼 인스턴싱의 핵심 동력이다.

Automatic Hole Detection: 폐쇄된 공간(Occluded Volume) 내부의 객체는 LOD 2 쉘(Shell) 추출 시 자동으로 제외 대상으로 마킹하여 스트리밍 부하를 줄인다.

5. 데이터 패키징 검증 (Automated Validation)

타일러 퍼블리싱 단계에서 다음 자동 검증 프로세스를 통과하지 못하면 최종 바이너리 생성이 중단된다.

[ ] Geometry Leakage Test: GAL 외부로 유출된 독립 지오메트리(Non-instanced)가 전체의 5% 미만인가?

[ ] Matrix Integrity: 모든 world_transform 행렬이 유효한(Non-singular) 행렬인가?

[ ] Morton Ordering: 8M 객체의 Morton Code가 64-bit 공간상에서 충돌 없이 완벽하게 정렬되어 AV-BVH 구축이 가능한가?

[ ] VRAM Budget Guard: GAL 전체 용량이 타겟 GPU 가용 VRAM의 20% 이내인가?

6. 결론 (Conclusion)

본 Tier 1 엄격 기준은 Custom Spec 2.5 지능형 공간 OS의 물리적 토대이다. 이 기준을 통과한 정제된 데이터만이 800만 개의 객체 사이를 1ms 만에 누비는 AI 에이전트와 WebGPU 엔진의 능력을 100% 이끌어낼 수 있으며, 현장 디지털 트윈의 데이터 신뢰도를 보장한다.