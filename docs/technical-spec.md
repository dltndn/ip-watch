# 내부망 IP 사용 현황 모니터링 프로그램 테크 스펙

## 1. 문서 정보

| 항목 | 내용 |
| --- | --- |
| 문서 상태 | Draft |
| 대상 버전 | v1 (MVP) |
| 주요 사용자 | 여러 디바이스를 연결해 개발·테스트하는 작업자 |
| 개발 환경 | macOS |
| 운영 환경 | Ubuntu Server LTS |

## 2. 문제 정의

펌웨어, 앱, 임베디드 시스템 등을 개발하는 작업자는 개발 보드, 테스트 단말, 노트북 등 여러 디바이스를 사내 내부망에 연결한다. 이 과정에서 다음 정보를 빠르게 확인하기 어렵다.

- 지금 사용 중인 IP는 무엇인가?
- 새 디바이스에 할당해도 될 것으로 보이는 IP는 무엇인가?
- 특정 IP를 어떤 디바이스나 작업에 사용하고 있는가?
- 이전에 사용한 IP와 마지막 확인 시각은 언제인가?

본 프로그램은 동일한 L2 네트워크의 특정 IPv4 CIDR을 주기적으로 확인하고, 작업자가 IP 충돌을 피하면서 개발 디바이스의 IP 사용 현황을 한눈에 파악할 수 있는 내부용 현황판을 제공한다.

이 프로그램의 사용자는 네트워크 관리자가 아니다. 네트워크 구성 자체를 관리하기보다 주어진 개발용 네트워크 안에서 IP를 조회하고, 작업 메모를 남기고, 사용할 IP를 예약하는 사람을 대상으로 한다.

## 3. 목표

- 대상 CIDR의 전체 IP와 현재 탐지 상태를 한 화면에 표시한다.
- 작업자가 새 디바이스에 사용할 IP 후보를 빠르게 찾을 수 있게 한다.
- ARP 응답과 Ping 응답을 이용해 IP 사용 여부를 판정한다.
- 확인 가능한 경우 MAC 주소와 최초·마지막 확인 시각을 표시한다.
- 작업자가 IP별로 디바이스명, 프로젝트명 또는 용도를 메모할 수 있게 한다.
- 작업자가 사용할 IP를 예약하거나 예약 해제할 수 있게 한다.
- 스캔 결과를 페이지 새로고침 없이 화면에 반영한다.
- 스캔 실패를 IP 미사용으로 오판하지 않는다.

## 4. 비목표

다음 항목은 v1 범위에서 제외한다.

- 사내 네트워크 전체의 자산 관리
- 여러 VLAN 또는 서로 다른 L2 네트워크의 통합 스캔
- IPv6 탐지
- DHCP 서버, 라우터, 스위치, SNMP 연동
- 사용자 계정, 역할 및 예약 소유권 관리
- 상태 변경 이력과 감사 로그 조회
- 웹 화면에서 CIDR 또는 네트워크 인터페이스 변경
- 여러 애플리케이션 인스턴스를 이용한 수평 확장
- 외부 인터넷 공개 서비스 운영

## 5. MVP 범위 점검

v1은 다음 사용자 흐름만 완성한다.

```text
대시보드 접속
    ↓
현재 사용 중이거나 사용 가능해 보이는 IP 확인
    ↓
IP 상세에서 MAC·마지막 확인 시각 확인
    ↓
디바이스 또는 작업 용도를 메모하고 필요하면 예약
    ↓
디바이스 연결 상태 변화가 화면에 자동 반영
```

### 5.1 MVP에 유지하는 설계

| 설계 | 유지 이유 |
| --- | --- |
| EJS + Vanilla JavaScript | 별도 프론트엔드 빌드 시스템 없이 화면을 제공할 수 있음 |
| SSE | 스캔 결과를 서버에서 화면으로 보내는 단방향 요구를 가장 단순하게 충족 |
| SQLite | 단일 서버와 소규모 데이터에 충분하며 별도 DB 운영이 필요 없음 |
| Mock Scanner | macOS에서 Ubuntu의 실제 ARP 환경 없이 상태 변경을 개발·테스트하기 위해 필요 |
| 상태와 예약의 분리 | 예약된 IP가 실제 사용 중인 상황을 정확히 표현하기 위해 필요 |
| 스캔 결과의 트랜잭션 저장 | 화면 요약과 IP별 상태가 서로 다른 시점의 값이 되는 것을 방지 |
| 스캔 실패 시 기존 상태 유지 | 장애를 “모든 IP가 비어 있음”으로 잘못 표시하지 않기 위해 필요 |

### 5.2 MVP에서 제외하거나 단순화한 설계

| 항목 | v1 결정 |
| --- | --- |
| 다중 네트워크 테이블 | 제거. 하나의 CIDR만 환경 변수로 설정 |
| 상태 변경 이력 테이블 | 제거. `first_seen_at`, `last_seen_at`만 저장 |
| 스캔 실행 이력 테이블 | 제거. 현재 스캔 상태는 메모리와 로그로 관리 |
| 이력 보존·정리 작업 | 제거. 저장되는 이력이 없으므로 불필요 |
| 네트워크 설정 API와 화면 | 제거. 배포자가 환경 변수로 설정 |
| 세분화된 SSE 이벤트 | 하나의 `dashboard.updated` 이벤트로 통합 |
| Repository/Controller 계층 | 제거. 작은 모듈과 함수로 구성 |
| PostgreSQL, Redis, 메시지 큐 | 제거. 단일 프로세스 요구에 필요하지 않음 |
| Pino, Zod | 제거. v1 입력 규모에서는 작은 검증 함수와 기본 로그로 충분 |

## 6. 핵심 설계 결정

### 6.1 웹 애플리케이션

별도의 SPA 프론트엔드를 구성하지 않는다. Express가 EJS로 초기 HTML을 렌더링하고, 브라우저의 Vanilla JavaScript가 검색, 필터, 상세 패널 및 화면 부분 갱신을 담당한다.

### 6.2 실시간 통신

실시간 통신에는 Server-Sent Events(SSE)를 사용한다.

스캔 결과 전달은 `서버 → 브라우저` 단방향 통신이다. 메모와 예약 변경은 일반 HTTP 요청으로 처리하고, 저장 후 SSE로 다른 화면에도 변경 사실을 알린다.

브라우저는 `EventSource`를 사용한다. WebSocket은 지속적인 양방향 통신이 필요하지 않은 v1에는 사용하지 않는다.

### 6.3 데이터베이스

SQLite를 단일 애플리케이션 인스턴스에서 사용한다. IP별 최신 상태, 작업 메모 및 예약 여부만 저장한다.

WAL 모드를 활성화하여 스캔 결과 저장과 대시보드 조회가 서로 불필요하게 막히지 않도록 한다.

### 6.4 상태와 예약의 분리

예약 여부는 네트워크에서 관측한 상태가 아니다. 따라서 `RESERVED`를 탐지 상태와 같은 열에 저장하지 않는다.

```text
observed_status: ACTIVE | INACTIVE | AVAILABLE
is_reserved: true | false
```

이 구조는 다음 상황을 모두 표현한다.

```text
ACTIVE + RESERVED
INACTIVE + RESERVED
AVAILABLE + RESERVED
```

화면에서는 탐지 상태를 색상과 텍스트로 표시하고 예약 여부를 별도 배지로 표시한다.

새 디바이스의 `할당 후보`는 저장 상태가 아니라 다음 조건으로 계산한다.

```text
observed_status == AVAILABLE && is_reserved == false
```

## 7. 기술 스택

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
| 테스트 | Vitest, Supertest | 핵심 로직과 HTTP 동작 검증 |
| 운영 | systemd | Ubuntu 서비스 실행과 재시작 |

Node.js는 개발과 운영에서 같은 LTS 메이저 버전을 사용한다. 구현을 시작할 때 `package.json`의 `engines`에 버전을 고정한다.

## 8. 실행 환경

### 8.1 개발 환경

기본 개발 환경은 macOS로 한다.

macOS에서는 다음 항목을 개발하고 검증한다.

- Express 및 EJS 화면
- HTTP API와 SSE 연결
- SQLite 저장과 상태 판정
- Mock Scanner를 이용한 디바이스 연결·해제 시나리오
- 단위 테스트와 HTTP 통합 테스트

실제 `arp-scan`은 macOS에서도 실행할 수 있지만 네트워크 인터페이스와 패킷 접근 권한이 Ubuntu와 다를 수 있다. macOS의 실제 스캔 결과를 운영 적합성 판정 기준으로 사용하지 않는다.

### 8.2 운영 및 실환경 테스트

운영 환경은 Ubuntu Server LTS로 한다.

- 서버는 대상 CIDR과 동일한 L2 네트워크에 배치한다.
- 애플리케이션은 전용 OS 사용자로 실행한다.
- 애플리케이션 전체를 root로 실행하지 않는다.
- `arp-scan`에는 필요한 최소 권한인 `CAP_NET_RAW`만 부여한다.
- SQLite 파일은 서비스 사용자가 읽고 쓸 수 있는 전용 디렉터리에 저장한다.
- systemd를 이용하여 부팅 시 자동 실행하고 비정상 종료 시 재시작한다.

실제 장비의 연결·해제, ARP/Ping 결과와 실행 권한은 Ubuntu 환경에서 검증한다. Docker Desktop은 운영 서버와 동일한 L2 환경을 완전히 재현하는 수단으로 간주하지 않는다.

## 9. 시스템 구조

```text
┌─────────────────────────────────────────────┐
│ Ubuntu Server                               │
│                                             │
│  Scan Loop                                  │
│      ↓                                      │
│  arp-scan + ping                            │
│      ↓                                      │
│  상태 판정                                  │
│      ↓                                      │
│  SQLite ───── Express + EJS                 │
│                      │                      │
│                      └──── SSE              │
└───────────────────────────┬─────────────────┘
                            │ HTTP
                            ▼
                  작업자 웹 브라우저
```

구현은 다음 작은 모듈로 나눈다.

- `scanner`: 실제 또는 Mock 스캔 결과 반환
- `scan-loop`: 주기 실행과 중복 실행 방지
- `state`: 기존 값과 스캔 결과를 비교해 새 상태 계산
- `db`: SQLite 초기화와 쿼리
- `sse`: 연결 목록과 변경 알림 관리
- `routes`: EJS 페이지와 최소 HTTP API

별도의 서비스, Repository 또는 이벤트 버스 계층은 만들지 않는다. 모듈이 커지거나 독립적인 변경 이유가 생길 때만 분리한다.

## 10. 스캔 처리

### 10.1 실행 흐름

```text
애플리케이션 시작 또는 스캔 주기 도래
    ↓
이미 스캔 중이면 이번 실행 생략
    ↓
CIDR 전체에 ARP Scan 실행
    ↓
ARP 미응답 IP에 Ping 보조 확인
    ↓
결과 정규화 및 검증
    ↓
기존 IP 상태와 비교
    ↓
SQLite 트랜잭션으로 최신 상태 저장
    ↓
dashboard.updated SSE 발행
```

### 10.2 ARP Scan

- 설정된 CIDR과 네트워크 인터페이스를 대상으로 `arp-scan`을 실행한다.
- 응답에서 IPv4 주소와 MAC 주소를 추출한다.
- MAC 주소는 소문자 콜론 형식으로 정규화한다.
- 중복 응답은 IP 기준으로 합친다.
- ARP 응답이 있으면 해당 IP를 `ACTIVE`로 판정한다.

### 10.3 Ping 보조 확인

- ARP 응답이 없는 IP만 Ping 대상으로 한다.
- Ping은 제한된 동시성으로 실행한다.
- Ping 응답이 있으면 MAC 주소가 없어도 `ACTIVE`로 판정한다.
- Ping timeout은 정상적인 미응답으로 처리한다.
- 실행 파일 부재나 권한 오류는 스캔 실패로 처리한다.

### 10.4 실행 방식

- 외부 명령은 `exec()`가 아니라 `execFile()`로 실행한다.
- 명령과 인자를 분리하고 CIDR 및 인터페이스 값을 검증한다.
- 이전 스캔이 끝나기 전에 새 스캔을 시작하지 않는다.
- 애플리케이션 시작 직후 첫 스캔을 실행한다.
- 기본 스캔 간격은 10초이며 환경 변수로 변경할 수 있다.

### 10.5 스캔 실패

다음은 스캔 실패로 처리한다.

- `arp-scan` 또는 `ping` 실행 파일이 없음
- 패킷 접근 권한이 없음
- 네트워크 인터페이스가 존재하지 않음
- 명령 제한 시간을 초과함
- 결과를 파싱할 수 없음
- 프로세스 실행 자체에 오류가 발생함

스캔이 실패하면 기존 IP 상태를 변경하지 않는다. 서버 로그에 실패 원인을 남기고 대시보드에 오류를 표시한다. 오류 정보는 메모리에 유지하며 다음 정상 스캔에 성공하면 해제한다.

## 11. 상태 모델

### 11.1 탐지 상태

| 상태 | 화면 표현 | 판정 조건 |
| --- | --- | --- |
| `ACTIVE` | 사용 중 | 이번 정상 스캔에서 ARP 또는 Ping 응답이 있음 |
| `INACTIVE` | 과거 사용 | 과거 `last_seen_at`이 있고 이번 정상 스캔에서 응답이 없음 |
| `AVAILABLE` | 미사용 추정 | `last_seen_at`이 없고 이번 정상 스캔에서 응답이 없음 |

`AVAILABLE`은 IP가 실제로 비어 있음을 보장하지 않는다. 작업자가 고정 IP를 할당하기 전에 최종 확인이 필요하다는 안내를 화면에 표시한다.

### 11.2 판정 순서

```text
ARP 응답 있음
    → ACTIVE

ARP 응답 없음 + Ping 응답 있음
    → ACTIVE

ARP/Ping 응답 없음 + 과거 사용 이력 있음
    → INACTIVE

ARP/Ping 응답 없음 + 과거 사용 이력 없음
    → AVAILABLE
```

### 11.3 값 갱신

- `ACTIVE` 응답을 확인하면 `last_seen_at`을 현재 스캔 시각으로 갱신한다.
- 최초 `ACTIVE` 확인 시 `first_seen_at`을 설정한다.
- 정상 스캔에서 판정한 IP는 `last_checked_at`을 갱신한다.
- ARP에서 새 MAC 주소를 확인하면 기존 값을 갱신한다.
- 응답이 없다는 이유만으로 기존 MAC 주소를 삭제하지 않는다.
- 메모와 예약 여부는 스캔 결과로 변경하지 않는다.

v1은 정상 스캔 한 번의 결과를 즉시 반영한다. 일시적인 패킷 손실로 상태가 자주 바뀌는 문제가 확인될 때만 연속 미응답 임계값을 추가한다.

## 12. CIDR 정책

- v1은 하나의 IPv4 CIDR만 모니터링한다.
- CIDR은 웹 화면이 아닌 `TARGET_CIDR` 환경 변수로 설정한다.
- 네트워크 인터페이스는 `NETWORK_INTERFACE` 환경 변수로 설정한다.
- 네트워크 주소와 브로드캐스트 주소는 대상에서 제외한다.
- `/31`과 `/32`는 지원하지 않는다.
- 기본 최대 호스트 수는 254개다.
- CIDR 변경 시 현재 CIDR의 IP만 화면에 표시한다.
- 같은 SQLite 파일을 사용하면 이전 CIDR의 메모와 상태는 DB에 남지만 v1 화면에서는 조회하지 않는다.

## 13. 데이터 모델

v1은 `ip_records` 테이블 하나만 애플리케이션 데이터로 사용한다. migration 관리를 위한 내부 테이블은 별도로 존재할 수 있다.

모든 시각은 UTC 기준 ISO 8601 문자열로 저장하고 화면에서 로컬 시간대로 변환한다.

### 13.1 `ip_records`

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| `cidr` | TEXT | 이 레코드를 생성한 CIDR |
| `ip_address` | TEXT | IPv4 주소 |
| `observed_status` | TEXT | `ACTIVE`, `INACTIVE`, `AVAILABLE` |
| `is_reserved` | INTEGER | 예약 여부 |
| `mac_address` | TEXT NULL | 마지막으로 확인한 MAC 주소 |
| `note` | TEXT | 디바이스명, 프로젝트명 또는 작업 메모 |
| `first_seen_at` | TEXT NULL | 최초 사용 확인 시각 |
| `last_seen_at` | TEXT NULL | 마지막 사용 확인 시각 |
| `last_checked_at` | TEXT NULL | 마지막 정상 판정 시각 |

제약 조건:

- `(cidr, ip_address)` PRIMARY KEY
- `observed_status` CHECK 제약
- `is_reserved`는 `0` 또는 `1`
- `note` 최대 1,000자

### 13.2 SQLite 설정

애플리케이션 시작 시 다음 설정을 적용한다.

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
```

외부 네트워크 명령을 실행하는 동안 DB 트랜잭션을 열어 두지 않는다. 스캔이 끝난 뒤 상태 계산 결과만 하나의 짧은 트랜잭션으로 저장한다.

## 14. HTTP 인터페이스

### 14.1 페이지와 조회

| Method | Path | 설명 |
| --- | --- | --- |
| `GET` | `/` | EJS 대시보드 렌더링 |
| `GET` | `/api/dashboard` | 현재 IP 목록, 할당 후보 수, 요약 및 메모리의 스캔 상태 조회 |
| `GET` | `/events` | SSE 연결 |

검색과 필터는 최대 254개 IP를 대상으로 브라우저에서 처리한다. 별도의 검색 API는 만들지 않는다.

### 14.2 변경

| Method | Path | 설명 |
| --- | --- | --- |
| `PATCH` | `/api/ips/:ip` | 메모 또는 예약 여부 변경 |
| `POST` | `/api/scan` | 작업자가 즉시 스캔 요청 |

`PATCH /api/ips/:ip` 요청 예시:

```json
{
  "note": "프로젝트 A 테스트 보드",
  "isReserved": true
}
```

메모와 예약 여부 중 전달된 값만 변경한다. 성공적으로 커밋한 뒤 `dashboard.updated` 이벤트를 발행한다.

### 14.3 공통 오류 형식

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "입력값을 확인해 주세요."
  }
}
```

## 15. SSE 인터페이스

### 15.1 연결

```http
GET /events
Accept: text/event-stream
```

응답 헤더:

```http
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

### 15.2 이벤트

v1은 하나의 이벤트만 사용한다.

```text
event: dashboard.updated
data: {"reason":"scan","changedIps":["172.16.3.12"],"scannedAt":"2026-09-02T01:00:05.000Z"}

```

`reason`은 `scan`, `note`, `reservation`, `scan-error`, `error-recovered` 중 하나다. 이벤트를 받은 브라우저는 변경된 IP가 적으면 해당 데이터를 갱신하고, 구현을 단순화할 필요가 있거나 재연결 직후라면 `/api/dashboard`에서 전체 스냅샷을 다시 조회한다.

스캔 실패 시에는 DB 변경 없이 메모리의 스캔 오류 상태를 갱신한 뒤 `scan-error` 이벤트를 보낸다. 그 외 데이터 변경 이벤트는 DB 커밋 후에만 발행한다.

### 15.3 재연결

- 브라우저는 `EventSource`의 자동 재연결을 사용한다.
- 재연결되면 `/api/dashboard`를 다시 조회해 최신 상태와 동기화한다.
- 서버는 15초마다 comment heartbeat를 전송한다.
- 서버 재시작 이전의 이벤트를 재생하지 않는다.

## 16. 화면 요구사항

### 16.1 대시보드

다음 정보를 한 화면에 표시한다.

- 대상 CIDR
- 마지막 정상 스캔 시각
- 현재 스캔 진행 여부 또는 스캔 오류
- `ACTIVE`, `INACTIVE`, `AVAILABLE` 개수
- 새 디바이스에 사용할 수 있는 `할당 후보` 개수
- 예약된 IP 개수
- 전체 IP 그리드
- IP, MAC 또는 메모 검색
- 상태와 예약 여부 필터

탐지 상태 수의 합은 전체 대상 IP 수와 같아야 한다. 예약 수는 탐지 상태와 중복되는 별도 지표다. 할당 후보 수는 `AVAILABLE`이면서 예약되지 않은 IP만 포함한다.

권장 표현:

- `ACTIVE`: 녹색 + “사용 중”
- `INACTIVE`: 주황색 + “과거 사용”
- `AVAILABLE`: 회색 + “미사용 추정”
- 예약됨: 별도 아이콘 또는 테두리

색상만으로 상태를 구분하지 않는다.

### 16.2 IP 상세

IP를 선택하면 다음 정보를 표시한다.

- IP 주소
- 현재 탐지 상태
- 예약 여부
- MAC 주소
- 최초 발견 시각
- 마지막 사용 확인 시각
- 마지막 검사 시각
- 작업 메모

작업자는 상세 영역에서 메모를 변경하고 IP를 예약하거나 예약 해제할 수 있다.

## 17. 설정

| 환경 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `NODE_ENV` | `development` | 실행 모드 |
| `PORT` | `3000` | HTTP 포트 |
| `DATABASE_PATH` | `./data/ip-watch.sqlite3` | SQLite 파일 경로 |
| `TARGET_CIDR` | 필수 | 모니터링할 IPv4 CIDR |
| `NETWORK_INTERFACE` | 필수 | 스캔에 사용할 인터페이스 |
| `SCAN_INTERVAL_MS` | `10000` | 스캔 주기 |
| `SCAN_TIMEOUT_MS` | `10000` | 외부 명령 제한 시간 |
| `PING_TIMEOUT_MS` | `1000` | IP별 Ping 제한 시간 |
| `PING_CONCURRENCY` | `20` | Ping 동시 실행 수 |
| `USE_MOCK_SCANNER` | 개발 시 `true` | Mock Scanner 사용 여부 |

설정값은 애플리케이션 시작 시 검증한다. 잘못된 CIDR, 허용 호스트 수 초과 또는 누락된 필수 설정이 있으면 스캔을 시작하지 않고 명확한 오류를 출력한다.

## 18. 보안과 운영

- 서비스는 신뢰된 사내 네트워크에서만 접근할 수 있어야 한다.
- 외부 인터넷에 직접 노출하지 않는다.
- 사용자 입력을 외부 명령 문자열에 연결하지 않는다.
- EJS에서 작업 메모를 escape하여 표시한다.
- 메모 길이와 요청 본문 크기를 제한한다.
- 오류 응답에 스택 트레이스나 내부 명령 전체를 노출하지 않는다.
- SQLite 파일은 서비스 사용자만 읽고 쓸 수 있게 한다.
- 시작, 스캔 성공·실패, 중복 스캔 생략을 stdout/stderr에 기록하고 systemd journal에서 확인한다.

v1은 사용자 계정과 예약 소유권을 제공하지 않는다. 접근 통제가 필요한 환경에서는 Nginx 또는 기존 사내 인증 프록시를 앞단에 둔다.

## 19. 장애 처리

| 상황 | 처리 |
| --- | --- |
| `arp-scan` 권한 없음 | 기존 상태 유지, 화면 오류 표시, 서버 로그 기록 |
| 네트워크 인터페이스 없음 | 기존 상태 유지, 화면 오류 표시 |
| 스캔 중 다음 주기 도래 | 새 실행 생략, 진행 중인 스캔 유지 |
| DB 저장 실패 | SSE 미발행, 기존 DB 상태 유지, 오류 기록 |
| SSE 연결 끊김 | 자동 재연결 후 전체 스냅샷 재조회 |
| 서버 재시작 | DB의 마지막 상태 표시 후 즉시 새 스캔 실행 |
| Ping만 응답 | `ACTIVE`, 기존 MAC 유지 또는 null |
| 예약 IP가 응답함 | `ACTIVE + RESERVED`로 표시 |

## 20. 테스트 전략

구현 세부 호출 횟수보다 작업자가 보는 결과와 데이터 안전성을 검증한다.

### 20.1 자동화 테스트

- CIDR 파싱과 네트워크·브로드캐스트 주소 제외
- ARP와 Ping 출력 파싱
- `ACTIVE`, `INACTIVE`, `AVAILABLE` 판정
- `first_seen_at`, `last_seen_at` 갱신
- 예약 여부와 탐지 상태의 독립성
- 예약되지 않은 `AVAILABLE`만 할당 후보로 계산
- 스캔 실패 시 기존 상태 유지
- 메모·예약 변경 후 SSE 알림
- SSE 재연결 후 스냅샷 동기화

### 20.2 Ubuntu 실환경 테스트

- 실제 `/24` 대역에서 IP와 MAC 탐지
- 개발 디바이스 연결 후 `ACTIVE` 표시
- 개발 디바이스 연결 해제 후 `INACTIVE` 표시
- Ping 보조 판정
- `CAP_NET_RAW`만으로 `arp-scan` 실행
- 설정된 주기에서 스캔이 중복 실행되지 않음

## 21. 인수 조건

다음 조건을 모두 충족하면 v1을 완료한 것으로 본다.

1. 작업자는 전체 IP 상태를 한 화면에서 확인할 수 있다.
2. 작업자는 사용 중인 IP와 미사용 추정 IP를 구분할 수 있다.
3. 할당 후보에는 `AVAILABLE`이면서 예약되지 않은 IP만 포함된다.
4. 작업자는 IP, MAC 또는 메모로 원하는 디바이스를 찾을 수 있다.
5. ARP 또는 Ping 응답이 있는 IP는 `ACTIVE`로 표시된다.
6. 과거 사용된 미응답 IP는 `INACTIVE`로 표시된다.
7. 한 번도 사용이 확인되지 않은 미응답 IP는 `AVAILABLE`로 표시된다.
8. `AVAILABLE`은 “미사용 추정”으로 표시되고 확정적인 빈 IP로 안내되지 않는다.
9. 작업자는 IP에 디바이스 또는 작업 메모를 저장할 수 있다.
10. 작업자는 IP를 예약하거나 예약 해제할 수 있다.
11. 예약 여부와 실제 탐지 상태를 동시에 확인할 수 있다.
12. 상태·메모·예약 변경이 새로고침 없이 화면에 반영된다.
13. 스캔 실패 시 기존 상태가 유지되고 오류가 표시된다.
14. macOS에서 Mock Scanner 기반 자동화 테스트가 통과한다.
15. Ubuntu 동일 L2 환경에서 실제 장비 탐지 테스트가 통과한다.

## 22. 권장 디렉터리 구조

```text
ip-watch/
├─ docs/
│  └─ technical-spec.md
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

## 23. 후속 버전 후보

실제 사용 중 필요성이 확인된 항목만 추가한다.

- 연속 미응답 횟수를 이용한 상태 흔들림 방지
- 예약자와 예약 만료 시각
- 여러 CIDR 또는 VLAN별 Scanner
- 상태 변경 이력과 감사 로그
- 웹 기반 네트워크 설정
- 사용자 인증과 권한
- PostgreSQL, Redis 및 다중 인스턴스
- DHCP, Router/Switch 또는 SNMP 연동
- MAC Vendor 표시

## 24. 참고 자료

- [WHATWG Server-Sent Events](https://html.spec.whatwg.org/dev/server-sent-events.html)
- [Express Template Engine Guide](https://expressjs.com/en/5x/guide/using-template-engines/)
- [SQLite Write-Ahead Logging](https://www.sqlite.org/wal.html)
- [Node.js child_process](https://nodejs.org/api/child_process.html)
- [arp-scan](https://github.com/royhills/arp-scan)
