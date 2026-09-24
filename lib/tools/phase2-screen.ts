/**
 * opendart_phase2_screen — 2국면 전환 판정 도구
 *
 * 목적
 *   여러 종목의 TTM 매출액·영업이익을 서버 안에서 계산해
 *   "직전 분기 2국면 미충족 → 대상 분기 충족" 여부를 회사당 한 줄로 반환한다.
 *   원자료(재무상태표·연결/별도 전체)를 모델 컨텍스트에 싣지 않는 것이 핵심.
 *
 * 판정 정의 (기본값)
 *   TTM(Y,q)      = FY(Y-1) + 누계(Y,q) − 누계(Y-1,q)        (q=4이면 FY(Y))
 *   YoY 증가율     = TTM(Y,q) / TTM(Y-1,q) − 1  (기저 ≤ 0이면 판정 불가)
 *   2국면          = 영업이익 증가율 > 매출액 증가율
 *   신규 전환      = 직전 분기 미충족 & 대상 분기 충족
 *     - NEW_ACCEL    : 직전 분기 영업이익 증가율 ≥ 0 (가속형)
 *     - NEW_RECOVERY : 직전 분기 영업이익 증가율 < 0 (회복형)
 *   QoQ 참고열     = TTM(Y,q) vs TTM(직전 분기) 기준으로도 2국면인지
 *   LOWREV 플래그  = 대상 분기 매출 증가율 < rev_floor(기본 3%)
 *
 * DART 호출량
 *   fnlttMultiAcnt(100개사/회) × 필요한 보고서 5종 × ceil(N/100)
 *   예) 444개사, 26Q2 판정 → 5종 × 5묶음 = 25회
 *
 * 이 저장소에 맞춘 차이 (판정 로직은 원본 그대로)
 *   - API 키: DART_API_KEY 대신 resolveApiKey — 커넥터 URL(?opendart_key=),
 *     set_api_key, OPENDART_API_KEY를 모두 인식한다. DART_API_KEY만 읽으면
 *     URL로 키를 넘기는 배포본에서 모든 호출이 "키가 없습니다"로 끝난다.
 *   - 종목 인덱스: 요청마다 corpCode.xml(3.4MB)을 받지 않고, CI가 매주
 *     갱신하는 data/corp-codes.json을 쓴다(60초 예산 보호).
 *   - DART 호출: getJson 경유. 013(보고서 미제출)만 "데이터 없음"으로 보고,
 *     키 오류·한도 초과(010/020/800 등)는 에러로 올린다. 원본처럼 000이
 *     아니면 빈 결과로 넘기면, 한도 초과가 전 종목 "보고서/계정 누락"
 *     판정으로 둔갑해 틀린 스크리닝 결과가 정상처럼 보인다.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getJson, resolveApiKey } from "@/lib/opendart/client";
import { formatApiError, isNoData } from "@/lib/opendart/errors";
import { getListedCorpIndex, type ListedCorpIndex } from "@/lib/opendart/cache";

export type RC = "11013" | "11012" | "11014" | "11011";
const RC_OF_Q: Record<number, RC> = { 1: "11013", 2: "11012", 3: "11014", 4: "11011" };

export interface Amt { th: number | null; thCum: number | null; fr: number | null; frCum: number | null }
export interface Stmt { rev?: Amt; op?: Amt }
export interface CorpRep { CFS: Stmt; OFS: Stmt }
/** key: `${year}-${reprt_code}` → corp_code → 계정값 */
export type Store = Map<string, Map<string, CorpRep>>;

const REV_NAMES = new Set(["매출액", "영업수익", "수익(매출액)", "매출"]);
const OP_NAMES = new Set(["영업이익", "영업이익(손실)"]);

const num = (s?: string | null): number | null => {
  if (s == null) return null;
  const t = String(s).replace(/,/g, "").trim();
  if (t === "" || t === "-") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};

// ───────────────────────── 기간 계산 (순수 함수) ─────────────────────────

export const prevQuarter = (y: number, q: number): [number, number] => (q === 1 ? [y - 1, 4] : [y, q - 1]);

/** (Y,q)의 TTM과 YoY 기저 계산에 필요한 보고서 목록 */
export function reportsFor(y: number, q: number): Array<[number, RC]> {
  if (q === 4) return [[y, "11011"]];
  return [[y - 1, "11011"], [y, RC_OF_Q[q]], [y - 1, RC_OF_Q[q]]];
}

const cumTh = (a?: Amt) => (a ? a.thCum ?? a.th : null);
const cumFr = (a?: Amt) => (a ? a.frCum ?? a.fr : null);
const add = (...xs: Array<number | null>) => (xs.some((x) => x == null) ? null : (xs as number[]).reduce((s, x) => s + x, 0));

/** TTM(Y,q)와 TTM(Y-1,q). 전기 누계는 최신 보고서의 비교표시값을 사용(재작성 반영) */
export function ttmPair(get: (y: number, rc: RC) => Stmt | undefined, y: number, q: number, key: "rev" | "op") {
  if (q === 4) {
    const A = get(y, "11011")?.[key];
    return { cur: A?.th ?? null, base: A?.fr ?? null };
  }
  const rc = RC_OF_Q[q];
  const A = get(y - 1, "11011")?.[key];
  const R = get(y, rc)?.[key];
  const R1 = get(y - 1, rc)?.[key];
  const cur = add(A?.th ?? null, cumTh(R), cumFr(R) == null ? null : -(cumFr(R) as number));
  const base = add(A?.fr ?? null, cumFr(R), cumFr(R1) == null ? null : -(cumFr(R1) as number));
  return { cur, base };
}

const growth = (cur: number | null, base: number | null) =>
  cur == null || base == null || base <= 0 || cur <= 0 ? null : (cur / base - 1) * 100;

export interface Verdict {
  corp: string; name: string; fs: "CFS" | "OFS" | "-";
  prevRev: number | null; prevOp: number | null; curRev: number | null; curOp: number | null;
  qoq: boolean | null; ttmRev: number | null; ttmOp: number | null;
  status: "NEW_ACCEL" | "NEW_RECOVERY" | "CONTINUE" | "LOST" | "NONE" | "NA"; note: string;
}

export function judge(store: Store, corp: string, name: string, y: number, q: number, revFloor: number): Verdict {
  const [py, pq] = prevQuarter(y, q);
  const need = [...reportsFor(y, q), ...reportsFor(py, pq)];
  const has = (fs: "CFS" | "OFS") =>
    need.every(([yy, rc]) => { const s = store.get(`${yy}-${rc}`)?.get(corp)?.[fs]; return s?.rev && s?.op; });
  const fs: "CFS" | "OFS" | null = has("CFS") ? "CFS" : has("OFS") ? "OFS" : null;
  const blank: Verdict = { corp, name, fs: "-", prevRev: null, prevOp: null, curRev: null, curOp: null,
    qoq: null, ttmRev: null, ttmOp: null, status: "NA", note: "" };
  if (!fs) return { ...blank, note: "보고서/계정 누락(결산월 상이·금융업 등)" };

  const get = (yy: number, rc: RC) => store.get(`${yy}-${rc}`)?.get(corp)?.[fs];
  const rC = ttmPair(get, y, q, "rev"), oC = ttmPair(get, y, q, "op");
  const rP = ttmPair(get, py, pq, "rev"), oP = ttmPair(get, py, pq, "op");
  const v: Verdict = { ...blank, fs,
    curRev: growth(rC.cur, rC.base), curOp: growth(oC.cur, oC.base),
    prevRev: growth(rP.cur, rP.base), prevOp: growth(oP.cur, oP.base),
    ttmRev: rC.cur, ttmOp: oC.cur };

  if (v.curRev == null || v.curOp == null || v.prevRev == null || v.prevOp == null) {
    const neg = [oC.cur, oC.base, oP.cur, oP.base].some((x) => x != null && x <= 0);
    return { ...v, status: "NA", note: neg ? "영업이익 적자/기저 음수" : "증가율 계산 불가" };
  }
  const qr = growth(rC.cur, rP.cur), qo = growth(oC.cur, oP.cur);
  v.qoq = qr == null || qo == null ? null : qo > qr;

  const nowOk = v.curOp > v.curRev, prevOk = v.prevOp > v.prevRev;
  v.status = nowOk && !prevOk ? (v.prevOp >= 0 ? "NEW_ACCEL" : "NEW_RECOVERY")
    : nowOk && prevOk ? "CONTINUE" : !nowOk && prevOk ? "LOST" : "NONE";
  if (nowOk && v.curRev < revFloor) v.note = "LOWREV";
  return v;
}

// ───────────────────────── DART I/O ─────────────────────────

interface MultiAcntRow {
  corp_code?: string; stock_code?: string; sj_div?: string; account_nm?: string; fs_div?: string;
  thstrm_amount?: string; thstrm_add_amount?: string; frmtrm_amount?: string; frmtrm_add_amount?: string;
}

/**
 * One fnlttMultiAcnt call for up to 100 companies. 013 (report not filed) is an
 * empty result; every other non-000 status throws through getJson, so a key
 * error or rate limit surfaces instead of posing as missing reports.
 */
async function fetchMulti(key: string, corps: string[], y: number, rc: RC, idx: ListedCorpIndex) {
  const out = new Map<string, CorpRep>();
  const j = await getJson("fnlttMultiAcnt", { corp_code: corps.join(","), bsns_year: String(y), reprt_code: rc }, key);
  if (isNoData(j.status as string)) return out;
  for (const it of (j.list ?? []) as MultiAcntRow[]) {
    if (it.sj_div !== "IS") continue;
    const corp = it.corp_code ?? (it.stock_code ? idx.byStock.get(it.stock_code) : undefined);
    if (!corp) continue;
    const k = it.account_nm && REV_NAMES.has(it.account_nm) ? "rev" : it.account_nm && OP_NAMES.has(it.account_nm) ? "op" : null;
    if (!k) continue;
    const fs = it.fs_div === "CFS" ? "CFS" : "OFS";
    const rep = out.get(corp) ?? { CFS: {}, OFS: {} };
    if (!rep[fs][k]) rep[fs][k] = { th: num(it.thstrm_amount), thCum: num(it.thstrm_add_amount),
      fr: num(it.frmtrm_amount), frCum: num(it.frmtrm_add_amount) };
    out.set(corp, rep);
  }
  return out;
}

async function pool<T>(tasks: Array<() => Promise<T>>, n = 4) {
  const res: T[] = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < tasks.length) { const k = i++; res[k] = await tasks[k](); } }));
  return res;
}

// ───────────────────────── 출력 ─────────────────────────

const pct = (x: number | null) => (x == null ? "-" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}`);
const eok = (x: number | null) => (x == null ? "-" : Math.round(x / 1e8).toLocaleString("ko-KR"));
const LABEL: Record<Verdict["status"], string> = { NEW_ACCEL: "신규·가속", NEW_RECOVERY: "신규·회복",
  CONTINUE: "유지", LOST: "이탈", NONE: "미충족", NA: "판정불가" };

export function render(vs: Verdict[], y: number, q: number, output: "new" | "all", unresolved: string[]) {
  const [py, pq] = prevQuarter(y, q);
  const cnt = (s: Verdict["status"]) => vs.filter((v) => v.status === s).length;
  const lines = [
    `2국면 전환 판정 · ${py}Q${pq} → ${y}Q${q} · TTM YoY · [1차] DART fnlttMultiAcnt`,
    `대상 ${vs.length} | 신규·가속 ${cnt("NEW_ACCEL")} | 신규·회복 ${cnt("NEW_RECOVERY")} | 유지 ${cnt("CONTINUE")} | 이탈 ${cnt("LOST")} | 미충족 ${cnt("NONE")} | 판정불가 ${cnt("NA")}`,
  ];
  if (unresolved.length) lines.push(`코드 변환 실패: ${unresolved.join(", ")}`);
  const rows = vs.filter((v) => output === "all" || v.status === "NEW_ACCEL" || v.status === "NEW_RECOVERY");
  lines.push("", `| 종목 | 기준 | 판정 | 직전 매출/영익(%) | 대상 매출/영익(%) | QoQ | TTM매출(억) | TTM영익(억) | 비고 |`,
    `|---|---|---|---|---|---|---|---|---|`);
  for (const v of rows.sort((a, b) => a.status.localeCompare(b.status)))
    lines.push(`| ${v.name} | ${v.fs} | ${LABEL[v.status]} | ${pct(v.prevRev)} / ${pct(v.prevOp)} | ${pct(v.curRev)} / ${pct(v.curOp)} | ${v.qoq == null ? "-" : v.qoq ? "○" : "×"} | ${eok(v.ttmRev)} | ${eok(v.ttmOp)} | ${v.note} |`);
  if (output === "new") {
    const na = vs.filter((v) => v.status === "NA");
    if (na.length) lines.push("", `판정불가: ${na.map((v) => `${v.name}(${v.note})`).join(", ")}`);
  }
  return lines.join("\n");
}

// ───────────────────────── MCP 등록 ─────────────────────────

export function registerPhase2Screen(server: McpServer) {
  server.registerTool(
    "opendart_phase2_screen",
    {
      title: "2국면 전환 판정 (Phase-2 Screen)",
      description:
        "여러 종목의 2국면(TTM 영업이익 증가율 > TTM 매출액 증가율) 전환 여부를 서버에서 계산해 회사당 한 줄로 반환한다. " +
        "items에 종목명·6자리 종목코드·8자리 corp_code를 섞어 넣을 수 있다(최대 500). 원자료 재무표를 가져오지 않으므로 대량 스크리닝은 반드시 이 도구를 쓴다.",
      inputSchema: {
        items: z.string().describe("쉼표/줄바꿈 구분. 종목명(정확 일치), 종목코드 6자리, corp_code 8자리 혼용 가능"),
        year: z.number().int().describe("대상 분기의 연도 (예: 2026)"),
        quarter: z.number().int().min(1).max(4).describe("대상 분기 (1~4). 직전 분기와 비교해 전환 여부 판정"),
        output: z.enum(["new", "all"]).default("new").describe("new=신규 전환 종목만 표로, all=전 종목"),
        rev_floor: z.number().default(3).describe("대상 분기 매출 증가율이 이 값(%) 미만이면 LOWREV 표시"),
        api_key: z.string().optional().describe("Optional: your own OpenDART API key"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (a) => {
      try {
        const key = resolveApiKey(a.api_key);
        const idx = getListedCorpIndex();

        const corps: string[] = [], unresolved: string[] = [];
        for (const raw of a.items.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) {
          const c = /^\d{8}$/.test(raw) ? raw : /^[0-9A-Z]{6}$/.test(raw) ? idx.byStock.get(raw)
            : (idx.byName.get(raw)?.length === 1 ? idx.byName.get(raw)![0] : undefined);
          if (c && idx.byCorp.has(c)) { if (!corps.includes(c)) corps.push(c); }
          else unresolved.push(raw);
        }
        if (corps.length > 500) return { content: [{ type: "text" as const, text: "한 번에 최대 500개까지 처리합니다." }] };

        const [py, pq] = prevQuarter(a.year, a.quarter);
        const reports = [...reportsFor(a.year, a.quarter), ...reportsFor(py, pq)]
          .filter(([y, rc], i, arr) => arr.findIndex(([y2, rc2]) => y2 === y && rc2 === rc) === i);
        const batches = Array.from({ length: Math.ceil(corps.length / 100) }, (_, i) => corps.slice(i * 100, i * 100 + 100));

        const store: Store = new Map();
        const tasks = reports.flatMap(([y, rc]) => batches.map((b) => async () => {
          const m = await fetchMulti(key, b, y, rc, idx);
          const k = `${y}-${rc}`; const s = store.get(k) ?? new Map<string, CorpRep>(); m.forEach((v, c) => s.set(c, v)); store.set(k, s);
        }));
        await pool(tasks, 4);

        const verdicts = corps.map((c) => judge(store, c, idx.byCorp.get(c)!.name, a.year, a.quarter, a.rev_floor));
        return { content: [{ type: "text" as const, text: render(verdicts, a.year, a.quarter, a.output, unresolved) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatApiError(err) }], isError: true };
      }
    },
  );
}
