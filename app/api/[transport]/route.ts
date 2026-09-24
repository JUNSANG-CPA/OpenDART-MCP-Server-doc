import { createMcpHandler } from "mcp-handler";
import { registerAllTools } from "@/lib/tools";
import { setSessionApiKey } from "@/lib/opendart/client";

// Vercel function budget. vercel.json sets the same 60s; declaring it on the
// route keeps it with the code (opendart_phase2_screen makes up to ~25 DART
// calls per request).
export const maxDuration = 60;

const mcpHandler = createMcpHandler(
  (server) => {
    registerAllTools(server);
  },
  {
    capabilities: {},
  },
  {
    basePath: "/api",
    maxDuration: 60,
    verboseLogs: true,
  }
);

async function handler(req: Request) {
  const url = new URL(req.url);
  const apiKey = url.searchParams.get("opendart_key");
  if (apiKey) {
    setSessionApiKey(apiKey);
  }
  return mcpHandler(req);
}

export { handler as GET, handler as POST, handler as DELETE };
