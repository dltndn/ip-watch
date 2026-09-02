# 네트워크 스캔

## 실행 흐름

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

상태 판정과 저장 규칙은 [03-state-and-storage.md](./03-state-and-storage.md)를 따른다.

## ARP Scan

- 설정된 CIDR과 네트워크 인터페이스를 대상으로 `arp-scan`을 실행한다.
- 응답에서 IPv4 주소와 MAC 주소를 추출한다.
- MAC 주소는 소문자 콜론 형식으로 정규화한다.
- 중복 응답은 IP 기준으로 합친다.
- ARP 응답이 있으면 해당 IP를 `ACTIVE`로 판정한다.

## Ping 보조 확인

- ARP 응답이 없는 IP만 Ping 대상으로 한다.
- Ping은 제한된 동시성으로 실행한다.
- Ping 응답이 있으면 MAC 주소가 없어도 `ACTIVE`로 판정한다.
- Ping timeout은 정상적인 미응답으로 처리한다.
- 실행 파일 부재나 권한 오류는 스캔 실패로 처리한다.

## 실행 방식

- 외부 명령은 `exec()`가 아니라 `execFile()`로 실행한다.
- 명령과 인자를 분리하고 CIDR 및 인터페이스 값을 검증한다.
- `arp-scan`과 `ping`은 호스트가 아니라 런타임 Docker 이미지에 설치한다.
- 이전 스캔이 끝나기 전에 새 스캔을 시작하지 않는다.
- 애플리케이션 시작 직후 첫 스캔을 실행한다.
- 기본 스캔 간격은 10초이며 환경 변수로 변경할 수 있다.

## Docker 네트워크와 권한

### Ubuntu 운영

ARP는 동일한 L2 네트워크에서 동작하므로 운영 컨테이너는 Ubuntu Docker Engine에서 `network_mode: host`를 사용한다. 컨테이너는 호스트 네트워크 namespace를 공유하며 `NETWORK_INTERFACE`에는 Ubuntu 호스트의 실제 인터페이스 이름을 지정한다.

- host network 사용 시 Compose의 `ports` 설정을 함께 사용하지 않는다.
- 컨테이너를 `privileged: true`로 실행하지 않는다.
- Compose에서 모든 Linux capability를 제거한 뒤 `NET_RAW`만 추가한다.
- Dockerfile에서 `arp-scan` 실행 파일에 `cap_net_raw+p`를 설정한다.
- 애플리케이션 프로세스는 root가 아닌 전용 사용자로 실행한다.
- Docker socket과 호스트의 `/dev` 전체를 컨테이너에 마운트하지 않는다.

### macOS 개발

Docker Desktop의 host networking은 TCP와 UDP 연결을 제공하지만 ARP처럼 TCP/UDP보다 아래 계층의 프로토콜을 운영 Ubuntu와 동일하게 제공하지 않는다. 따라서 macOS 컨테이너에서는 실제 ARP 탐지를 검증하지 않는다.

- `compose.dev.yaml`은 일반 bridge network와 localhost 포트 매핑을 사용한다.
- `USE_MOCK_SCANNER=true`로 실행한다.
- 실제 스캔 권한과 L2 탐지는 Ubuntu Docker Engine 환경에서만 인수한다.

## 스캔 실패

다음은 스캔 실패로 처리한다.

- `arp-scan` 또는 `ping` 실행 파일이 없음
- 패킷 접근 권한이 없음
- 네트워크 인터페이스가 존재하지 않음
- 운영 컨테이너가 host network를 사용하지 않아 대상 인터페이스에 접근할 수 없음
- 명령 제한 시간을 초과함
- 결과를 파싱할 수 없음
- 프로세스 실행 자체에 오류가 발생함

스캔이 실패하면 기존 IP 상태를 변경하지 않는다. 서버 로그에 실패 원인을 남기고 대시보드에 오류를 표시한다. 오류 정보는 메모리에 유지하며 다음 정상 스캔에 성공하면 해제한다.

## CIDR 정책

- v1은 하나의 IPv4 CIDR만 모니터링한다.
- CIDR은 웹 화면이 아닌 `TARGET_CIDR` 환경 변수로 설정한다.
- 네트워크 인터페이스는 `NETWORK_INTERFACE` 환경 변수로 설정한다.
- 네트워크 주소와 브로드캐스트 주소는 대상에서 제외한다.
- `/31`과 `/32`는 지원하지 않는다.
- 기본 최대 호스트 수는 254개다.
- CIDR 변경 시 현재 CIDR의 IP만 화면에 표시한다.
- 같은 SQLite 파일을 사용하면 이전 CIDR의 메모와 상태는 DB에 남지만 v1 화면에서는 조회하지 않는다.

## 참고 자료

- [Node.js child_process](https://nodejs.org/api/child_process.html)
- [arp-scan](https://github.com/royhills/arp-scan)
- [Docker host network driver](https://docs.docker.com/engine/network/drivers/host/)
- [Docker Compose service capabilities](https://docs.docker.com/reference/compose-file/services/)
