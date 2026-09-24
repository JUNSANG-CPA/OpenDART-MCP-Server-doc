# OpenDART MCP Server - AI 도구 사용 가이드

## 기본 워크플로우

1. **회사 찾기**: `opendart_search_company`로 corp_code를 먼저 조회
2. **정보 조회**: corp_code를 사용하여 원하는 도구 호출

## 상황별 도구 선택

### 회사 찾기
| 상황 | 도구 |
|------|------|
| 회사명/종목코드로 기업코드 찾기 | `opendart_search_company` |
| 기업 기본정보 (대표이사, 주소, 업종 등) | `opendart_get_company_info` |
| 공시 검색 | `opendart_search_disclosure` |
| 공시 원문 읽기 (보고서 본문) | `opendart_get_document` |

### 공시 원문 (`opendart_get_document`)

구조화된 API로 답할 수 없는 서술형 내용(사업 설명, 위험요소, 계약 조건 등)을 읽을 때 사용합니다.
숫자·재무·주주 정보는 전용 도구가 더 정확하므로 원문 대신 그쪽을 쓰세요.

1. `opendart_search_disclosure`로 `rcept_no`(접수번호)를 먼저 확보
2. `mode="toc"`로 목차 확인 (기본값)
3. `mode="section"`에 목차 번호 또는 제목을 넘겨 필요한 부분만 조회

| 상황 | 파라미터 |
|------|---------|
| 목차 보기 | `mode="toc"` |
| **키워드 위치 찾기** | `mode="find"`, `query="충당부채"` |
| 특정 섹션 | `mode="section"`, `section="3"` 또는 `section="사업의 내용"` |
| 짧은 공시 전체 | `mode="full"` |
| 첨부 문서 (감사보고서 등) | `attachment="2"` 또는 `attachment="감사보고서"` |
| 잘린 내용 이어보기 | `offset=20000` (응답이 알려주는 값) |

**⚠️ 주석 구조는 회사마다 다릅니다.**
대기업은 주석마다 제목이 있지만(`15. 충당부채 (연결)`), 중소형사는 주석 전체가
`3. 연결재무제표 주석` 하나(7만자+)에 들어 있고 소제목이 평문입니다.
후자에서 `section="충당부채"`는 **찾지 못합니다** — 내용은 있는데 제목이 없어서입니다.

**목차에 없는 키워드는 `mode="find"`를 쓰세요.** `offset`으로 넘겨가며 찾지 마세요.
`find`는 섹션별로 묶어 몇 건씩 어디에 있는지 알려주고, 그대로 호출할 수 있는
`section`+`offset`을 함께 줍니다. 연결/별도 주석에 모두 있는 항목이면 양쪽 다 보여줍니다.

**파라미터 이름을 정확히 쓰세요.** `opendart_get_document`는 허용된 키
(rcept_no, mode, section, offset, query, attachment, max_chars, api_key) 외의
파라미터를 받으면 조용히 무시하지 않고 **에러로 거부**하며 올바른 키를 제안합니다.
`rcept_name` 같은 오타는 통하지 않습니다 — 에러 메시지의 제안을 따르세요.

**깨진 인코딩 문서**: 2020년 이전 일부 보고서는 텍스트 추출이 불가능할 수 있습니다.
그런 문서는 깨진 본문 대신 짧은 경고를 반환하니, DART 웹사이트에서 원문을 확인하세요.

**첨부 문서**: 하나의 접수번호에는 본문 외에 첨부 문서가 함께 들어 있습니다
(사업보고서 → `감사보고서`, `연결감사보고서`). `mode="toc"`가 목록을 보여주며,
`attachment`로 골라 읽습니다. 감사의견 **원문**(핵심감사사항 등)이 필요하면 여기서 읽으세요.
`opendart_auditor_opinion`은 요약 데이터만 제공합니다.

⚠️ 원문은 수 MB입니다. **`mode="full"`을 사업보고서에 쓰지 마세요** — 잘려서 앞부분만 나옵니다.
주요사항보고서처럼 짧은 공시에만 사용하고, 사업보고서·분기보고서는 반드시 `toc` → `section` 순으로 접근하세요.
응답이 잘리면 그렇게 표시되며, 그때는 하위 섹션을 따로 조회하거나 `max_chars`를 올리세요 (최대 50000).

### 재무 정보
| 상황 | 도구 | 파라미터 참고 |
|------|------|-------------|
| 매출/영업이익/순이익 등 주요 계정 | `opendart_single_financial_accounts` | fs_div: CFS=연결, OFS=별도 |

**⚠️ 분기 재무는 "당기 3개월"과 "당기 누계"가 다릅니다.**
분기/반기 보고서의 손익계산서는 두 열이 나옵니다.
- `당기 3개월`: 해당 분기만 (예: 2025년 3분기 = 7~9월 3개월)
- `당기 누계`: 사업연도 시작부터 누적 (예: 1~9월)

"3분기 매출"처럼 모호하게 물으면 **어느 쪽인지 확인하거나 둘 다 제시하세요.**
삼성전자 2025년 3분기는 3개월 86조 / 누계 240조로 3배 가까이 차이납니다.
재무상태표는 시점 잔액이라 누계가 없습니다. 연간 보고서(11011)도 누계 열이 없습니다.
| 전체 재무제표 (BS/IS/CF 모든 항목) | `opendart_full_financial_statement` | |
| 여러 회사 재무 비교 (최대 100개) | `opendart_multi_financial_accounts` | corp_code를 콤마로 구분 |
| 수익성/안정성/성장성 지표 | `opendart_single_financial_index` | |
| 여러 종목 2국면(TTM 영업이익 증가율 > 매출 증가율) 전환 판정 | `opendart_phase2_screen` | items에 종목명·종목코드·corp_code 혼용, 최대 500 |
| 여러 회사 지표 비교 | `opendart_multi_financial_index` | |
| XBRL 계정 분류 체계 | `opendart_xbrl_taxonomy` | sj_div: BS1, IS1, CF1 등 |
| 배당 정보 | `opendart_dividend_info` | |

### 주주/임원 정보
| 상황 | 도구 |
|------|------|
| 최대주주 현황 | `opendart_largest_shareholder` |
| 최대주주 변동 | `opendart_largest_shareholder_change` |
| 소액주주 현황 | `opendart_minority_shareholder` |
| 임원 현황 (직위, 담당업무) | `opendart_executive_status` |
| 직원 현황 (인원, 급여) | `opendart_employee_status` |
| 보수 상위 5인 | `opendart_top5_compensation` |
| 이사/감사 개인별 보수 | `opendart_individual_compensation` |
| 이사/감사 전체 보수 | `opendart_total_compensation` |
| 사외이사 현황 | `opendart_outside_director` |

### 주식/자본 정보
| 상황 | 도구 |
|------|------|
| 발행주식 총수 | `opendart_total_shares` |
| 증자/감자 현황 | `opendart_stock_issuance_status` |
| 자기주식 취득/처분 | `opendart_treasury_stock` |

### 대량보유/임원 보유
| 상황 | 도구 |
|------|------|
| 대량보유 (5%+ 지분) | `opendart_major_stockholding` |
| 임원 주식 보유 | `opendart_executive_stockholding` |

### 주요사항보고서 (기간 검색: bgn_de ~ end_de)
| 상황 | 도구 |
|------|------|
| 유상증자 결정 | `opendart_capital_increase` |
| 무상증자 결정 | `opendart_free_capital_increase` |
| 감자 결정 | `opendart_capital_decrease` |
| 합병 결정 | `opendart_merger` |
| 회사분할 | `opendart_division` |
| 전환사채(CB) 발행 | `opendart_convertible_bond` |
| 신주인수권부사채(BW) | `opendart_bond_with_warrant` |
| 교환사채(EB) | `opendart_exchangeable_bond` |
| 자기주식 취득 결정 | `opendart_treasury_acquisition_decision` |
| 자기주식 처분 결정 | `opendart_disposal_treasury_stock` |
| 영업양수 | `opendart_business_acquisition` |
| 영업양도 | `opendart_business_transfer` |
| 소송 | `opendart_lawsuit` |
| 회생절차 | `opendart_rehabilitation` |

### 감사/채무
| 상황 | 도구 |
|------|------|
| 감사인/감사의견 | `opendart_auditor_opinion` |
| 회계감사 계약 | `opendart_audit_service_contract` |
| 채무증권 발행실적 | `opendart_debt_securities` |
| 회사채 잔액 | `opendart_corporate_bond` |
| 타법인 출자 현황 | `opendart_investment_in_others` |

## ⚠️ 연도 해석 규칙 (중요)

`bsns_year`는 보고서가 **다루는 사업연도**이며, 제출 연도가 아닙니다.
- "2025년 사업보고서" → `bsns_year: "2025"` (O)
- "2025년 사업보고서" → `bsns_year: "2024"` (X, 절대 1을 빼지 마세요)
- 2025년 사업보고서는 2025 사업연도를 다루며, 2026년 3월경에 제출됩니다.

## 파라미터 참고

### reprt_code (보고서 구분)
| 코드 | 의미 |
|------|------|
| 11011 | 사업보고서 (연간) |
| 11012 | 반기보고서 |
| 11013 | 1분기보고서 |
| 11014 | 3분기보고서 |

### fs_div (재무제표 구분)
| 코드 | 의미 |
|------|------|
| CFS | 연결재무제표 (기본값, 추천) |
| OFS | 별도재무제표 |

### 날짜 형식
- `bgn_de`, `end_de`: YYYYMMDD (예: "20240101")
- `bsns_year`: YYYY (예: "2024")
