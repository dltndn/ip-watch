# 아키텍처와 기술 스택

## 핵심 설계 결정

### 웹 애플리케이션

별도의 SPA 프론트엔드를 구성하지 않는다. Express가 EJS로 초기 HTML을 렌더링하고, 브라우저의 Vanilla JavaScript가 검색, 필터, 상세 패널 및 화면 부분 갱신을 담당한다.

### 실시간 통신

실시간 통신에는 Server-Sent Events(SSE)를 사용한다.

스캔 결과 전달은 `서버 → 브라우저` 단방향 통신이다. 메모와 예약 변경은 일반 HTTP 요청으로 처리하고, 저장 후 SSE로 다른 화면에도 변경 사실을 알린다.

브라우저는 `EventSource`를 사용한다. WebSocket은 지속적인 양방향 통신이 필요하지 않은 v1에는 사용하지 않는다.

### 데이터베이스

SQLite를 단일 애플리케이션 인스턴스에서 사용한다. IP별 최신 상태, 작업 메모 및 예약 여부만 저장한다.

WAL 모드를 활성화하여 스캔 결과 저장과 대시보드 조회가 서로 불필요하게 막히지 않도록 한다.

### 컨테이너 실행

개발과 운영 모두 Docker Compose로 애플리케이션을 실행한다. 애플리케이션, `arp-scan`, `ping` 및 Node.js 런타임을 하나의 이미지로 패키징하여 호스트별 설치 차이를 줄인다.

- macOS 개발은 Docker Desktop과 Mock Scanner를 사용한다.
- Ubuntu 운영은 Docker Engine과 실제 Scanner를 사용한다.
- SQLite 파일은 컨테이너 레이어가 아닌 Docker named volume에 저장한다.
- 운영 컨테이너는 단일 인스턴스로 실행한다.

## 기술 스택

| 영역 | 기술 | 용도 |
| --- | --- | --- |
| 런타임 | Node.js LTS | 서버 실행 환경 |
| 언어 | TypeScript | 애플리케이션 구현 |
| 웹 프레임워크 | Express 5 | EJS, HTTP API, SSE 제공 |
| 화면 | EJS, Vanilla JavaScript, CSS | 서버 렌더링과 브라우저 상호작용 |
| 데이터베이스 | SQLite | IP 최신 상태, 메모, 예약 저장 |
| SQLite 드라이버 | better-sqlite3 | 쿼리와 트랜잭션 처리 |
| 실시간 통신 | SSE / EventSource | 상태 변경을 브라우저에 전송 |
| 네트워크 탐지 | `arp-scan`, `ping` | ARP 기반 탐지와 Ping 보조 확인 |
| 명령 실행 | Node.js `child_process.execFile` | 셸을 거치지 않고 탐지 명령 실행 |
| 컨테이너 이미지 | Docker, 공식 Node.js LTS Debian 이미지 | 애플리케이션과 스캔 도구 패키징 |
| 컨테이너 실행 | Docker Compose v2 | 개발·운영 실행 설정 관리 |
| 테스트 | Vitest, Supertest | 핵심 로직과 HTTP 동작 검증 |
| 운영 | Docker Engine, Compose restart policy | Ubuntu 서비스 실행과 재시작 |

Node.js는 개발과 운영에서 같은 LTS 메이저 버전을 사용한다. 구현을 시작할 때 `package.json`의 `engines`와 Docker 베이스 이미지 태그에 같은 메이저 버전을 고정한다.

## 시스템 구조

```text
┌─────────────────────────────────────────────┐
│ Ubuntu Server + Docker Engine               │
│                                             │
│  ip-watch container (host network)          │
│   ├─ Scan Loop                              │
│   │    ↓                                    │
│   ├─ arp-scan + ping                        │
│   │    ↓                                    │
│   ├─ 상태 판정                              │
│   └─ Express + EJS + SSE                    │
│             │                               │
│             ▼                               │
│      Docker named volume                    │
│      └─ SQLite                              │
└───────────────────────────┬─────────────────┘
                            │ HTTP
                            ▼
                  작업자 웹 브라우저
```

## 모듈 구조

구현은 다음 작은 모듈로 나눈다.

- `scanner`: 실제 또는 Mock 스캔 결과 반환
- `scan-loop`: 주기 실행과 중복 실행 방지
- `state`: 기존 값과 스캔 결과를 비교해 새 상태 계산
- `db`: SQLite 초기화와 쿼리
- `sse`: 연결 목록과 변경 알림 관리
- `routes`: EJS 페이지와 최소 HTTP API

별도의 서비스, Repository 또는 이벤트 버스 계층은 만들지 않는다. 모듈이 커지거나 독립적인 변경 이유가 생길 때만 분리한다.

## 권장 디렉터리 구조

```text
ip-watch/
├─ AGENTS.md
├─ Dockerfile
├─ .dockerignore
├─ compose.yaml
├─ compose.dev.yaml
├─ .env.example
├─ docs/
│  └─ spec/
│     ├─ README.md
│     ├─ 00-product-scope.md
│     ├─ 01-architecture-and-stack.md
│     ├─ 02-network-scanning.md
│     ├─ 03-state-and-storage.md
│     ├─ 04-web-and-realtime.md
│     ├─ 05-runtime-and-operations.md
│     ├─ 06-testing-and-acceptance.md
│     └─ 07-future-scope.md
├─ src/
│  ├─ app.ts
│  ├─ config.ts
│  ├─ db.ts
│  ├─ scanner.ts
│  ├─ scan-loop.ts
│  ├─ state.ts
│  ├─ sse.ts
│  └─ routes.ts
├─ views/
│  ├─ dashboard.ejs
│  └─ partials/
├─ public/
│  ├─ app.js
│  └─ styles.css
├─ tests/
├─ data/
├─ package.json
└─ tsconfig.json
```

## 참고 자료

- [Express Template Engine Guide](https://expressjs.com/en/5x/guide/using-template-engines/)
- [SQLite Write-Ahead Logging](https://www.sqlite.org/wal.html)
- [Docker multi-stage builds](https://docs.docker.com/build/building/multi-stage/)
- [Official Node.js Docker image](https://github.com/nodejs/docker-node)
