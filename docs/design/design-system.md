# 디자인 시스템 — IP Watch

## 문서 정보

| 항목 | 내용 |
| --- | --- |
| 문서 상태 | Draft |
| 적용 범위 | 대시보드(v1) 전 화면 |
| 테마 | 라이트 전용(다크 미지원) |
| 폰트 | 시스템 폰트 스택(외부 CDN·번들 없음) |
| 관련 문서 | [wireframe-dashboard.md](./wireframe-dashboard.md), [04-web-and-realtime](../spec/04-web-and-realtime.md), [03-state-and-storage](../spec/03-state-and-storage.md) |

이 문서는 색·타이포·컴포넌트·간격·모션·접근성 등 **시각 규칙**을 정의한다. 화면 구조와 상호작용은 [wireframe-dashboard.md](./wireframe-dashboard.md)를, 데이터 정의는 스펙을 따른다.

## 디자인 원칙

1. **개요 우선**: 요약(스캔 상태·통계)을 먼저, 상세는 요청 시. 대시보드는 위에서 아래로 읽기보다 훑어보고 조작하는 화면이다.
2. **높은 정보 밀도, 낮은 장식**: 최대 254개 IP를 한 화면에 담는다. 불필요한 여백·그림자·색을 줄이고 데이터를 우선한다.
3. **색에만 의존하지 않는다**: 상태는 항상 색 + 글리프 + 텍스트로 함께 인코딩한다. (근거: [04-web-and-realtime](../spec/04-web-and-realtime.md))
4. **상태와 예약의 분리**: 탐지 상태는 색·글리프로, 예약은 별도 배지·테두리로 표현한다. 둘은 겹칠 수 있다.
5. **단순함**: 외부 폰트·아이콘·빌드 의존성을 두지 않는다. 시스템 폰트와 유니코드 글리프, CSS 변수만으로 구현한다.

## 색

라이트 테마 하나만 정의한다. 모든 색은 CSS 변수(토큰)로 선언하고 컴포넌트는 토큰만 참조한다. 팔레트는 약간의 청색 편향을 준 뉴트럴 + 테크 블루 액센트이며, 상태색은 스펙의 권장 표현(녹/주황/회)을 따른다.

```css
:root{
  /* 바탕과 표면 */
  --bg:#f6f7f9;          /* 페이지 바탕 */
  --surface:#ffffff;      /* 카드·타일·드로어 */
  --surface-2:#f0f2f5;    /* 보조 표면·입력 배경 */
  --surface-3:#e9ecf1;

  /* 글자 */
  --ink:#191f2b;          /* 기본 텍스트 */
  --ink-2:#59616f;        /* 보조 텍스트 */
  --ink-3:#8a91a0;        /* 흐린 텍스트·플레이스홀더 */

  /* 경계 */
  --border:#e4e7ec;
  --border-strong:#cfd4dd;

  /* 액센트(상호작용·선택·할당 후보 강조) */
  --accent:#2f6feb;
  --accent-ink:#ffffff;
  --accent-soft:#e8f0fe;

  /* 탐지 상태 */
  --active:#1f9d57;    --active-soft:#e4f4ea;   /* ACTIVE 사용 중 */
  --inactive:#b9760a;  --inactive-soft:#faedd6; /* INACTIVE 과거 사용 */
  --available:#6b7280; --available-soft:#eef0f3;/* AVAILABLE 미사용 추정 */

  /* 예약(상태와 독립) */
  --reserved:#6b4dd6;  --reserved-soft:#ece7fb;

  /* 의미색: 위험/오류. 액센트와 별개로 취급 */
  --danger:#cf3b3b;    --danger-soft:#fbe6e6;
}
```

규칙:

- 액센트(파랑)와 의미색(위험·상태색)은 서로 다른 역할이다. 액센트를 상태 표시에 쓰지 않고, 상태색을 버튼 강조에 쓰지 않는다.
- 텍스트와 바탕의 대비는 본문 기준 WCAG AA(4.5:1) 이상을 만족한다. 상태 tint 위의 텍스트는 같은 계열의 진한 토큰(예: `--active` on `--active-soft`)을 쓴다.
- 다크 테마는 v1 범위 밖이다. 단, 위와 같이 토큰으로 분리해 두어 이후 `@media (prefers-color-scheme: dark)`로 확장할 수 있게 한다.

## 타이포그래피

외부 폰트를 쓰지 않는다. UI 텍스트는 시스템 산세리프, 네트워크 데이터(IP·MAC·시각·수치)는 시스템 고정폭을 쓴다. 한글이 포함되므로 한국어 시스템 폰트를 폴백에 포함한다.

```css
:root{
  --font-ui:  system-ui, -apple-system, "Apple SD Gothic Neo",
              "Segoe UI", Roboto, "Noto Sans KR", "Malgun Gothic", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo,
               Consolas, "Liberation Mono", monospace;
}
```

- 데이터(IP·MAC·시각·통계 수치)는 `--font-mono` + `font-variant-numeric: tabular-nums`로 자릿수를 정렬한다.
- 대문자 마이크로 라벨(필드명 등)은 `letter-spacing: .05–.07em`.

타입 스케일(기준 14px):

| 역할 | 크기 | 두께 |
| --- | --- | --- |
| 통계 수치 | 24px | 600 |
| 드로어 IP | 22px | 600 |
| 브랜드·섹션 제목 | 16px | 600–700 |
| 본문·기본 | 14px | 400 |
| 컨트롤·표 셀 | 13px | 500 |
| 라벨·메타 | 12px | 500–600 |
| 마이크로 라벨(대문자) | 10.5–11px | 600 |

## 상태 표현 규칙

상태·예약·할당 후보의 표기는 아래 표를 **단일 출처**로 삼는다. 화면 어디서나 동일하게 적용한다.

| 구분 | 글리프 | 라벨 | 포인트 토큰 | 배경 tint | 타일 표현 |
| --- | --- | --- | --- | --- | --- |
| ACTIVE | `●` | 사용 중 | `--active` | `--active-soft` | tint 배경 + 글리프 |
| INACTIVE | `◐` | 과거 사용 | `--inactive` | `--inactive-soft` | tint 배경 + 글리프 |
| AVAILABLE | `○` | 미사용 추정 | `--available` | `--available-soft` | 기본 표면 + 옅은 글리프 |
| 예약됨 | `🔒` | 예약 | `--reserved` | `--reserved-soft` | 2px inset 테두리 + 자물쇠(상태와 겹쳐 표기) |
| 할당 후보 | `◆` | 할당 후보 | `--accent` | — | 타일의 별도 상태가 아님. `AVAILABLE && !isReserved` 계산값으로 통계·필터·범례에서만 표기 |

- 상태는 색 + 글리프 + 텍스트 세 가지를 함께 제공한다. 색 하나만으로 구분하지 않는다.
- 예약은 탐지 상태와 독립이므로 `ACTIVE`·`INACTIVE`·`AVAILABLE` 어떤 타일에도 예약 표기가 함께 나타날 수 있다.

## 컴포넌트

### 상태 배지(pill)
글리프 + 라벨. 포인트 토큰 글자색, soft 토큰 배경, 같은 계열 옅은 테두리. 상세·표·범례에서 상태 표기에 공통 사용.

### 통계 카드
큰 고정폭 수치 + 라벨(+ 부가 설명). 할당 후보 카드는 액센트 아웃라인으로 강조한다. 예약 카드는 "중복 지표"임을 부가 설명에 둔다.

### IP 타일
정사각형에 가깝게, 최소 크기 약 48px. 마지막 옥텟 중앙 + 좌상단 상태 글리프. 예약 시 inset 테두리 + 우상단 자물쇠. `button` 요소로 만들고 접근성 라벨에 전체 정보를 담는다. 포커스 시 액센트 아웃라인.

### 필터 칩 / 검색
칩은 선택 시 채움(액센트 또는 잉크). 검색 입력은 데이터 폰트, 좌측 아이콘. 상태 칩의 `할당 후보`는 액센트로 구분한다.

### 상세 드로어
우측 슬라이드 오버레이. 폭은 넓은 화면에서 고정(약 380px), 좁은 화면에서 화면 대부분을 덮는다. 헤더(IP·상태·예약) / 필드 목록 / 메모 편집 / 액션(예약·저장) / 경고(AVAILABLE) 순. 바깥에 스크림.

### 버튼
기본(테두리+표면)과 primary(액센트 채움) 두 종류. 최소 높이로 터치 여유를 둔다.

### 오류 배너
위험색(soft 배경 + `--danger` 텍스트). 실패 사실 + 원인 요약 + "기존 상태 유지" 문구. 스캔 오류 시에만 노출.

### 범례
글리프↔상태 매핑과 예약 표기를 항상 노출. 색 비의존 원칙의 핵심 장치.

## 레이아웃과 간격

- **간격 스케일(px)**: 2 · 4 · 6 · 8 · 10 · 12 · 14 · 16 · 20 · 24 · 40. 형제 그룹은 flex/grid의 `gap`으로 배치한다(개별 margin 누적 지양).
- **모서리 반경**: 7px(작은 컨트롤) · 10px(카드·타일·드로어) · 16–20px(pill).
- **그리드**: `repeat(auto-fill, minmax(48px, 1fr))`. 가로 넘침은 컨테이너 내부 스크롤로 처리하고 본문이 가로로 밀리지 않게 한다.
- **브레이크포인트**: `≤640px`(모바일: 통계 2열, 드로어 전체폭에 근접) · `≤1080px`(태블릿: 통계·툴바 줄바꿈).

## 모션

- 트랜지션 120–200ms. 드로어 슬라이드 약 200ms.
- `@media (prefers-reduced-motion: reduce)`에서 애니메이션·트랜지션을 끈다.
- 스캔 진행 표시(맥동 등)도 reduced-motion에서 정지 상태로 대체한다.

## 접근성

- 상태를 색으로만 전달하지 않는다(글리프 + 텍스트 병행).
- 키보드: 타일·칩·버튼은 포커스 가능하고, 포커스 링을 눈에 보이게 한다(2px 액센트). 드로어는 `Esc`로 닫는다.
- 이미지·아이콘 대신 텍스트/유니코드 글리프를 쓰되, 타일 등 압축 표기에는 접근성 라벨로 전체 의미를 제공한다.
- 시각 대비는 본문 AA를 기준으로 한다.

## 구현 메모

빌드 단계 없이 EJS + Vanilla JavaScript + CSS로 구현한다. (근거: [01-architecture-and-stack](../spec/01-architecture-and-stack.md))

| 산출물 | 위치 | 내용 |
| --- | --- | --- |
| 화면 마크업 | `views/dashboard.ejs`, `views/partials/` | 영역별 partial(상태 스트립·통계·툴바·그리드·드로어) |
| 스타일 | `public/styles.css` | `:root` 토큰(위 색·폰트) + 컴포넌트 스타일 |
| 브라우저 로직 | `public/app.js` | 검색·필터·드로어·SSE 수신·부분 갱신 |

- 색·폰트는 위 토큰을 `:root`에 그대로 선언하고, 모든 컴포넌트는 리터럴 색 대신 토큰을 참조한다.
- 시스템 폰트 스택이므로 웹폰트 로드·FOUT가 없다. 별도 폰트 파일을 두지 않는다.
- 상태 표현은 "상태 표현 규칙" 표를 그대로 구현하며, 라벨·글리프를 서버(EJS)와 브라우저(app.js) 양쪽에서 일관되게 사용한다.

## 참고 자료

- 화면 구조·상호작용: [wireframe-dashboard.md](./wireframe-dashboard.md)
- 화면·실시간 계약: [04-web-and-realtime](../spec/04-web-and-realtime.md)
- 상태·저장: [03-state-and-storage](../spec/03-state-and-storage.md)
- 아키텍처·스택: [01-architecture-and-stack](../spec/01-architecture-and-stack.md)
