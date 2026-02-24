/**
 * Custom Spec 2.0 MCP 실전 연동 스크립트
 * AI Studio(LLM)가 엔진의 8M+ 데이터를 직접 제어하기 위한 브릿지 및 서버 명세입니다.
 */

// --- PART 1: MCP Server Definition (Node.js / Model Context Protocol) ---
// 이 섹션은 AI가 사용할 수 있는 '도구'들의 리스트를 정의합니다.

export const MCP_TOOLS = [
    {
        name: "search_spatial_objects",
        description: "Semantic Search API: 800만 개 객체 중 조건에 맞는 BatchID 리스트를 반환합니다. (예: 'PIPE 100A')",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "검색어 (토큰 단위 지원)" }
            },
            required: ["query"]
        }
    },
    {
        name: "navigate_to_object",
        description: "Navigation Core API: 특정 BatchID 또는 좌표로 카메라를 부드럽게 이동시킵니다.",
        parameters: {
            type: "object",
            properties: {
                batchId: { type: "number" },
                mode: { type: "string", enum: ["ORBIT", "WALK"], default: "ORBIT" }
            },
            required: ["batchId"]
        }
    },
    {
        name: "apply_visual_filter",
        description: "Appearance Manager API: 특정 객체 그룹에 X-ray, Ghost, Highlight 효과를 적용합니다.",
        parameters: {
            type: "object",
            properties: {
                batchIds: { type: "array", items: { type: "number" } },
                filterType: { type: "string", enum: ["GHOST", "XRAY", "HIGHLIGHT", "RESET"] }
            },
            required: ["batchIds", "filterType"]
        }
    },
    {
        name: "run_clash_safety_sweep",
        description: "Clash Detection API: 특정 동적 객체(크레인 등) 주변의 물리적 충돌 위험을 전수 조사합니다.",
        parameters: {
            type: "object",
            properties: {
                sourceBatchId: { type: "number", description: "충돌 검사 주체 ID" }
            }
        }
    }
];

// --- PART 2: Client-side Engine Bridge (Browser) ---
// 엔진 인스턴스와 MCP 서버의 명령을 매핑하는 브릿지 로직입니다.

export class MCPEngineBridge {
    constructor(private engineInstance: any) { }

    /**
     * MCP 서버로부터 온 도구 실행 명령을 처리합니다.
     */
    public async handleToolCall(toolName: string, args: any) {
        console.log(`[MCP] Tool Called: ${toolName}`, args);

        switch (toolName) {
            case "search_spatial_objects":
                // HierarchyPlugin의 검색 API 호출
                return this.engineInstance.plugins.hierarchy.search(args.query);

            case "navigate_to_object":
                // NavigationCore 호출
                const node = this.engineInstance.plugins.hierarchy.getNodeByBatchId(args.batchId);
                return this.engineInstance.managers.navigation.moveTo(node.spos, node.bounds);

            case "apply_visual_filter":
                // AppearanceManager 호출
                switch (args.filterType) {
                    case "GHOST": return this.engineInstance.managers.appearance.setGhostMode(args.batchIds);
                    case "HIGHLIGHT": return this.engineInstance.managers.appearance.setHighlight(args.batchIds);
                    case "RESET": return this.engineInstance.managers.appearance.resetAll();
                }
                break;

            case "run_clash_safety_sweep":
                // ClashDetectionManager 호출
                const results = await this.engineInstance.managers.clash.performSweep(args.sourceBatchId);
                return {
                    clashDetected: results.count > 0,
                    clashedIds: results.ids,
                    message: results.count > 0 ? "충돌 위험이 감지되었습니다." : "안전합니다."
                };
        }
    }
}

// --- PART 3: AI Studio 실전 테스트 시나리오 ---
/**
 * AI Studio에서 다음과 같이 입력하여 연동 테스트를 진행하십시오.
 * * [시나리오 1: 안전 진단]
 * "현재 구역에서 'PUMP'를 모두 찾아서 하이라이트하고, 주변 5m 이내에 설치된 크레인과 충돌 위험이 있는지 체크해줘."
 * * [AI의 사고 과정(Chain of Thought)]
 * 1. search_spatial_objects("PUMP") 호출 -> BatchID 리스트 확보
 * 2. apply_visual_filter(ids, "HIGHLIGHT") 호출 -> 시각화
 * 3. run_clash_safety_sweep(crane_id) 호출 -> 물리 간섭 체크
 * 4. 결과 보고: "PUMP-01 구역에 크레인 팔이 닿을 위험이 있습니다. X-ray 모드로 내부를 보여드릴까요?"
 */

export const AI_TEST_SCENARIO_PROMPT = `
당신은 Custom Spec 2.0 엔진을 제어하는 전문 AI 엔지니어입니다. 
사용 가능한 도구(search_spatial_objects, navigate_to_object, apply_visual_filter, run_clash_safety_sweep)를 활용하여 
사용자의 질의를 해결하십시오. 

모든 객체는 800만 개의 BatchID 체계로 관리되며, 모든 연산은 GPU에서 실시간으로 처리됩니다.
`;
