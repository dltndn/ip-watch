# 실행 환경과 운영

## 개발 환경

기본 개발 환경은 macOS로 한다.

macOS에서는 다음 항목을 개발하고 검증한다.

- Express 및 EJS 화면
- HTTP API와 SSE 연결
- SQLite 저장과 상태 판정
- Mock Scanner를 이용한 디바이스 연결·해제 시나리오
- 단위 테스트와 HTTP 통합 테스트

실제 `arp-scan`은 macOS에서도 실행할 수 있지만 네트워크 인터페이스와 패킷 접근 권한이 Ubuntu와 다를 수 있다. macOS의 실제 스캔 결과를 운영 적합성 판정 기준으로 사용하지 않는다.

## 운영 및 실환경 테스트

운영 환경은 Ubuntu Server LTS로 한다.

- 서버는 대상 CIDR과 동일한 L2 네트워크에 배치한다.
- 애플리케이션은 전용 OS 사용자로 실행한다.
- 애플리케이션 전체를 root로 실행하지 않는다.
- `arp-scan`에는 필요한 최소 권한인 `CAP_NET_RAW`만 부여한다.
- SQLite 파일은 서비스 사용자가 읽고 쓸 수 있는 전용 디렉터리에 저장한다.
- systemd를 이용하여 부팅 시 자동 실행하고 비정상 종료 시 재시작한다.

실제 장비의 연결·해제, ARP/Ping 결과와 실행 권한은 Ubuntu 환경에서 검증한다. Docker Desktop은 운영 서버와 동일한 L2 환경을 완전히 재현하는 수단으로 간주하지 않는다.

## 설정

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

## 보안과 운영

- 서비스는 신뢰된 사내 네트워크에서만 접근할 수 있어야 한다.
- 외부 인터넷에 직접 노출하지 않는다.
- 사용자 입력을 외부 명령 문자열에 연결하지 않는다.
- EJS에서 작업 메모를 escape하여 표시한다.
- 메모 길이와 요청 본문 크기를 제한한다.
- 오류 응답에 스택 트레이스나 내부 명령 전체를 노출하지 않는다.
- SQLite 파일은 서비스 사용자만 읽고 쓸 수 있게 한다.
- 시작, 스캔 성공·실패, 중복 스캔 생략을 stdout/stderr에 기록하고 systemd journal에서 확인한다.

v1은 사용자 계정과 예약 소유권을 제공하지 않는다. 접근 통제가 필요한 환경에서는 Nginx 또는 기존 사내 인증 프록시를 앞단에 둔다.

## 장애 처리

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

스캔 세부 실패 조건은 [02-network-scanning.md](./02-network-scanning.md)를 따른다.
