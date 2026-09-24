# OpenDART MCP Server

한국 금융감독원 [OpenDART API](https://opendart.fss.or.kr/)를 Claude에서 바로 사용할 수 있는 MCP(Model Context Protocol) 서버입니다.

API를 발급받아 Claude 커스텀 커넥터로 바로 연결할 수 있습니다.

## Features

- **Open DART API 전부 지원**: Open DART에서 제공하는 API를 전부 지원합니다 (도구 85개).
- **2국면 스크리닝**: 최대 500종목의 TTM 매출·영업이익 증가율을 서버에서 계산해 회사당 한 줄로 판정합니다 (`opendart_phase2_screen`).
- **공시 원문 조회**: 사업보고서 등 원문(document.xml)을 목차/섹션 단위로 나눠서 읽습니다.
- **Vercel 배포**: ngrok/터널링 없이 커스텀 커넥터로 바로 연결 가능합니다.
- **URL 기반 API 키**: 커넥터 URL에 키를 포함하여 설정 없이 즉시 사용 가능합니다.
- **마크다운 출력**: Claude에서 깔끔하게 렌더링되는 테이블 형태로 출력합니다.
- **Corp Code 캐싱**: 11만+ 기업 목록을 인메모리 캐싱

## 기업 목록 갱신

회사 검색은 `data/corp-codes.json`(11만+ 기업의 이름 ↔ 고유번호 대조표)을 읽습니다.
스냅샷이라 **갱신하지 않으면 신규 상장사를 찾지 못합니다.**

매주 월요일 06:00(KST)에 GitHub Actions가 자동으로 갱신합니다
([`.github/workflows/update-corp-codes.yml`](.github/workflows/update-corp-codes.yml)).
Actions 탭에서 수동 실행(`Run workflow`)도 가능합니다.

**설정**: 저장소 `Settings → Secrets and variables → Actions`에
`OPENDART_API_KEY` 시크릿을 등록해야 합니다.

로컬에서 갱신하려면:

```bash
OPENDART_API_KEY=your_key npm run update-corp-codes   # 또는 .env에 키 저장
```

스크립트는 **쓰기 전에 검증**합니다. 기업 수가 비정상적으로 적거나, 이전보다 10% 이상 줄었거나,
종목코드 형식이 깨졌으면(예: 앞자리 0 탈락) 파일을 건드리지 않고 실패합니다.

## Quick Start

### 1. OpenDART API 키 발급

[OpenDART](https://opendart.fss.or.kr/)에서 회원가입 후 API 인증키를 발급받으세요.

### 2. Claude에 연결

1. [claude.ai](https://claude.ai) 접속
2. 사용자 지정 > 커넥터 > 사용자 지정 커넥터 추가
3. URL 입력: `https://your-project.vercel.app/api/mcp?opendart_key=YOUR_API_KEY`
4. 연결 완료! 별도 설정 없이 바로 사용 가능

## Tools

### Config (2개)

| Tool | 설명 |
|------|------|
| `set_api_key` | OpenDART API 키를 세션에 설정 |
| `get_api_key_status` | API 키 설정 여부 확인 |

### 회사 검색 & 정보 (3개)

| Tool | 설명 |
|------|------|
| `opendart_search_company` | 한글/영문 이름 또는 종목코드로 회사 검색 → corp_code 획득 |
| `opendart_get_company_info` | 기업 개황 (대표이사, 주소, 업종 등) |
| `opendart_search_disclosure` | 공시 검색 (기간, 유형, 페이지네이션) |

### 공시 원문 (1개)

| Tool | 설명 |
|------|------|
| `opendart_get_document` | 공시 원문 조회 (접수번호 기준). 원문이 수 MB라 목차 → 섹션 순으로 나눠서 읽습니다. |

원문은 ZIP으로 내려받아 압축을 풀고, XML 태그를 제거해 읽기 좋은 텍스트로 변환합니다. 표는 `A | B` 형태로 표시됩니다.

| mode | 설명 |
|------|------|
| `toc` (기본값) | 섹션 제목 목록과 각 섹션 분량, 첨부 문서 목록. **여기서 시작하세요.** |
| `find` | `query` 키워드가 어디 있는지 검색. 섹션별로 묶어 건수와 위치를 알려줍니다. |
| `section` | 목차 번호(`"3"`) 또는 제목 키워드(`"사업의 내용"`)로 한 섹션만 조회 |
| `full` | 원문 전체. 짧은 공시용이며, 길면 잘립니다. |

`find` 결과는 그대로 다음 호출이 됩니다:

```
"충당부채" 검색 결과: 41건 / 5개 섹션 — 범위: 전체 문서

1. #24 3. 연결재무제표 주석 — 19건
   …주석 20 : 충당부채의 측정의 주요 가정…
   → mode="section", section="24", offset=3279
2. #30 5. 재무제표 주석 — 17건
   ...
```

하나의 접수번호에는 본문과 첨부 문서가 함께 들어 있습니다 (사업보고서 → 감사보고서, 연결감사보고서).
`mode="toc"`가 목록을 보여주며 `attachment="2"` 또는 `attachment="감사보고서"`로 골라 읽습니다.

응답은 `max_chars`(기본 20,000 / 최대 50,000)로 제한되며, 잘린 경우 전체 분량과 다음 `offset`을 함께 안내합니다.
`offset`으로 이어 읽으면 아무리 긴 섹션도 끝까지 읽을 수 있습니다.

> 주석 구조는 회사마다 다릅니다. 대기업은 주석마다 제목이 있어 `section`으로 바로 선택되지만,
> 중소형사는 주석 전체가 한 섹션에 뭉쳐 있습니다(예: 비나텍 사업보고서, 약 74,000자).
> 이때는 `find`로 위치를 찾은 뒤 그 `offset`부터 읽으세요.

### 재무 정보 (7개)

| Tool | 설명 |
|------|------|
| `opendart_single_financial_accounts` | 단일회사 주요계정 (매출, 영업이익, 자산 등) |
| `opendart_multi_financial_accounts` | 다중회사 주요계정 비교 (최대 100개) |
| `opendart_full_financial_statement` | 전체 재무제표 (BS, IS, CF 전 항목) |
| `opendart_single_financial_index` | 단일회사 재무지표 (수익성, 안정성, 성장성) |
| `opendart_multi_financial_index` | 다중회사 재무지표 비교 |
| `opendart_xbrl_taxonomy` | XBRL 표준 계정과목 분류 |
| `opendart_dividend_info` | 배당 관련 정보 |

### 정기보고서 세부 항목 (24개)

| Category | Tools | 설명 |
|----------|-------|------|
| 주주 | 3 | 최대주주, 최대주주 변동, 소액주주 현황 |
| 임원/직원 | 3 | 임원 현황, 직원 현황, 사외이사 |
| 보수 | 5 | 개인별, 전체, 상위5인, 미등기임원, 승인총액 |
| 주식 | 3 | 발행주식총수, 증자/감자 현황, 자기주식 |
| 감사 | 3 | 감사의견, 회계감사 계약, 비감사 서비스 |
| 채무증권 | 5 | 발행실적, 기업어음, 단기사채, 회사채, 신종자본증권, 조건부자본증권 |
| 투자/자금 | 3 | 타법인 출자, 공모자금, 사모자금 사용내역 |

### 주주 보유 보고 (2개)

| Tool | 설명 |
|------|------|
| `opendart_major_stockholding` | 대량보유 상황보고 (5% 이상) |
| `opendart_executive_stockholding` | 임원/주요주주 보유 보고 |

### 주요사항보고서 (36개)

| Category | Tools | 설명 |
|----------|-------|------|
| 자본 변동 | 4 | 유상증자, 무상증자, 유무상증자, 감자 |
| 조직 변경 | 3 | 합병, 분할, 분할합병 |
| 영업/자산 양수도 | 7 | 영업양수, 영업양도, 유형자산 양수/양도, 타법인 주식 취득/처분, 자산양수도(풋백옵션) |
| 자기주식 | 5 | 취득, 처분, 신탁 체결, 신탁 해지, 주식교환/이전 |
| 사채 | 7 | 전환사채, 신주인수권부사채, 교환사채, 조건부자본증권, 주식관련사채 양수/양도, 주식배당 |
| 해외상장 | 4 | 상장/폐지 결정, 상장/폐지 현황 |
| 법률/경영 | 6 | 채권은행관리 개시/중단, 채무불이행, 소송, 영업정지, 회생절차, 해산 |

### 증권신고서 (6개)

| Tool | 설명 |
|------|------|
| `opendart_equity_securities_reg` | 지분증권 신고서 |
| `opendart_debt_securities_reg` | 채무증권 신고서 |
| `opendart_depositary_receipts_reg` | 예탁증권 신고서 |
| `opendart_merger_reg` | 합병 신고서 |
| `opendart_stock_exchange_reg` | 주식교환 신고서 |
| `opendart_division_reg` | 분할 신고서 |

## Usage Examples

Claude에서 다음과 같이 사용하세요:

- "삼성전자의 20XX년 재무제표를 보여줘"
- "SK하이닉스의 최신 최대주주 현황을 알려줘"
- "카카오의 최근 공시 10개를 검색해줘"
- "현대자동차의 20XX년 임원 보수 현황을 보여줘"
- "LG에너지솔루션에 전환사채 발행 결정이 있었는지 확인해줘"
- "삼성전자 최신 사업보고서에서 '사업의 내용' 부분 원문을 읽어줘"
- "비나텍 사업보고서에서 충당부채 관련 내용을 찾아줘"
- "삼성전자 최신 사업보고서의 감사보고서에서 핵심감사사항을 보여줘"

## Tech Stack

- **Runtime**: Next.js 16 + TypeScript
- **MCP**: mcp-handler + @modelcontextprotocol/sdk
- **Deploy**: Vercel (Streamable HTTP, Seoul region 권장)
- **ZIP**: fflate (corp code XML 압축 해제)

## License

MIT
