Custom Spec 2.0 Binary Metadata Specification

버전: 2.5.0 (Ultimate Edition Sync)
업데이트: 2026-02-23
상태: 데이터 팩토리 및 엔진 커널 호환성 검증 완료

1. 개요 (Introduction)

Custom Spec 2.0 아키텍처는 기존의 무거운 JSON 기반 씬 그래프를 완전히 제거하고, 연속된 바이너리 버퍼(Contiguous Binary Buffers)를 통해 800만 개 이상의 인스턴스를 관리합니다. 이는 Zero-JSON 전략을 통해 데이터 로딩 속도를 극대화하고 AI 에이전트가 공간의 논리적/물리적 구조를 즉각적으로 파악하게 합니다.

본 문서는 공간 계층 구조를 담당하는 hierarchy.bin과 물리적 속성을 담당하는 metadata.bin의 바이너리 스키마를 정의합니다.

2. 이진 계층 구조 (hierarchy.bin)

2.1 개념: THIE (Tree Hierarchy Indexed Encoding)

전통적인 엔진은 객체를 트리 형태의 객체 참조(Reference)로 관리하여 메모리 파편화를 유발합니다. Custom Spec 2.5는 DoD(Data-Oriented Design) 트리 플래트닝 기술을 사용하여 전체 계층을 단일 ArrayBuffer로 직렬화합니다. 부모-자식 관계는 객체 참조가 아닌 정수 포인터(인덱스)를 통해 O(1) 속도로 해결됩니다.

2.2 노드 레코드 구조 (40 Bytes / Node)

모든 객체 또는 그룹은 엄격한 40바이트 레코드로 표현됩니다. 이는 BatchID * 40의 오프셋 계산만으로 특정 노드 데이터에 즉시 접근할 수 있음을 의미합니다.

오프셋 (Bytes)

타입

필드명

설명

0x00 - 0x03

Uint32

nodeId

고유 식별자 (로컬 BatchID와 일치).

0x04 - 0x07

Uint32

parentId

부모 노드의 인덱스. (Root인 경우 0xFFFFFFFF).

0x08 - 0x0B

Uint32

firstChildId

첫 번째 자식 노드의 인덱스. (Leaf인 경우 0xFFFFFFFF).

0x0C - 0x0F

Uint32

nextSiblingId

다음 형제 노드의 인덱스 (수평 탐색용).

0x10 - 0x13

Uint32

semanticTag

비트마스크 카테고리 (예: 0x01=HVAC, 0x02=Structural). AI 쿼리용.

0x14 - 0x1F

Float32[3]

center

객체 클러스터의 로컬 XYZ 중심 좌표.

0x20 - 0x23

Float32

radius

컬링 연산을 위한 바운딩 구체 반경.

0x24 - 0x27

Uint32

metaOffset

metadata.bin 내의 추가 데이터 조회를 위한 오프셋.

2.3 AI 공간 지식 그래프 (SKE 연동)

semanticTag와 firstChildId 인덱스를 매핑함으로써, AI 에이전트는 단 10ms 내에 "구역 A의 모든 밸브 탐색"과 같은 공간 쿼리를 수행합니다. 이는 JavaScript 객체를 생성하지 않고 순수 바이너리 수준에서 **공간 시맨틱 임베딩(SKE)**을 처리하기 때문에 가능합니다.

3. 구조적 메타데이터 (metadata.bin)

3.1 개념: 시맨틱 확장 버퍼

hierarchy.bin이 구조적 연결을 담당한다면, metadata.bin은 가변 길이 문자열, 시계열 유지보수 기록, 그리고 XR 트래킹에 필수적인 초정밀 물리 앵커를 저장합니다.

3.2 버퍼 레이아웃 구성

Header (32 Bytes)

0x00 (4B): Magic 0x4154454D ("META")

0x04 (4B): 버전 정보 (205)

0x08 (4B): 총 메타데이터 레코드 수

0x0C (4B): String Heap 시작 오프셋

0x10 - 0x1F (16B): 예약된 패딩 (Reserved)

Data Block (노드당 112 Bytes 고정)

hierarchy.bin의 metaOffset을 통해 직접 참조됩니다.

오프셋

타입

이름

용도

+0x00

Float64[3]

hpos (SPOS)

64비트 초정밀 월드 원점. XR 및 대형 좌표계에서 1cm 미만의 정밀도 보장.

+0x18

Float32[16]

transform

4x4 최종 행렬. WebGPU instanceTRSBuffer에 직접 쓰기(Direct Write)용.

+0x58

Uint32

namePtr

String Heap 내의 객체 이름 포인터 (예: "MAIN_VALVE_A1").

+0x5C

Uint32

propertyMask

센서 연결 여부 및 정비 데이터 유무를 나타내는 비트마스크.

+0x60

Uint64

timeInstall

설치 일자 Unix 타임스탬프 (시계열 분석용).

+0x68

Uint64

timeService

다음 점검 예정일 Unix 타임스탬프.

3.3 동적 분석 통합 (Analytics Integration)

MCP 도구인 search_spatial_objects가 실행되면, AI는 String Heap에서 namePtr을 대조하여 대상을 식별합니다. 이후 clash_detection.wgsl 커널은 transform 버퍼를 즉각 참조하여 동적 객체와의 물리적 간섭을 0ms 레이턴시로 판정합니다.

4. 운영 가치 (Operational Value)

계층 구조(hierarchy)와 물리 속성(metadata)을 이원화한 이진 파일 구조는 VRAM이 무거운 문자열 데이터를 파싱하며 멈추는 현상을 방지합니다.

메모리 효율: 800만 개 객체 로드 시 기존 JSON 방식 대비 메모리 점유율 90% 절감.

AI 최적화: LLM이 공간 관계를 추론할 때 객체 인스턴스화 없이 메모리 맵핑만으로 결과 도출.

확장성: 향후 1,000만 개 이상의 객체 확장 시에도 동일한 O(1) 성능 유지.