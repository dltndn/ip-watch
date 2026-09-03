# 실행 환경과 운영

## 실행 원칙

개발과 운영 모두 Docker Compose로 애플리케이션을 실행한다. 호스트에 Node.js, `arp-scan`, `ping` 또는 npm 패키지를 직접 설치하는 방식은 공식 실행 경로로 지원하지 않는다.

| 환경 | 컨테이너 런타임 | Compose 파일 | Scanner | 네트워크 |
| --- | --- | --- | --- | --- |
| macOS 개발 | Docker Desktop | `compose.dev.yaml` | Mock Scanner | bridge + localhost 포트 매핑 |
| Ubuntu 운영 | Docker Engine + Compose v2 | `compose.yaml` | 실제 ARP/Ping Scanner | host network |

두 Compose 파일은 실행 목적과 네트워크 제약이 다르므로 서로 독립적으로 실행할 수 있게 작성한다.

## Docker 이미지

### 베이스 이미지

- 공식 Node.js LTS Debian 기반 이미지를 사용한다.
- Node.js 메이저 버전은 `package.json`의 `engines`와 동일하게 고정한다.
- Alpine 이미지는 필수 도구와 native dependency 호환성을 별도로 검증하기 전에는 사용하지 않는다.

### 빌드 구조

Dockerfile은 multi-stage build로 작성한다.

1. build stage에서 npm 의존성을 설치하고 TypeScript를 컴파일한다.
2. runtime stage에는 production 의존성, 빌드 결과, EJS view, 정적 파일과 DB 초기화 파일만 복사한다.
3. runtime stage에 `arp-scan`, `iputils-ping`, `libcap2-bin`을 설치한다.
4. `arp-scan` 실행 파일에 `cap_net_raw+p`를 설정한다.
5. `/app/data`를 생성하고 애플리케이션 전용 사용자가 쓸 수 있게 한다.
6. 최종 프로세스는 root가 아닌 전용 사용자로 실행한다.

`.dockerignore`에는 최소한 다음 항목을 포함한다.

```text
.git
node_modules
dist
data
*.sqlite3
.env
coverage
```

## macOS 개발 환경

기본 개발 환경은 macOS와 Docker Desktop이다.

```sh
docker compose -f compose.dev.yaml up --build
```

`compose.dev.yaml`은 다음 조건을 만족해야 한다.

- `USE_MOCK_SCANNER=true`
- Docker 기본 bridge network 사용
- 웹 포트는 `127.0.0.1`에만 publish
- 개발용 소스 mount 또는 development image target 사용 가능
- SQLite는 개발용 named volume에 저장

macOS에서는 다음 항목을 검증한다.

- Express 및 EJS 화면
- HTTP API와 SSE 연결
- SQLite 저장과 상태 판정
- Mock Scanner를 이용한 디바이스 연결·해제 시나리오
- 단위 테스트와 HTTP 통합 테스트
- 이미지 빌드와 Compose 기동

Docker Desktop의 네트워크는 운영 Ubuntu의 L2 환경을 재현하지 않는다. macOS 컨테이너의 실제 ARP 결과를 운영 적합성 판정 기준으로 사용하지 않는다.

## Ubuntu 운영 환경

운영 환경은 Ubuntu Server LTS, Docker Engine, Docker Compose v2로 한다.

```sh
docker compose -f compose.yaml up -d --build
```

- Ubuntu 서버는 대상 CIDR과 동일한 L2 네트워크에 배치한다.
- 애플리케이션은 하나의 컨테이너 인스턴스로 실행한다.
- 운영 Compose는 `network_mode: host`를 사용하며 `ports`를 선언하지 않는다.
- `restart: unless-stopped`를 사용한다.
- HTTP 응답을 확인하는 container healthcheck를 제공한다.
- `stop_grace_period`는 기본 30초로 설정한다.
- Docker Engine은 Ubuntu 부팅 시 자동 시작하도록 구성한다.
- 호스트에 애플리케이션용 Node.js나 네트워크 스캔 도구를 별도로 설치하지 않는다.

운영 Compose의 최소 구조는 다음과 같다.

```yaml
services:
  ip-watch:
    build:
      context: .
    env_file:
      - .env
    network_mode: host
    cap_drop:
      - ALL
    cap_add:
      - NET_RAW
    volumes:
      - ip-watch-data:/app/data
    restart: unless-stopped
    stop_grace_period: 30s

volumes:
  ip-watch-data:
```

실제 스캔에 필요한 Docker 네트워크 및 capability 조건은 [02-network-scanning.md](./02-network-scanning.md)를 따른다.

## 데이터 영속화

- SQLite 경로는 `/app/data/ip-watch.sqlite3`로 한다.
- `/app/data`에는 Docker named volume `ip-watch-data`를 mount한다.
- 컨테이너를 교체하거나 재생성해도 named volume은 유지한다.
- 운영 중 `docker compose down -v`를 사용하지 않는다. `-v`는 SQLite 데이터를 포함한 named volume을 삭제할 수 있다.
- 동일한 volume을 둘 이상의 애플리케이션 컨테이너가 동시에 쓰지 않는다.
- 백업은 named volume을 읽는 별도 일회성 컨테이너 또는 SQLite backup 절차를 사용한다.

## 설정

`.env.example`을 저장소에 포함하고 실제 `.env`는 Git에 커밋하지 않는다.

| 환경 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `NODE_ENV` | `development` | 실행 모드 |
| `BIND_ADDRESS` | `0.0.0.0` | 컨테이너 내부 HTTP bind 주소 |
| `PORT` | `3000` | HTTP 포트 |
| `DATABASE_PATH` | `/app/data/ip-watch.sqlite3` | named volume 내부 SQLite 경로 |
| `TARGET_CIDR` | 필수 | 모니터링할 IPv4 CIDR |
| `NETWORK_INTERFACE` | 실제 Scanner에서 필수 | Ubuntu 호스트의 대상 인터페이스 |
| `SCAN_INTERVAL_MS` | `10000` | 스캔 주기 |
| `SCAN_TIMEOUT_MS` | `10000` | 외부 명령 제한 시간 |
| `PING_TIMEOUT_MS` | `1000` | IP별 Ping 제한 시간 |
| `PING_CONCURRENCY` | `20` | Ping 동시 실행 수 |
| `USE_MOCK_SCANNER` | 개발 `true`, 운영 `false` | Mock Scanner 사용 여부 |
| `STALE_THRESHOLD_DAYS` | `0` (꺼짐) | 오래 응답 없는 `INACTIVE`를 표시상 `AVAILABLE`로 보는 일 수. 미설정/`0`이면 끄고, 최대 `36500` |

설정값은 애플리케이션 시작 시 검증한다. 잘못된 CIDR, 허용 호스트 수 초과 또는 누락된 필수 설정이 있으면 스캔을 시작하지 않고 컨테이너를 오류 상태로 종료한다.

환경 변수를 변경한 뒤에는 `docker compose restart`만 실행하지 않는다. Compose 설정을 다시 적용할 수 있도록 `docker compose up -d`로 컨테이너를 재생성한다.

## 종료 처리

Docker가 보내는 `SIGTERM`을 받으면 다음 순서로 종료한다.

1. 새 스캔 시작을 중단한다.
2. 진행 중인 스캔을 취소하거나 제한 시간까지 기다린다.
3. SSE 및 HTTP 연결을 종료한다.
4. SQLite 연결을 닫는다.
5. 종료 코드를 반환한다.

종료가 `stop_grace_period` 안에 끝나지 않으면 Docker가 강제 종료할 수 있으므로 외부 명령에는 반드시 timeout을 적용한다.

## 보안과 권한

- 서비스는 신뢰된 사내 네트워크에서만 접근할 수 있어야 한다.
- 외부 인터넷에 직접 노출하지 않는다.
- 운영 컨테이너에 `privileged: true`를 사용하지 않는다.
- 모든 Linux capability를 제거한 뒤 `NET_RAW`만 추가한다.
- Docker socket, 호스트 root 파일시스템 또는 `/dev` 전체를 mount하지 않는다.
- 사용자 입력을 외부 명령 문자열에 연결하지 않는다.
- EJS에서 작업 메모를 escape하여 표시한다.
- 메모 길이와 요청 본문 크기를 제한한다.
- 오류 응답에 스택 트레이스나 내부 명령 전체를 노출하지 않는다.
- SQLite volume은 애플리케이션 사용자만 쓸 수 있게 한다.

v1은 사용자 계정과 예약 소유권을 제공하지 않는다. 접근 통제가 필요한 환경에서는 호스트 방화벽, Nginx 또는 기존 사내 인증 프록시를 사용한다.

## 운영 명령과 로그

| 목적 | 명령 |
| --- | --- |
| 빌드 및 시작 | `docker compose -f compose.yaml up -d --build` |
| 상태 확인 | `docker compose -f compose.yaml ps` |
| 로그 확인 | `docker compose -f compose.yaml logs -f ip-watch` |
| 설정 반영 | `docker compose -f compose.yaml up -d` |
| 중지 | `docker compose -f compose.yaml down` |

애플리케이션은 시작, 설정 오류, 스캔 성공·실패, 중복 스캔 생략 및 정상 종료를 stdout/stderr에 기록한다. 로그는 Docker logging driver를 통해 확인한다.

## 장애 처리

| 상황 | 처리 |
| --- | --- |
| 이미지에 `arp-scan` 또는 `ping`이 없음 | 시작 또는 스캔 실패, 기존 상태 유지, 오류 로그 |
| `NET_RAW` 또는 실행 파일 capability 없음 | 기존 상태 유지, 화면 오류 표시, 서버 로그 기록 |
| host network를 사용하지 않음 | 대상 인터페이스 확인 실패, 기존 상태 유지 |
| 네트워크 인터페이스 없음 | 기존 상태 유지, 화면 오류 표시 |
| named volume mount 또는 쓰기 권한 오류 | 시작 실패, DB를 임시 경로에 생성하지 않음 |
| healthcheck 실패 | 컨테이너 상태를 unhealthy로 표시하고 로그 확인 |
| 스캔 중 다음 주기 도래 | 새 실행 생략, 진행 중인 스캔 유지 |
| DB 저장 실패 | SSE 미발행, 기존 DB 상태 유지, 오류 기록 |
| SSE 연결 끊김 | 자동 재연결 후 전체 스냅샷 재조회 |
| 컨테이너 재시작 | volume의 마지막 DB 상태 표시 후 즉시 새 스캔 실행 |
| Ping만 응답 | `ACTIVE`, 기존 MAC 유지 또는 null |
| 예약 IP가 응답함 | `ACTIVE + RESERVED`로 표시 |

스캔 세부 실패 조건은 [02-network-scanning.md](./02-network-scanning.md)를 따른다.

## 참고 자료

- [Docker host network driver](https://docs.docker.com/engine/network/drivers/host/)
- [Docker Compose services](https://docs.docker.com/reference/compose-file/services/)
- [Docker storage](https://docs.docker.com/engine/storage/)
- [Docker multi-stage builds](https://docs.docker.com/build/building/multi-stage/)
- [Official Node.js Docker image](https://github.com/nodejs/docker-node)
