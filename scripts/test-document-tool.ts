/**
 * End-to-end check of opendart_get_document through a real MCP client/server
 * pair, with fetch stubbed to serve a DART-shaped ZIP. No API key needed.
 *
 * Usage: npm run test:document
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { zipSync, strToU8 } from "fflate";
import { registerAllTools } from "../lib/tools";

process.env.OPENDART_API_KEY = "test-key-not-real";

const SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<DOCUMENT>
<DOCUMENT-NAME ACODE="11011">사업보고서</DOCUMENT-NAME>
<COMPANY-NAME AREGCIK="00126380">삼성전자</COMPANY-NAME>
<BODY><LIBRARY>
<PART ATOC="Y">
<TITLE ATOC="Y">I. 회사의 개요</TITLE>
<SECTION-1><TITLE>1. 회사의 개요</TITLE><P>당사는 1969년 설립되었습니다.</P></SECTION-1>
<SECTION-1><TITLE>2. 회사의 연혁</TITLE>
<TABLE><TBODY>
<TR><TD><P>연도</P></TD><TD><P>내용</P></TD></TR>
<TR><TD><P>1969</P></TD><TD><P>설립</P></TD></TR>
</TBODY></TABLE>
</SECTION-1>
</PART>
<PART ATOC="Y">
<TITLE ATOC="Y">II. 사업의 내용</TITLE>
<SECTION-1><TITLE>1. 사업의 개요</TITLE><P>${"반도체 부문. ".repeat(400)}</P></SECTION-1>
</PART>
</LIBRARY></BODY>
</DOCUMENT>`;

/** A filing's ZIP also carries attachments, each its own document. */
const AUDIT = `<?xml version="1.0" encoding="utf-8"?>
<DOCUMENT>
<DOCUMENT-NAME ACODE="00760">감사보고서</DOCUMENT-NAME>
<COMPANY-NAME>삼성전자주식회사</COMPANY-NAME>
<BODY><LIBRARY><PART>
<TITLE>독립된 감사인의 감사보고서</TITLE>
<SECTION-1><TITLE>감사의견</TITLE><P>적정의견을 표명합니다.</P></SECTION-1>
</PART></LIBRARY></BODY>
</DOCUMENT>`;

const AUDIT_CONSOLIDATED = `<?xml version="1.0" encoding="utf-8"?>
<DOCUMENT>
<DOCUMENT-NAME ACODE="00761">연결감사보고서</DOCUMENT-NAME>
<COMPANY-NAME>삼성전자주식회사</COMPANY-NAME>
<BODY><LIBRARY><PART>
<TITLE>독립된 감사인의 연결감사보고서</TITLE>
<SECTION-1><TITLE>연결 감사의견</TITLE><P>연결재무제표에 대해 적정의견입니다.</P></SECTION-1>
</PART></LIBRARY></BODY>
</DOCUMENT>`;

const ERROR_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<result><status>013</status><message>조회된 데이타가 없습니다.</message></result>`;

/** Verbatim body the live API returns for a filing with no archive. */
const ERROR_BODY_014 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><result><status>014</status><message>파일이 존재하지 않습니다.</message></result>`;

/** Response's typings don't accept a bare Uint8Array view; hand it the buffer. */
function toBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

let requestCount = 0;
let lastUrl = "";
let serveError = false;
let errorBody = ERROR_BODY;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  lastUrl = String(input);
  requestCount++;
  if (serveError) {
    return new Response(toBody(strToU8(errorBody)), { status: 200 });
  }
  // Attachments come first in the archive: the main doc must be found by name,
  // not by position.
  const zipped = zipSync({
    "20240312000736_00760.xml": strToU8(AUDIT),
    "20240312000736.xml": strToU8(SAMPLE),
    "20240312000736_00761.xml": strToU8(AUDIT_CONSOLIDATED),
  });
  return new Response(toBody(zipped), { status: 200 });
}) as typeof realFetch;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

async function main() {
  const server = new McpServer({ name: "test", version: "0" });
  registerAllTools(server);

  const client = new Client({ name: "test-client", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  console.log("--- registration ---");
  const { tools } = await client.listTools();
  const doc = tools.find((t) => t.name === "opendart_get_document");
  check("tool registered", !!doc, true);
  check("tool count", tools.length, 85);
  check(
    "params",
    Object.keys(doc!.inputSchema.properties ?? {}).sort(),
    ["api_key", "attachment", "max_chars", "mode", "offset", "query", "rcept_no", "section"]
  );

  const call = async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: "opendart_get_document", arguments: args });
    const content = r.content as Array<{ text: string }>;
    return { text: content[0].text, isError: !!r.isError };
  };

  console.log("\n--- mode=toc (default) ---");
  const toc = await call({ rcept_no: "20240312000736" });
  console.log(toc.text);
  check("no error", toc.isError, false);
  check("endpoint url", lastUrl.includes("/api/document.xml?"), true);
  check("rcept_no passed", lastUrl.includes("rcept_no=20240312000736"), true);
  check("doc name in header", toc.text.includes("사업보고서 — 삼성전자"), true);
  check("lists sections", toc.text.includes("1. I. 회사의 개요"), true);
  check("toc has no body text", toc.text.includes("1969년 설립"), false);

  console.log("\n--- attachments listed in toc ---");
  check("lists all documents", toc.text.includes("이 접수번호에 포함된 문서 3개"), true);
  check("main report first", toc.text.includes("1. 사업보고서 (본문"), true);
  check("attachment listed", toc.text.includes("2. 감사보고서 (첨부"), true);
  check("consolidated attachment listed", toc.text.includes("3. 연결감사보고서 (첨부"), true);
  check("marks current document", toc.text.includes("← 현재 문서"), true);

  console.log("\n--- attachment by number ---");
  const att = await call({ rcept_no: "20240312000736", mode: "section", section: "감사의견", attachment: "2" });
  console.log(att.text);
  check("reads the attachment", att.text.includes("적정의견을 표명합니다"), true);
  check("header names attachment", att.text.includes("## 감사보고서"), true);

  console.log("\n--- attachment by name ---");
  const byName = await call({ rcept_no: "20240312000736", mode: "toc", attachment: "연결감사보고서" });
  check("selects by name", byName.text.includes("## 연결감사보고서"), true);
  check("its own toc", byName.text.includes("연결 감사의견"), true);

  console.log("\n--- attachment not found ---");
  const badAtt = await call({ rcept_no: "20240312000736", attachment: "없는첨부" });
  check("isError", badAtt.isError, true);
  check("lists available", badAtt.text.includes("2. 감사보고서"), true);

  console.log("\n--- caching ---");
  check("one fetch so far", requestCount, 1);
  await call({ rcept_no: "20240312000736", mode: "section", section: "2" });
  check("second call served from cache", requestCount, 1);

  console.log("\n--- mode=section by keyword ---");
  const sec = await call({ rcept_no: "20240312000736", mode: "section", section: "회사의 연혁" });
  console.log(sec.text);
  check("table rendered", sec.text.includes("1969 | 설립"), true);

  console.log("\n--- mode=section truncation ---");
  const trunc = await call({ rcept_no: "20240312000736", mode: "section", section: "사업의 개요", max_chars: 1000 });
  check("truncation flagged", trunc.text.includes("잘렸습니다"), true);
  check("respects cap (plus notice)", trunc.text.length < 1400, true);
  check("reports the next offset", /offset=\d+/.test(trunc.text), true);
  console.log(trunc.text.slice(-260));

  console.log("\n--- offset paging ---");
  const nextOffset = Number(trunc.text.match(/offset=(\d+)/)![1]);
  const page2 = await call({
    rcept_no: "20240312000736", mode: "section", section: "사업의 개요",
    offset: nextOffset, max_chars: 1000,
  });
  check("page 2 reports its window", page2.text.includes(`${(nextOffset + 1).toLocaleString("ko-KR")}–`), true);
  check("page 2 keeps the header", page2.text.includes("### "), true);

  // Walk the whole section to prove nothing is unreachable
  let cursor = 0;
  let pages = 0;
  let assembled = "";
  for (;;) {
    const p = await call({
      rcept_no: "20240312000736", mode: "section", section: "사업의 개요",
      offset: cursor, max_chars: 1000,
    });
    pages++;
    const body = p.text.split("\n\n").slice(1).join("\n\n").split("\n---\n")[0];
    assembled += body;
    const m = p.text.match(/이어서 보려면 offset=(\d+)/);
    if (!m || pages > 20) break;
    cursor = Number(m[1]);
  }
  console.log(`  walked ${pages} pages, assembled ${assembled.length} chars`);
  check("paging terminates", pages < 20, true);
  check("last page has no continuation", pages > 1, true);
  check("reached the tail", assembled.includes("반도체 부문."), true);

  console.log("\n--- mode=find ---");
  const found = await call({ rcept_no: "20240312000736", mode: "find", query: "반도체" });
  console.log(found.text.split("\n").slice(0, 8).join("\n"));
  check("no error", found.isError, false);
  check("reports hit count", /검색 결과: \d+건 \/ \d+개 섹션/.test(found.text), true);
  check("names the section", found.text.includes("1. 사업의 개요"), true);
  check("gives a runnable next call", found.text.includes('mode="section", section="'), true);
  check("groups by section, not a flat list", /— \d+건/.test(found.text), true);

  console.log("\n--- find hit offset actually lands on the match ---");
  const hit = found.text.match(/section="(\d+)", offset=(\d+)/)!;
  const landed = await call({
    rcept_no: "20240312000736", mode: "section",
    section: hit[1], offset: Number(hit[2]), max_chars: 1000,
  });
  const bodyStart = landed.text.split("\n\n")[2] ?? "";
  check("match is at the top of the window", bodyStart.trimStart().startsWith("반도체"), true);

  console.log("\n--- find scoped to a section ---");
  const scoped = await call({ rcept_no: "20240312000736", mode: "find", query: "설립", section: "회사의 개요" });
  check("scope reported", scoped.text.includes("범위: "), true);
  check("finds within scope", scoped.text.includes("1969년"), true);

  const scopedMiss = await call({ rcept_no: "20240312000736", mode: "find", query: "반도체", section: "2. 회사의 연혁" });
  check("scope excludes other sections", scopedMiss.text.includes("검색 결과 없음"), true);

  console.log("\n--- find with no matches ---");
  const none = await call({ rcept_no: "20240312000736", mode: "find", query: "존재하지않는키워드" });
  check("says so plainly", none.text.includes("검색 결과 없음"), true);
  check("not an error", none.isError, false);

  console.log("\n--- find in an attachment ---");
  const attFind = await call({ rcept_no: "20240312000736", mode: "find", query: "적정의견", attachment: "감사보고서" });
  check("searches the attachment", attFind.text.includes("적정의견"), true);
  check("next call keeps attachment", attFind.text.includes('attachment="감사보고서"'), true);

  console.log("\n--- find without query ---");
  const noQuery = await call({ rcept_no: "20240312000736", mode: "find" });
  check("isError", noQuery.isError, true);

  console.log("\n--- offset past the end ---");
  const beyond = await call({
    rcept_no: "20240312000736", mode: "section", section: "사업의 개요", offset: 999999,
  });
  check("explains instead of returning blank", beyond.text.includes("전체 길이를 넘었습니다"), true);

  console.log("\n--- mode=section not found ---");
  const missing = await call({ rcept_no: "20240312000736", mode: "section", section: "없는섹션" });
  check("isError", missing.isError, true);
  check("suggests options", missing.text.includes("사용 가능한 섹션"), true);

  console.log("\n--- mode=section without section arg ---");
  const noArg = await call({ rcept_no: "20240312000736", mode: "section" });
  check("isError", noArg.isError, true);

  console.log("\n--- mode=full ---");
  const full = await call({ rcept_no: "20240312000736", mode: "full" });
  check("includes body", full.text.includes("1969년 설립"), true);
  check("truncated by default cap", full.text.includes("잘렸습니다"), false);

  console.log("\n--- bad rcept_no rejected by schema ---");
  const bad = await call({ rcept_no: "123" });
  check("isError", bad.isError, true);

  console.log("\n--- OpenDART error body (013) ---");
  serveError = true;
  const err = await call({ rcept_no: "20240312000999" });
  console.log(err.text);
  check("isError", err.isError, true);
  check("maps status 013", err.text.includes("013"), true);
  check("friendly message", err.text.includes("조회된 데이터가 없습니다"), true);

  // 014 was unmapped and fell through to 900's "정의되지 않은 오류", which hides
  // the one thing the caller needs: whether to retry or give up.
  console.log("\n--- OpenDART error body (014, no archive) ---");
  errorBody = ERROR_BODY_014;
  const err14 = await call({ rcept_no: "20260810900582" });
  console.log(err14.text);
  check("isError", err14.isError, true);
  check("maps status 014", err14.text.includes("014"), true);
  check("says the file does not exist", err14.text.includes("파일이 존재하지 않습니다"), true);
  check("does not fall back to the 900 message", err14.text.includes("정의되지 않은 오류"), false);
  check("suggests retrying a recent filing", err14.text.includes("재시도"), true);
  // 014 covers both "not generated yet" and "never exists"; 20260810900582 came
  // back 014 with its document retrievable from the viewer, so the message must
  // not state absence as fact.
  check("says the API cannot tell the two cases apart", err14.text.includes("같은 코드로 반환"), true);
  check("points at the viewer for confirmation", err14.text.includes("DART 뷰어"), true);

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("CRASH:", err);
  process.exit(1);
});
