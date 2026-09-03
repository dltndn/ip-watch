# 상태와 저장

## 상태와 예약의 분리

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

대시보드 표시와 할당 후보 카운트는 아래 **표시 상태(aging)** 가 켜져 있으면 `effectiveStatus`를 쓴다. 꺼져 있으면 `effectiveStatus == observed_status`이므로 위 정의와 같다.

## 탐지 상태

| 상태 | 화면 표현 | 판정 조건 |
| --- | --- | --- |
| `ACTIVE` | 사용 중 | 이번 정상 스캔에서 ARP 또는 Ping 응답이 있음 |
| `INACTIVE` | 과거 사용 | 과거 `last_seen_at`이 있고 이번 정상 스캔에서 응답이 없음 |
| `AVAILABLE` | 미사용 추정 | `last_seen_at`이 없고 이번 정상 스캔에서 응답이 없음 |

`AVAILABLE`은 IP가 실제로 비어 있음을 보장하지 않는다. 작업자가 고정 IP를 할당하기 전에 최종 확인이 필요하다는 안내를 화면에 표시한다.

## 판정 순서

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

이 판정 순서와 `observed_status` 저장값은 aging으로 바꾸지 않는다.

## 표시 상태(aging)

오래 응답이 없는 `INACTIVE`를 화면에서 미사용처럼 보이게 하려면 `STALE_THRESHOLD_DAYS`를 설정한다. 미설정 또는 `0`이면 aging은 꺼지고 표시는 `observed_status`와 같다.

표시용 파생 값 `effectiveStatus`는 저장하지 않는다.

```text
isStale = observed_status == INACTIVE
        && STALE_THRESHOLD_DAYS > 0
        && last_seen_at != null
        && (now - last_seen_at) > STALE_THRESHOLD_DAYS   // 엄격히 초과

effectiveStatus = isStale ? AVAILABLE : observed_status
대시보드 할당 후보 = effectiveStatus == AVAILABLE && is_reserved == false
```

stale로 표시된 IP는 드로어에서 "과거 사용 이력"과 `last_seen_at`을 함께 보여 저장 이력을 숨기지 않는다.

## 값 갱신

- `ACTIVE` 응답을 확인하면 `last_seen_at`을 현재 스캔 시각으로 갱신한다.
- 최초 `ACTIVE` 확인 시 `first_seen_at`을 설정한다.
- 정상 스캔에서 판정한 IP는 `last_checked_at`을 갱신한다.
- ARP에서 새 MAC 주소를 확인하면 기존 값을 갱신한다.
- 응답이 없다는 이유만으로 기존 MAC 주소를 삭제하지 않는다.
- 메모와 예약 여부는 스캔 결과로 변경하지 않는다.

v1은 정상 스캔 한 번의 결과를 즉시 반영한다. 일시적인 패킷 손실로 상태가 자주 바뀌는 문제가 확인될 때만 연속 미응답 임계값을 추가한다.

## 데이터 모델

v1은 `ip_records` 테이블 하나만 애플리케이션 데이터로 사용한다. migration 관리를 위한 내부 테이블은 별도로 존재할 수 있다.

모든 시각은 UTC 기준 ISO 8601 문자열로 저장하고 화면에서 로컬 시간대로 변환한다.

### `ip_records`

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

## SQLite 설정

애플리케이션 시작 시 다음 설정을 적용한다.

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
```

외부 네트워크 명령을 실행하는 동안 DB 트랜잭션을 열어 두지 않는다. 스캔이 끝난 뒤 상태 계산 결과만 하나의 짧은 트랜잭션으로 저장한다.

## 참고 자료

- [SQLite Write-Ahead Logging](https://www.sqlite.org/wal.html)
