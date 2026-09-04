# 오래된 INACTIVE의 미사용 표시(Stale Aging) 작업 계획

## 문서 정보

| 항목 | 내용 |
| --- | --- |
| 문서 상태 | Draft |
| 대상 버전 | v1 이후 소규모 추가 (기본 OFF, 하위호환) |
| 목적 | 오래 응답 없는 `INACTIVE` IP를 할당 후보로 다시 편입하되 이력을 잃지 않게 한다 |
| 관련 스펙 | [03-state-and-storage.md](../spec/03-state-and-storage.md), [04-web-and-realtime.md](../spec/04-web-and-realtime.md) |
| 관련 설계 | [wireframe-dashboard.md](../design/wireframe-dashboard.md), [design-system.md](../design/design-system.md) |

## 1. 배경과 문제

한 번이라도 `ACTIVE`였던 IP는 `last_seen_at`이 영구히 남아, 응답이 끊기면 **영원히 `INACTIVE`**로 유지된다([state.ts:321](../../src/state.ts)). 판정 규칙상 `INACTIVE → AVAILABLE` 전이가 존재하지 않기 때문이다([03:33-34](../spec/03-state-and-storage.md)).

그 결과 시간이 지날수록 "과거 사용" 표시가 누적되고, **할당 후보 풀(`AVAILABLE && !isReserved`)이 계속 줄어든다.** 오래 전 사라진 개발 보드가 후보에서 영구히 빠지는 실재하는 드리프트다.

## 2. 결정 사항

| 항목 | 결정 |
| --- | --- |
| 도입 방식 | `observed_status` 저장값·판정 함수는 **불변**. 표시용 파생 상태만 추가 |
| 환경변수 | `STALE_THRESHOLD_DAYS` (일 단위) |
| 기본값 | **OFF** — 미설정/0이면 오늘과 100% 동일 동작 (완전 하위호환) |
| 표시 통일 | 색만 바꾸지 않고 **`effectiveStatus` 하나로 타일·글리프·드로어·필터·카운트를 모두 통일** |
| 드로어 정직성 | stale 항목은 미사용 추정으로 표시하되 **"과거 사용 이력" 문구(임계 일수 명시)와 `last_seen_at`을 함께 노출** |

## 3. 설계

### 상태 정의

```text
저장:  observed_status = INACTIVE  (불변, last_seen_at 보존 → 이력 유지)
파생:  isStale = observed_status == INACTIVE
               && STALE_THRESHOLD_DAYS > 0
               && (now - last_seen_at) > STALE_THRESHOLD_DAYS
표시:  effectiveStatus = isStale ? AVAILABLE : observed_status
할당 후보 = effectiveStatus == AVAILABLE && !isReserved
```

- `observed_status` 판정 순서([03:38-52](../spec/03-state-and-storage.md))는 **전혀 바뀌지 않는다.**
- `effectiveStatus`는 저장하지 않는 **계산값**이다(할당 후보와 동일한 성격, [03:22](../spec/03-state-and-storage.md)).
- `now`와 threshold는 헬퍼에 **주입**한다. `Date.now()`를 순수 함수 내부에서 호출하지 않아 테스트 가능성을 유지한다.

### 계약 변경

대시보드 record 페이로드에 파생 필드 **`effectiveStatus`** (`ACTIVE | INACTIVE | AVAILABLE`) 하나를 추가한다. 프론트엔드는 후보 판정([app.js:61](../../public/app.js))을 `observedStatus` → `effectiveStatus`로 바꿔 그대로 도출하므로 새 중복 로직은 없다. `observedStatus`는 드로어의 "과거 사용 이력" 문구를 위해 페이로드에 그대로 유지한다.

### 트레이드오프 (수용)

그리드에서는 "한 번도 안 쓴 IP(AVAILABLE)"와 "오래 죽은 IP(stale INACTIVE)"가 **동일한 회색 ○로 보여 구분되지 않는다.** 구분은 드로어의 `last_seen_at`과 "과거 사용 이력" 문구(임계 일수 `STALE_THRESHOLD_DAYS` 명시)에만 남는다. 이는 "오래된 IP를 미사용처럼 보이게 한다"는 의도의 결과이며, 그리드는 후보 탐색용·드로어는 이력 확인용이라는 역할 분담과 부합한다.

## 4. 파일별 작업

| 파일 | 변경 |
| --- | --- |
| [src/config.ts](../../src/config.ts) | `STALE_THRESHOLD_DAYS` 파싱 추가. 기본 OFF(미설정/0). 일 단위이므로 `MAX_TIMER_MS` 캡이 아닌 별도 상한으로 검증 |
| [src/state.ts](../../src/state.ts) | `effectiveStatus(record, now, thresholdMs)` 순수 헬퍼 추가. `summarizeRecords`가 이 값으로 카운트하도록 시그니처에 `now`·`thresholdMs` 주입. 스냅샷 record에 `effectiveStatus` 부착 |
| [src/db.ts:198](../../src/db.ts) `getDashboardSnapshot` / [src/scan-loop.ts:83](../../src/scan-loop.ts) | 읽기 경로와 SSE 푸시 경로에 **동일한** `now` + `config` threshold 전달 (한 헬퍼 공유, 경계 불일치 방지) |
| [src/routes.ts:40](../../src/routes.ts) | 이미 `deps.config` 보유 — threshold만 통과 |
| [public/app.js](../../public/app.js) | 표시 계열(`statusMeta`·타일 class·글리프·드로어 pill·상태 필터·`isCandidate`)을 `observedStatus` → `effectiveStatus`로 전환. `observedStatus`는 드로어 이력 문구용으로만 참조 |
| [views/partials/stats.ejs](../../views/partials/stats.ejs), [views/partials/drawer.ejs](../../views/partials/drawer.ejs) | 카운트·문구 정합. 드로어에 "과거 사용 이력" 표기 추가(임계 일수를 문구에 명시) |
| [03-state-and-storage.md](../spec/03-state-and-storage.md), [04-web-and-realtime.md](../spec/04-web-and-realtime.md), [wireframe-dashboard.md](../design/wireframe-dashboard.md) | `observed_status` 판정은 유지하되 "표시 상태(aging)" 규칙과 후보 카운트 정의([04:99](../spec/04-web-and-realtime.md))를 `effectiveStatus` 기준으로 갱신 |

## 5. 테스트

프레임워크 추가 없이 기존 방식을 따른다.

- **state**: threshold 경계 3케이스(직전 / 정확히 같을 때 / 직후) + `effectiveStatus`가 `AVAILABLE`/`INACTIVE`를 올바로 산출하는지. threshold=0(OFF)일 때 `effectiveStatus == observedStatus` 불변 확인.
- **config**: `STALE_THRESHOLD_DAYS` 파싱, 기본 OFF, 상한/형식 검증.
- **인수 회귀**: [06-testing-and-acceptance.md](../spec/06-testing-and-acceptance.md)의 기존 후보 카운트·필터 인수 조건이 OFF 상태에서 그대로 통과하는지.

## 6. 범위 밖 (명시)

- `observed_status` 저장값·판정 함수 변경 — 하지 않는다. 이력 보존이 핵심.
- 상태 변경 이력 테이블, 나이 먹임 배치 작업 — MVP 비목표 유지.
- 그리드에서 stale와 순수 AVAILABLE의 시각적 구분 — 의도적으로 두지 않는다(§3 트레이드오프).
- 이 규칙 안내(임계 일수·과거 사용 이력)는 그리드/통계에 넣지 않고 **드로어 문구로 한정**한다. 전역 배너·상단 도움말 등 대안은 기각한다.
