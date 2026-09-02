# 스펙 문서 라우터

이 파일은 스펙 본문이나 작업 진행 상태를 담지 않는다. 현재 작업에 필요한 문서만 찾기 위한 라우터로 사용한다.

## 문서 목록

| 문서 | 다루는 내용 |
| --- | --- |
| [00-product-scope.md](./00-product-scope.md) | 사용자, 문제, 목표, 비목표, MVP 범위 |
| [01-architecture-and-stack.md](./01-architecture-and-stack.md) | 핵심 설계 결정, 기술 스택, 시스템과 코드 구조 |
| [02-network-scanning.md](./02-network-scanning.md) | ARP/Ping 스캔, 실행 주기, CIDR 정책, 스캔 실패 |
| [03-state-and-storage.md](./03-state-and-storage.md) | 상태 판정, 예약 모델, SQLite 데이터 모델 |
| [04-web-and-realtime.md](./04-web-and-realtime.md) | EJS 화면, HTTP API, SSE 계약 |
| [05-runtime-and-operations.md](./05-runtime-and-operations.md) | Docker, macOS/Ubuntu 환경, 설정, 보안, 운영, 장애 처리 |
| [06-testing-and-acceptance.md](./06-testing-and-acceptance.md) | 자동화·실환경 테스트와 v1 인수 조건 |
| [07-future-scope.md](./07-future-scope.md) | MVP 이후 검토할 확장 범위 |

## 작업별 읽기 경로

| 작업 유형 | 먼저 읽을 문서 | 함께 읽을 문서 |
| --- | --- | --- |
| 제품 요구사항, 사용자 흐름 또는 MVP 범위 변경 | `00-product-scope.md` | 영향받는 모든 영역 문서 |
| 의존성, 기술 스택, 모듈 경계 또는 디렉터리 구조 변경 | `01-architecture-and-stack.md` | 변경 대상 영역 문서 |
| `arp-scan`, Ping, CIDR, 파서 또는 스캔 루프 작업 | `02-network-scanning.md` | 상태 변경 시 `03-state-and-storage.md`, 운영 설정 변경 시 `05-runtime-and-operations.md` |
| 상태 판정, 예약, 할당 후보 또는 SQLite 작업 | `03-state-and-storage.md` | 스캔 입력은 `02-network-scanning.md`, 화면 표현은 `04-web-and-realtime.md` |
| EJS, 브라우저 스크립트, 검색, HTTP API 또는 SSE 작업 | `04-web-and-realtime.md` | 상태 필드는 `03-state-and-storage.md` |
| Dockerfile, Compose, 컨테이너 네트워크, 환경 변수, macOS 개발, Ubuntu 배포, 권한, 로그 또는 장애 처리 | `05-runtime-and-operations.md` | 구조 변경은 `01-architecture-and-stack.md`, 스캔 권한·실행은 `02-network-scanning.md` |
| 테스트 추가, 회귀 검증 또는 완료 판정 | `06-testing-and-acceptance.md` | 테스트 대상 영역 문서 |
| MVP 밖의 기능을 제안하거나 검토 | `07-future-scope.md` | `00-product-scope.md` 및 영향받는 영역 문서 |
| 저장소 전반의 교차 영역 변경 | `00-product-scope.md`, `01-architecture-and-stack.md` | 영향받는 모든 영역 문서 |
