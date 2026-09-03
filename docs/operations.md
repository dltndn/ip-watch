# IP Watch 운영 가이드

이 문서는 Ubuntu Server LTS의 Docker Engine과 Docker Compose v2에서 IP Watch 단일 인스턴스를 운영하는 절차를 설명한다. 운영 호스트는 대상 CIDR과 같은 L2 네트워크에 있어야 하며 서비스는 신뢰된 사내망에서만 접근시킨다.

## 1. 사전 준비

Docker Engine과 Compose plugin은 [Docker의 Ubuntu 설치 가이드](https://docs.docker.com/engine/install/ubuntu/)에 따라 공식 apt 저장소에서 설치한다. 설치 후 Docker가 부팅 때 자동으로 시작되는지 확인한다.

```sh
sudo systemctl enable --now docker
sudo systemctl is-enabled docker
sudo systemctl is-active docker
docker compose version
```

Docker 명령을 `sudo` 없이 실행할 수 있는 사용자는 사실상 호스트 root 권한을 가질 수 있다. 운영 계정과 `docker` 그룹 구성원은 최소화한다.

저장소를 Ubuntu 호스트에 배치한 뒤 실제 네트워크 값을 찾는다.

```sh
ip -br link
ip -4 route
cp .env.example .env
chmod 600 .env
```

`.env`에서 다음 값은 반드시 운영 환경에 맞게 바꾼다.

- `TARGET_CIDR`: 감시할 단일 IPv4 CIDR. v1은 최대 254개 usable host만 지원한다.
- `NETWORK_INTERFACE`: `ip -br link`에 표시되는 대상 L2 인터페이스 이름.
- `PORT`: 사내망에서 접근할 HTTP 포트. 기본값은 `3000`이다.

`DATABASE_PATH=/app/data/ip-watch.sqlite3`, `USE_MOCK_SCANNER=false`는 운영 기본값을 유지한다. `.env`는 Git에 커밋하지 않는다.

## 2. 빌드와 시작

먼저 렌더링된 Compose 설정을 확인한 뒤 한 인스턴스만 시작한다.

```sh
docker compose -f compose.yaml config
docker compose -f compose.yaml config --services
docker compose -f compose.yaml up -d --build
docker compose -f compose.yaml ps
```

`config --services` 결과는 `ip-watch` 하나여야 한다. 같은 `ip-watch-data` volume을 사용하는 별도 IP Watch 컨테이너를 동시에 실행하지 않는다.

healthcheck와 HTTP 응답을 확인한다.

```sh
docker compose -f compose.yaml ps
curl --fail --show-error http://127.0.0.1:3000/health
```

`PORT`를 변경했다면 `curl`의 포트도 같은 값으로 바꾼다.

## 3. 최소 권한 검증

운영 이미지의 최종 프로세스는 `node` 사용자로 실행되고 Compose는 모든 capability를 제거한 뒤 `NET_RAW`만 추가한다. `privileged`, Docker socket, 호스트 root, `/dev` 전체 mount는 사용하지 않는다.

```sh
docker compose -f compose.yaml exec ip-watch id
docker compose -f compose.yaml exec ip-watch getcap /usr/sbin/arp-scan
docker inspect "$(docker compose -f compose.yaml ps -q ip-watch)" \
  --format 'user={{.Config.User}} privileged={{.HostConfig.Privileged}} network={{.HostConfig.NetworkMode}} cap_add={{json .HostConfig.CapAdd}} cap_drop={{json .HostConfig.CapDrop}}'
```

기대 결과는 다음과 같다.

- `id`의 uid가 `0`이 아니다.
- `arp-scan`에 `cap_net_raw=p`가 표시된다.
- `user=node`, `privileged=false`, `network=host`, `cap_add=["NET_RAW"]`, `cap_drop=["ALL"]`이다.

`network_mode: host`이므로 Compose에 `ports`를 추가하지 않는다. 호스트 방화벽에서 `PORT`를 필요한 사내 CIDR에만 허용한다. 인터넷 경계에서는 포트를 열지 말고, 접근 통제가 필요하면 Nginx나 기존 사내 인증 프록시 뒤에 둔다.

## 4. 상태, 로그, 설정 변경

```sh
docker compose -f compose.yaml ps
docker compose -f compose.yaml logs --tail=200 ip-watch
docker compose -f compose.yaml logs -f ip-watch
```

로그에는 시작, 스캔 시작·성공·실패, 중복 실행 생략, 종료 시작·완료가 기록된다. 로그는 Docker의 `json-file` driver로 보관하며 Compose에서 파일당 10 MB, 최대 3개로 회전한다.

환경 변수나 Compose 설정을 바꾼 뒤에는 `restart`만 사용하지 않는다. 변경된 설정으로 컨테이너가 재생성되도록 실행한다.

```sh
docker compose -f compose.yaml config
docker compose -f compose.yaml up -d
```

이미지 코드까지 갱신했다면 `--build`를 함께 사용한다.

## 5. 중지, 재생성, 재부팅 복구

정상 중지는 다음 명령을 사용한다.

```sh
docker compose -f compose.yaml stop
docker compose -f compose.yaml down
```

`SIGTERM`을 받으면 새 스캔을 막고 진행 중 명령을 취소한 뒤 SSE/HTTP와 SQLite를 순서대로 닫는다. Compose는 최대 30초를 기다린다. 종료 로그에서 `Shutdown complete`를 확인한다.

`docker compose down -v`는 사용하지 않는다. `-v`는 SQLite가 저장된 named volume을 삭제한다. 일반 `down`, 컨테이너 재생성, 이미지 교체에는 named volume이 유지된다.

재생성 후 데이터 보존은 다음처럼 확인한다.

```sh
docker compose -f compose.yaml up -d --force-recreate
docker compose -f compose.yaml ps
```

Compose의 `restart: unless-stopped`와 활성화된 Docker Engine이 비정상 종료 및 호스트 재부팅 뒤 서비스를 복구한다. 운영자가 직접 `stop`한 컨테이너는 의도적으로 중지 상태를 유지할 수 있다.

## 6. SQLite 온라인 백업

[Docker volume 백업 지침](https://docs.docker.com/engine/storage/volumes/#back-up-restore-or-migrate-data-volumes)에 따라 별도 일회성 컨테이너로 named volume을 읽는다. 실행 중인 SQLite와 WAL의 일관성을 위해 단순 파일 복사 대신 `better-sqlite3`의 backup API를 사용한다.

```sh
mkdir -p backups
backup_name="ip-watch-$(date -u +%Y%m%dT%H%M%SZ).sqlite3"
docker compose -f compose.yaml run --rm --no-deps \
  -v "$PWD/backups:/backup" \
  -e BACKUP_NAME="$backup_name" \
  ip-watch node --input-type=module -e "import Database from 'better-sqlite3'; const db = new Database('/app/data/ip-watch.sqlite3', { readonly: true }); await db.backup('/backup/' + process.env.BACKUP_NAME); db.close();"
test -s "backups/$backup_name"
```

백업 파일은 애플리케이션 호스트와 분리된 접근 제한 저장소로 복사하고 보존 정책에 따라 관리한다. 백업용 일회성 컨테이너는 HTTP 서버나 스캔 루프를 시작하지 않는다.

## 7. SQLite 복구

복구는 현재 DB를 덮어쓰므로 먼저 원하는 백업 파일을 별도 위치에 보존하고 서비스가 멈췄는지 확인한다.

```sh
restore_name="ip-watch-YYYYMMDDTHHMMSSZ.sqlite3"
test -s "backups/$restore_name"
docker compose -f compose.yaml stop ip-watch
docker compose -f compose.yaml run --rm --no-deps \
  -v "$PWD/backups:/backup:ro" \
  -e RESTORE_NAME="$restore_name" \
  ip-watch node --input-type=module -e "import fs from 'node:fs'; const target = '/app/data/ip-watch.sqlite3'; fs.rmSync(target + '-wal', { force: true }); fs.rmSync(target + '-shm', { force: true }); fs.copyFileSync('/backup/' + process.env.RESTORE_NAME, target);"
docker compose -f compose.yaml up -d
docker compose -f compose.yaml ps
curl --fail --show-error http://127.0.0.1:3000/health
```

복구 후 대시보드에서 메모·예약·마지막 상태가 백업 시점과 일치하는지 확인한다.

## 8. 장애 대응

| 증상 | 확인과 조치 |
| --- | --- |
| 컨테이너가 시작 직후 종료 | `docker compose logs ip-watch`에서 필수 설정, CIDR, 인터페이스, DB 권한 오류를 확인한다. 임시 DB 경로로 우회하지 않는다. |
| `unhealthy` | `/health` 응답, `PORT`, 프로세스 로그를 확인한다. healthcheck는 컨테이너를 자동 재시작시키지 않으므로 원인을 수정한다. |
| ARP/Ping 권한 오류 | 최소 권한 검증 명령으로 non-root, `NET_RAW`, `arp-scan` file capability를 다시 확인한다. `privileged: true`로 우회하지 않는다. |
| 인터페이스 없음 또는 스캔 전체 실패 | Ubuntu 호스트의 `ip -br link`, `.env`의 `NETWORK_INTERFACE`, host network 설정을 확인한다. DB의 기존 상태는 보존된다. |
| DB 쓰기 실패 | `ip-watch-data` mount와 `/app/data` 소유권을 확인한다. 같은 volume을 쓰는 두 번째 앱 컨테이너가 없는지 확인한다. |
| SSE 연결 끊김 | 브라우저가 자동 재연결한 뒤 전체 스냅샷을 다시 가져오는지 확인하고 프록시 buffering 설정을 점검한다. |
| 반복 비정상 종료 | `docker compose ps`와 최근 로그를 보존하고 설정·권한·DB 오류를 먼저 해결한다. restart loop를 숨기기 위해 정책을 바꾸지 않는다. |

실제 장비 탐지, Ping 보조 판정, 재부팅 복구와 30초 이내 종료는 Ubuntu 동일 L2 환경에서 최종 인수한다.
