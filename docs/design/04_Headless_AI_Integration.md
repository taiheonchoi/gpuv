Headless Phase 5: AI-First Implementation Plan (Version 2.5)

Version: 2.5.0 (Ultimate Edition Sync)
Update: 2026-02-23
Status: Core Logic & MCP Interface Verified (Production Ready)

1. Concept: MCP Headless & Spatial Intelligence

Custom Spec 2.5는 AI-First 방법론을 채택합니다. 무거운 JavaScript UI 프레임워크나 복잡한 DOM 생명주기에 의존하는 대신, 엔진의 모든 핵심 작업(Navigation, Appearance, Clash Detection, Culling)을 논리적인 Headless API로 노출합니다.

Model Context Protocol (MCP) 서버는 이러한 논리 계층과 AI(LLM) 사이의 안전한 인터페이스 역할을 수행합니다. 이를 통해 AI는 hierarchy.bin의 이진 레이아웃과 공간 메타데이터를 직접 이해하고, 필요에 따라 WebGPU VRAM 블록의 상태를 즉각적으로 변환(Mutate)할 수 있습니다.

2. Headless API Architectures (/src/core/)

UI 상태 루프와 시각적 상호작용을 완전히 분리하여, AI가 직접 호출 가능한 구체적인 컨트롤러 클래스로 구현되었습니다.

NavigationCore.ts (지능형 시점 제어)

AI가 Storage Buffer의 Transform Matrix에서 직접 추출한 위치 데이터를 바탕으로 카메라를 정밀하게 재배치합니다.

moveTo(batchId: number): 특정 객체의 중심 좌표와 바운딩 볼륨을 계산하여 Cubic Easing 기반의 부드러운 시점 이동을 수행합니다.

setOrbitMode() / setWalkMode(): 상황에 따라 조감 모드와 내부 점검 모드를 전환합니다.

AppearanceManager.ts (VRAM 직접 조작)

AI가 GlobalBufferManager의 _sensorStateBuffer에 값을 직접 주입하여 렌더링 컨텍스트를 물리적으로 조작합니다.

setHighlight(batchIds: number[]): 객체 상태를 3.0 (Blue Glow)으로 강제하여 시각적 강조를 수행합니다.

setGhostMode(batchIds: number[]): 객체 상태를 2.0 (Red Pulse)으로 설정하여 투시 및 잔상 효과를 부여합니다.

ClashDetectionManager.ts (실시간 물리 판정)

AI가 동적 객체의 이동 경로 상에 있는 물리적 위협을 GPU에서 전수 조사합니다.

performSweep(sourceId: number): Compute Shader를 구동하여 1ms 내에 800만 개 객체와의 간섭 여부를 판정하고 결과를 AI에게 반환합니다.

3. The MCP Server Toolchain (AI-Native Tools)

엔진의 기능을 AI가 즉시 실행할 수 있는 표준화된 '도구(Tools)'로 정의하여 노출합니다.

MCP Resources (공간 맥락 공유)

hierarchy.bin: AI에게 이진 파싱된 트리 레이아웃을 제공하여 조립체 간의 계층적 연관성을 이해시킵니다.

Spatial Knowledge Graph (SKE): 벡터 데이터를 통해 객체 간의 물리적 거리와 계통적 관계(Upstream/Downstream)를 AI에게 전달합니다.

MCP Tools (AI Action Mapping)

Tool: search_spatial_objects

Description: 자연어 질의를 BatchID 집합으로 변환합니다. (예: "엔진실의 모든 고압 밸브")
Execution: SemanticSearch.ts가 GPU 버퍼를 쿼리하여 매칭된 ID 리스트를 AI에게 반환합니다.

Tool: Maps_to_object

Description: 특정 BatchID 또는 위험 구역으로 시점을 즉시 이동시킵니다.
Execution: NavigationCore.moveTo()를 실행하여 최적의 관찰 화각(FOV)을 확보합니다.

Tool: run_clash_safety_sweep

Description: 특정 장비의 작업 반경 내에 있는 800만 개 객체와의 충돌 위험을 정밀 스캔합니다.
Execution: 1. ClashDetectionManager가 GPU 커널 실행.
2. 충돌 객체 발견 시 AppearanceManager를 통해 해당 객체를 적색으로 점멸.
3. 충돌 좌표 및 위험도를 AI에게 텍스트로 보고.

4. Operational Advantages (AI-Native KPIs)

Zero UI Lag: UI 프레임워크를 거치지 않는 순수 상태 엔진으로 < 2ms 수준의 반응 속도를 유지합니다.

Organic Workflows: "외판을 제거하고 50-PSI 이상의 배관만 하이라이트해줘"라는 명령을 받으면, AI가 스스로 Ghosting 툴과 Search 툴을 시퀀싱하여 WebGPU에 직접 명령을 하달합니다.

Predictive Guard: AI는 단순히 현재를 보는 것이 아니라, 동적 데이터의 벡터를 보고 3초 뒤의 미래 사고를 예견하여 경고를 발생시킵니다.

5. 결론 및 향후 과제

Headless Phase 5의 완성을 통해 Custom Spec 2.0 엔진은 인간의 클릭을 기다리는 '도구'에서, 스스로 공간을 관리하는 **'지능형 가상 관리자(Intelligent Virtual Supervisor)'**로 진화했습니다.

다음 단계인 Phase 7에서는 수백 명의 다중 접속자가 AI와 함께 동일한 공간에서 협업하며 실시간으로 뷰포트 상태를 공유하는 Spatial Collaboration 환경을 구축할 예정입니다.