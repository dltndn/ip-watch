# 테스트와 인수 조건

## 테스트 원칙

구현 세부 호출 횟수보다 작업자가 보는 결과와 데이터 안전성을 검증한다.

## 자동화 테스트

- Docker image가 재현 가능하게 빌드됨
- `compose.yaml`과 `compose.dev.yaml`이 `docker compose config` 검증을 통과함
- macOS 개발 Compose가 Mock Scanner로 기동되고 HTTP healthcheck를 통과함
- CIDR 파싱과 네트워크·브로드캐스트 주소 제외
- ARP와 Ping 출력 파싱
- `ACTIVE`, `INACTIVE`, `AVAILABLE` 판정
- `first_seen_at`, `last_seen_at` 갱신
- 예약 여부와 탐지 상태의 독립성
- 예약되지 않은 `AVAILABLE`만 할당 후보로 계산
- 스캔 실패 시 기존 상태 유지
- 메모·예약 변경 후 SSE 알림
- SSE 재연결 후 스냅샷 동기화

## Ubuntu 실환경 테스트

- Docker Engine과 `compose.yaml`로 컨테이너 기동
- 컨테이너가 root가 아니며 `privileged` 없이 `NET_RAW`만 사용
- host network에서 Ubuntu 호스트 인터페이스 확인
- 실제 `/24` 대역에서 IP와 MAC 탐지
- 개발 디바이스 연결 후 `ACTIVE` 표시
- 개발 디바이스 연결 해제 후 `INACTIVE` 표시
- Ping 보조 판정
- `CAP_NET_RAW`만으로 `arp-scan` 실행
- 설정된 주기에서 스캔이 중복 실행되지 않음
- 컨테이너 재생성 후 named volume의 SQLite 데이터와 메모가 유지됨
- `SIGTERM` 수신 시 `stop_grace_period` 안에 정상 종료

## v1 인수 조건

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
14. macOS에서 `compose.dev.yaml`과 Mock Scanner 기반 자동화 테스트가 통과한다.
15. Ubuntu에서 `compose.yaml`로 단일 컨테이너를 기동할 수 있다.
16. 운영 컨테이너는 `privileged` 없이 host network와 `NET_RAW`만으로 실제 장비를 탐지한다.
17. 컨테이너를 재생성해도 named volume의 SQLite 데이터가 유지된다.
18. Ubuntu 동일 L2 환경에서 실제 장비 탐지 테스트가 통과한다.

테스트를 작성할 때는 대상 동작에 따라 [README.md](./README.md)에서 관련 영역 스펙을 찾아 함께 읽는다.
