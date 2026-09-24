/**
 * opendart_phase2_screen checks. fetch is stubbed — no API key, no network.
 *
 * Usage: npm run test:phase2
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "../lib/tools";
import {
  judge, ttmPair, reportsFor, prevQuarter, render,
  type Store, type CorpRep, type Amt, type RC,
} from "../lib/tools/phase2-screen";

process.env.OPENDART_API_KEY = "test-key-not-real";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}
const near = (a: number | null, b: number) => a != null && Math.abs(a - b) < 1e-9;

// ─────────────── hand-checked scenario (units: 억원) ───────────────
// revenue  FY2024 400  FY2025 440   Q1 cum 24:95  25:100  26:110   H1 cum 24:190 25:200 26:240
// op       FY2024 40   FY2025 44    Q1 cum 24:9.5 25:10   26:10.5  H1 cum 24:19  25:20  26:30
//
// TTM(26Q2) = 440 + 240 − 200 = 480   base TTM(25Q2) = 400 + 200 − 190 = 410   → +17.07%
// TTM(26Q1) = 440 + 110 − 100 = 450   base TTM(25Q1) = 400 + 100 −  95 = 405   → +11.11%
// op TTM(26Q2) = 44 + 30 − 20 = 54    base = 40 + 20 − 19 = 41                  → +31.71%
// op TTM(26Q1) = 44 + 10.5 − 10 = 44.5 base = 40 + 10 − 9.5 = 40.5             → +9.88%
// prev: op 9.88 < rev 11.11 (not phase-2) · now: op 31.71 > rev 17.07 → NEW_ACCEL
const E = 1e8;
const REV = { fy: { 2024: 400, 2025: 440 }, cum: { "2024-1": 95, "2025-1": 100, "2026-1": 110, "2024-2": 190, "2025-2": 200, "2026-2": 240 } };
const OP = { fy: { 2024: 40, 2025: 44 }, cum: { "2024-1": 9.5, "2025-1": 10, "2026-1": 10.5, "2024-2": 19, "2025-2": 20, "2026-2": 30 } };
const RC_Q: Record<string, number> = { "11013": 1, "11012": 2 };

type Series = { fy: Record<number, number>; cum: Record<string, number> };
function amt(s: Series, y: number, rc: RC): Amt {
  if (rc === "11011") return { th: s.fy[y] * E, thCum: null, fr: s.fy[y - 1] * E, frCum: null };
  const q = RC_Q[rc];
  return { th: -1, thCum: s.cum[`${y}-${q}`] * E, fr: -1, frCum: s.cum[`${y - 1}-${q}`] * E };
}
const REPORTS: Array<[number, RC]> = [[2025, "11011"], [2026, "11012"], [2025, "11012"], [2026, "11013"], [2025, "11013"]];
function storeFor(corp: string, rev: Series, op: Series, fs: "CFS" | "OFS" = "CFS", drop?: string): Store {
  const s: Store = new Map();
  for (const [y, rc] of REPORTS) {
    if (drop === `${y}-${rc}`) continue;
    const rep: CorpRep = { CFS: {}, OFS: {} };
    rep[fs] = { rev: amt(rev, y, rc), op: amt(op, y, rc) };
    s.set(`${y}-${rc}`, new Map([[corp, rep]]));
  }
  return s;
}

console.log("=== periods ===");
check("prevQuarter(2026,1) wraps to 2025Q4", prevQuarter(2026, 1), [2025, 4]);
check("prevQuarter(2026,2)", prevQuarter(2026, 2), [2026, 1]);
check("reportsFor Q4 = the annual report only", reportsFor(2026, 4), [[2026, "11011"]]);
check("reportsFor Q2", reportsFor(2026, 2), [[2025, "11011"], [2026, "11012"], [2025, "11012"]]);

console.log("\n=== TTM formula (hand-checked) ===");
const st = storeFor("X", REV, OP);
const get = (y: number, rc: RC) => st.get(`${y}-${rc}`)?.get("X")?.CFS;
const r2 = ttmPair(get, 2026, 2, "rev"), r1 = ttmPair(get, 2026, 1, "rev");
const o2 = ttmPair(get, 2026, 2, "op"), o1 = ttmPair(get, 2026, 1, "op");
check("TTM rev 26Q2 = 480", r2.cur! / E, 480);
check("TTM rev 25Q2 base = 410", r2.base! / E, 410);
check("TTM rev 26Q1 = 450", r1.cur! / E, 450);
check("TTM rev 25Q1 base = 405", r1.base! / E, 405);
check("TTM op 26Q2 = 54", o2.cur! / E, 54);
check("TTM op 26Q1 = 44.5", o1.cur! / E, 44.5);
check("cumulative preferred over the quarter-alone field", r2.cur! > 0, true);

const vA = judge(st, "X", "가상", 2026, 2, 3);
check("status NEW_ACCEL", vA.status, "NEW_ACCEL");
check("cur rev growth +17.07%", near(vA.curRev, (480 / 410 - 1) * 100), true);
check("cur op growth +31.71%", near(vA.curOp, (54 / 41 - 1) * 100), true);
check("prev rev growth +11.11%", near(vA.prevRev, (450 / 405 - 1) * 100), true);
check("prev op growth +9.88%", near(vA.prevOp, (44.5 / 40.5 - 1) * 100), true);
check("QoQ also phase-2", vA.qoq, true);

// Q4: TTM is the annual figure itself, base is its comparative column
const q4: Store = new Map([["2026-11011", new Map([["X", { CFS: { rev: { th: 500, thCum: null, fr: 440, frCum: null }, op: { th: 60, thCum: null, fr: 44, frCum: null } }, OFS: {} }]])]]);
const q4get = (y: number, rc: RC) => q4.get(`${y}-${rc}`)?.get("X")?.CFS;
check("Q4 TTM = FY", ttmPair(q4get, 2026, 4, "rev"), { cur: 500, base: 440 });

console.log("\n=== status matrix ===");
// With every base fixed at 100, a quarter's cumulative of 50+g yields growth g%.
function flat(prevG: number, curG: number): Series {
  return { fy: { 2024: 100, 2025: 100 }, cum: { "2024-1": 50, "2025-1": 50, "2026-1": 50 + prevG, "2024-2": 50, "2025-2": 50, "2026-2": 50 + curG } };
}
const statusOf = (rev: [number, number], op: [number, number], fs: "CFS" | "OFS" = "CFS", drop?: string) =>
  judge(storeFor("X", flat(...rev), flat(...op), fs, drop), "X", "가상", 2026, 2, 3);

check("NEW_ACCEL: prev op≥0, not phase-2 → phase-2", statusOf([10, 10], [5, 20]).status, "NEW_ACCEL");
check("NEW_RECOVERY: prev op<0 → phase-2", statusOf([10, 10], [-5, 20]).status, "NEW_RECOVERY");
check("CONTINUE", statusOf([10, 10], [20, 20]).status, "CONTINUE");
check("LOST", statusOf([10, 10], [20, 5]).status, "LOST");
check("NONE", statusOf([10, 10], [5, 5]).status, "NONE");
const low = statusOf([10, 1], [5, 5]);
check("LOWREV flagged when rev growth < floor", [low.status, low.note], ["NEW_ACCEL", "LOWREV"]);
check("OFS used when CFS is absent", statusOf([10, 10], [5, 20], "OFS").fs, "OFS");
const miss = statusOf([10, 10], [5, 20], "CFS", "2025-11013");
check("missing report → NA", [miss.status, miss.note], ["NA", "보고서/계정 누락(결산월 상이·금융업 등)"]);
const neg = statusOf([10, 10], [5, -150]);
check("loss-making → NA", [neg.status, neg.note], ["NA", "영업이익 적자/기저 음수"]);

console.log("\n=== render ===");
const out = render([vA, neg], 2026, 2, "new", ["없는회사"]);
check("header names the quarter pair", out.includes("2026Q1 → 2026Q2"), true);
check("unresolved inputs listed", out.includes("코드 변환 실패: 없는회사"), true);
check("new mode shows the new-transition row", out.includes("| 가상 | CFS | 신규·가속 | +11.1 / +9.9 | +17.1 / +31.7 | ○ | 480 | 54 |  |"), true);
check("new mode lists NA separately", out.includes("판정불가: 가상(영업이익 적자/기저 음수)"), true);

// ─────────────── through the MCP server, fetch stubbed ───────────────
// Rows carry a decoy quarter-alone thstrm_amount so a formula that read it
// instead of the cumulative field would visibly break the expected row.
const SAMSUNG = "00126380";
function rows(y: number, rc: RC) {
  const mk = (s: Series, nm: string) => {
    const a = amt(s, y, rc);
    return {
      corp_code: SAMSUNG, stock_code: "005930", sj_div: "IS", fs_div: "CFS", account_nm: nm,
      thstrm_amount: rc === "11011" ? String(a.th) : "999", thstrm_add_amount: a.thCum == null ? undefined : String(a.thCum),
      frmtrm_amount: rc === "11011" ? String(a.fr) : "999", frmtrm_add_amount: a.frCum == null ? undefined : String(a.frCum),
    };
  };
  return [mk(REV, "매출액"), mk(OP, "영업이익"), { corp_code: SAMSUNG, sj_div: "BS", fs_div: "CFS", account_nm: "자산총계", thstrm_amount: "1" }];
}

let mode: "ok" | "rate-limit" | "no-data" = "ok";
let dartCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  dartCalls++;
  const y = Number(url.searchParams.get("bsns_year"));
  const rc = url.searchParams.get("reprt_code") as RC;
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
  if (mode === "rate-limit") return json({ status: "020", message: "요청 제한을 초과하였습니다." });
  if (mode === "no-data" && `${y}-${rc}` === "2025-11013") return json({ status: "013", message: "조회된 데이타가 없습니다." });
  return json({ status: "000", message: "정상", list: rows(y, rc) });
}) as typeof realFetch;

async function main() {
  const server = new McpServer({ name: "t", version: "0" });
  registerAllTools(server);
  const client = new Client({ name: "c", version: "0" });
  const [ct, st2] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st2), client.connect(ct)]);
  const call = async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: "opendart_phase2_screen", arguments: args });
    return { text: (r.content as Array<{ text: string }>)[0].text, isError: !!r.isError };
  };

  console.log("\n=== registration ===");
  const { tools } = await client.listTools();
  check("tool registered", tools.some((t) => t.name === "opendart_phase2_screen"), true);
  check("tool count 85", tools.length, 85);

  console.log("\n=== end to end, stubbed DART ===");
  dartCalls = 0;
  const res = await call({ items: "삼성전자, 005930, 00126380, 없는회사", year: 2026, quarter: 2, output: "all" });
  console.log(res.text);
  check("no error", res.isError, false);
  check("name, stock code and corp_code dedupe to one company", res.text.includes("대상 1 |"), true);
  check("unknown name reported, not dropped", res.text.includes("코드 변환 실패: 없는회사"), true);
  check("hand-checked row reproduced", res.text.includes("| 삼성전자 | CFS | 신규·가속 | +11.1 / +9.9 | +17.1 / +31.7 | ○ | 480 | 54 |  |"), true);
  check("5 reports × 1 batch = 5 DART calls", dartCalls, 5);

  console.log("\n=== a rate limit is an error, not 'missing reports' ===");
  mode = "rate-limit";
  const rl = await call({ items: "삼성전자", year: 2026, quarter: 2 });
  console.log(rl.text);
  check("isError", rl.isError, true);
  check("names status 020", rl.text.includes("020"), true);
  check("does not pose as a verdict table", rl.text.includes("판정불가"), false);

  console.log("\n=== 013 for one report → that company is NA ===");
  mode = "no-data";
  const nd = await call({ items: "삼성전자", year: 2026, quarter: 2, output: "all" });
  check("not an error", nd.isError, false);
  check("marked 판정불가 with the missing-report note", nd.text.includes("판정불가 |") && nd.text.includes("보고서/계정 누락"), true);

  console.log("\n=== guard covers the new tool ===");
  mode = "ok";
  const bad = await call({ items: "삼성전자", year: 2026, quarter: 2, quater: 2 });
  check("unknown parameter rejected", bad.isError, true);
  check("suggests quarter", bad.text.includes("did you mean 'quarter'"), true);

  globalThis.fetch = realFetch;
  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("CRASH:", e); process.exit(1); });
