import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, type CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { setSessionApiKey, getSessionApiKey } from "@/lib/opendart/client";
import { buildAllowlist, checkParams } from "@/lib/opendart/guard";
import { registerCompanyTools } from "./company";
import { registerDocumentTools } from "./document";
import { registerFinancialTools } from "./financial";
import { registerDisclosureTools } from "./disclosure";
import { registerShareholdingTools } from "./shareholding";
import { registerMajorEventTools } from "./major-events";
import { registerSecuritiesRegTools } from "./securities-reg";
import { registerWorkflowTools } from "./workflows";
import { registerPhase2Screen } from "./phase2-screen";

function registerConfigTools(server: McpServer) {
  server.tool(
    "set_api_key",
    "Set your OpenDART API key for this session. Get one free at https://opendart.fss.or.kr/ — once set, all tools will use it automatically. / OpenDART API 키를 설정합니다. https://opendart.fss.or.kr/ 에서 무료 발급 후 입력하세요.",
    { api_key: z.string().describe("Your OpenDART API key / OpenDART API 인증키") },
    async ({ api_key }) => {
      setSessionApiKey(api_key);
      return {
        content: [
          {
            type: "text" as const,
            text: "API key set successfully. All tools will now use this key. / API 키가 설정되었습니다. 이제 모든 도구에서 이 키를 사용합니다.",
          },
        ],
      };
    }
  );

  server.tool(
    "get_api_key_status",
    "Check whether an OpenDART API key is configured. / OpenDART API 키 설정 여부를 확인합니다.",
    {},
    async () => {
      const hasSession = !!getSessionApiKey();
      const hasEnv = !!process.env.OPENDART_API_KEY;

      let status: string;
      if (hasSession) {
        status = "Session API key is set (via set_api_key). / 세션 API 키가 설정되어 있습니다.";
      } else if (hasEnv) {
        status = "Server API key is configured (environment variable). / 서버 API 키가 설정되어 있습니다.";
      } else {
        status =
          "No API key configured. Call set_api_key with your key first. " +
          "Get one free at https://opendart.fss.or.kr/ / " +
          "API 키가 설정되지 않았습니다. set_api_key 도구를 먼저 호출하세요. " +
          "https://opendart.fss.or.kr/ 에서 무료로 발급받을 수 있습니다.";
      }

      return { content: [{ type: "text" as const, text: status }] };
    }
  );
}

/**
 * Reject unknown parameters before the SDK strips them — for every tool.
 *
 * McpServer validates each call with a non-strict schema, so a key the schema
 * doesn't know is dropped and the handler runs on defaulted arguments with no
 * error — the silent misfire behind the degeneration incident. That behavior is
 * shared by all tools (business_year→bsns_year, report_code→reprt_code, etc.),
 * so the guard covers all of them, not just get_document.
 *
 * The allowlist is derived from each tool's own registered Zod schema, so it
 * can't drift from what the SDK validates and new tools are covered for free.
 * The raw arguments are only visible before validation, so we wrap the
 * low-level tools/call handler: check the original keys, reject with a "did you
 * mean" hint, and otherwise delegate to the SDK's handler unchanged (its type
 * validation still runs).
 */
function installParamGuard(server: McpServer) {
  const allowlist = buildAllowlist(
    (server as unknown as { _registeredTools: Record<string, { inputSchema?: { shape?: Record<string, unknown> } }> })._registeredTools,
  );

  const low = (server as unknown as {
    server: {
      _requestHandlers: Map<string, (req: CallToolRequest, extra: unknown) => Promise<unknown>>;
      setRequestHandler: (schema: typeof CallToolRequestSchema, handler: (req: CallToolRequest, extra: unknown) => Promise<unknown>) => void;
    };
  }).server;

  const inner = low._requestHandlers.get("tools/call");
  if (!inner) {
    // Shouldn't happen once tools are registered; fail loud rather than run unguarded.
    throw new Error("installParamGuard: no tools/call handler to wrap");
  }

  low.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;
    const rawArgs = request.params.arguments as Record<string, unknown> | undefined;

    const problem = checkParams(toolName, rawArgs, allowlist[toolName]);
    if (problem) {
      return {
        content: [{ type: "text" as const, text: problem.message }],
        isError: true,
      };
    }

    return inner(request, extra);
  });
}

export function registerAllTools(server: McpServer) {
  registerConfigTools(server);         // API key configuration (first)
  registerWorkflowTools(server);       // Workflow tools (most useful)
  registerCompanyTools(server);        // Company search & info
  registerDocumentTools(server);       // Disclosure document full text
  registerFinancialTools(server);      // Financial statements & indicators
  registerDisclosureTools(server);     // Periodic report details
  registerShareholdingTools(server);   // Shareholding disclosures
  registerMajorEventTools(server);     // Major corporate events
  registerSecuritiesRegTools(server);  // Securities registration statements
  registerPhase2Screen(server);        // Multi-company phase-2 (TTM) screen

  // After every tool is registered, so the wrapped handler exists.
  installParamGuard(server);
}
