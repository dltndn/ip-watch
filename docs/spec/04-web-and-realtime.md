# 웹 화면과 실시간 통신

## HTTP 인터페이스

### 페이지와 조회

| Method | Path | 설명 |
| --- | --- | --- |
| `GET` | `/` | EJS 대시보드 렌더링 |
| `GET` | `/api/dashboard` | 현재 IP 목록, 할당 후보 수, 요약 및 메모리의 스캔 상태 조회 |
| `GET` | `/events` | SSE 연결 |

검색과 필터는 최대 254개 IP를 대상으로 브라우저에서 처리한다. 별도의 검색 API는 만들지 않는다.

### 변경

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

### 공통 오류 형식

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "입력값을 확인해 주세요."
  }
}
```

## SSE 인터페이스

### 연결

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

### 이벤트

v1은 하나의 이벤트만 사용한다.

```text
event: dashboard.updated
data: {"reason":"scan","changedIps":["172.16.3.12"],"scannedAt":"2026-09-02T01:00:05.000Z"}

```

`reason`은 `scan`, `note`, `reservation`, `scan-error`, `error-recovered` 중 하나다. 이벤트를 받은 브라우저는 변경된 IP가 적으면 해당 데이터를 갱신하고, 구현을 단순화할 필요가 있거나 재연결 직후라면 `/api/dashboard`에서 전체 스냅샷을 다시 조회한다.

스캔 실패 시에는 DB 변경 없이 메모리의 스캔 오류 상태를 갱신한 뒤 `scan-error` 이벤트를 보낸다. 그 외 데이터 변경 이벤트는 DB 커밋 후에만 발행한다.

### 재연결

- 브라우저는 `EventSource`의 자동 재연결을 사용한다.
- 재연결되면 `/api/dashboard`를 다시 조회해 최신 상태와 동기화한다.
- 서버는 15초마다 comment heartbeat를 전송한다.
- 서버 재시작 이전의 이벤트를 재생하지 않는다.

## 화면 요구사항

### 대시보드

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

### IP 상세

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

상태 필드와 할당 후보 계산은 [03-state-and-storage.md](./03-state-and-storage.md)를 따른다.

## 참고 자료

- [WHATWG Server-Sent Events](https://html.spec.whatwg.org/dev/server-sent-events.html)
- [Express Template Engine Guide](https://expressjs.com/en/5x/guide/using-template-engines/)
