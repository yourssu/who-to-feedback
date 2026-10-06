# PeerFlow 개발·배포·운영 가이드

기존 `DEPLOYMENT.md`와 `DEVELOPMENT_SERVER_GUIDE.md`를 통합했습니다. `main`은 Bun + TypeScript 시스템, `legacy-django`는 전환 직전 원격 Django 코드입니다. Django DB 이관 없이 신규 SQLite DB로 시작합니다.

## 1. 실행 구조와 저장소

운영 요청 경로는 브라우저 → Cloudflare(사용 시) → 호스트 Nginx HTTPS → `127.0.0.1:8000` → Bun/Hono입니다. 앱이 Nunjucks 웹 화면·정적 파일·인증된 이미지와 보고서를 제공합니다. PDF는 별도 TS 프로세스의 Playwright Chromium으로 생성합니다. Python·Gunicorn·WhiteNoise는 사용하지 않습니다.

SQLite 작업 큐를 포함하므로 **앱 인스턴스는 하나만** 실행합니다. 운영 앱과 개발 앱이 같은 DB를 동시에 처리하지 않도록 경로를 분리합니다.

| 호스트 기본 경로 | 컨테이너 경로 | 용도 |
|---|---|---|
| `data/peerflow.sqlite3` | `/app/data/peerflow.sqlite3` | 계정·회차·답변·세션·보고서·작업 큐 |
| `media/` | `/app/media/` | 업로드 질문 이미지 |
| `.env` | Compose 환경 변수로 전달 | origin·Slack·DB 설정 |

기존 Django `data/db.sqlite3`와 media는 별도로 보관합니다. 신규 앱의 `PEERFLOW_DB`를 Django DB로 지정하지 않습니다. DB·media·`.env`는 Git에 포함하지 않습니다.

## 2. 공통 환경 설정

최초 설정 때만 프로젝트 루트에서 `.env.example`을 복사합니다. 기존 `.env`를 덮어쓰지 않습니다.

```sh
cp .env.example .env
```

| 변수 | 개발 | 운영 |
|---|---|---|
| `NODE_ENV` | `development` | `production` — Compose가 적용 |
| `HOST` | `127.0.0.1` | 컨테이너 내부 `0.0.0.0` — Compose가 적용 |
| `PORT` | `8000` | `8000` — 현재 Compose 포트와 일치 |
| `SITE_URL` | `http://127.0.0.1:8000` | 실제 HTTPS origin |
| `PEERFLOW_DB` | `data/peerflow.sqlite3` | 기본 상대 경로 유지 시 Compose 볼륨에 저장 |
| `PEERFLOW_MEDIA` | `media` | 기본 상대 경로 유지 시 Compose 볼륨에 저장 |
| `MOCK_SLACK_MODE` | `true` | 실제 전송을 시작할 때 `false` |
| `SLACK_BOT_TOKEN` | mock에서는 비워도 됨 | 실제 Slack 모드에서 봇 토큰 필요 |
| `TRUST_PROXY` | `false` | 신뢰하는 Nginx가 `X-Real-IP`를 덮어쓰는 경우 `true` |
| `PDF_CHROMIUM_EXECUTABLE` | 선택적 Chromium 절대 경로 | Docker에는 Chromium 포함, 보통 생략 |

`SITE_URL`은 Slack 링크와 CSRF origin 검사에 사용하므로 실제 접속 스킴·호스트·포트와 맞춥니다. 운영에서는 Secure 세션 쿠키를 사용하므로 관리자 설정·로그인은 HTTPS로 접속합니다.

`MOCK_SLACK_MODE=true`는 실제 전송 없이 발송 성공을 대체합니다. 이 결과는 실제 수신 확인이 아닙니다. 일반 발송 로그에는 PIN·원문을 출력하지 않으며 개발 seed 명령에서만 예시 PIN을 출력합니다. 권한·앱 설정은 [Slack 연동 가이드](SLACK_INTEGRATION_GUIDE.md)를 따릅니다.

## 3. 로컬 개발

Bun 1.3.12를 기준으로 합니다. 새 개발 체크아웃에서 환경 설정 후 실행합니다.

```sh
bun install --frozen-lockfile
bunx playwright install chromium
bun run dev
```

Linux에서 Chromium 시스템 라이브러리까지 필요하면 `bunx playwright install --with-deps chromium`을 사용합니다.

| 화면 | 로컬 URL |
|---|---|
| 최초 관리자 생성 | `http://127.0.0.1:8000/setup/` |
| 관리자 로그인 | `http://127.0.0.1:8000/admin/login/` |
| 관리자 센터 | `http://127.0.0.1:8000/admin-panel/` |
| 리뷰어 PIN 로그인 | `http://127.0.0.1:8000/login/` |

최초 관리자를 생성하면 `/setup/`은 닫힙니다. 예시 데이터가 필요하면 앱을 정지한 뒤 빈 개발 DB에서 `bun run seed`를 실행하고 다시 시작합니다. 운영 환경 또는 실제 Slack 모드에서는 seed를 실행할 수 없습니다. 출력 PIN은 개발 예시에만 사용합니다.

## 4. Docker 운영 배포

서버에 Docker Engine·Compose와 호스트 Nginx가 필요합니다. 이미지에 Bun·운영 JS 패키지·Chromium·시스템 라이브러리가 포함되므로 호스트에 Bun을 별도 설치하지 않아도 됩니다.

새 체크아웃을 준비합니다.

```sh
git clone --branch main https://github.com/yourssu/who-to-feedback.git
cd who-to-feedback
cp .env.example .env
```

`.env`에 운영 origin·Slack·프록시 설정을 작성합니다. DB/media 경로를 바꾸면 Compose 볼륨도 맞춥니다. 기존 Django를 전환할 경우 먼저 기존 서비스를 정지하고 DB·media·환경 설정을 보관합니다. 기존 컨테이너와 새 컨테이너가 같은 이름·포트를 차지하지 않게 합니다.

```sh
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=100 web
curl --fail http://127.0.0.1:8000/health/
```

호스트 `127.0.0.1:8000`만 열리며 Nginx가 외부 HTTPS를 처리합니다. DB 스키마는 앱 시작 시 준비됩니다. Django migration·createsuperuser 명령은 없습니다. HTTPS `/setup/`에서 관리자를 생성합니다.

## 5. Nginx·Cloudflare 연결

기존 Nginx HTTPS 서버 블록의 인증서·도메인은 실제 운영 값으로 설정하고 아래 규칙으로 연결합니다. 앱 요청 크기 제한은 3MiB이며 Nginx `client_max_body_size`는 `4m` 이상으로 설정할 수 있습니다.

| 항목 | 설정 원칙 |
|---|---|
| upstream | `proxy_pass http://127.0.0.1:8000` |
| 호스트 | `proxy_set_header Host $host` |
| 사용자 IP | `proxy_set_header X-Real-IP $remote_addr` — 외부 헤더를 그대로 전달하지 않음 |
| 스킴 | `proxy_set_header X-Forwarded-Proto $scheme` |
| `/static/` | 앱으로 프록시, 공개 캐시 허용 |
| `/media/` | 기존 직접 `alias` 제거, 인증 검사를 위해 앱으로 프록시 |
| 로그인·리뷰·관리자·결과지 | 앱으로 프록시, 공유 캐시 우회 |

헤더 설정은 [Nginx 공식 proxy 문서](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header)를 기준으로 합니다. 서버에서 설정을 검증한 후 반영합니다.

```sh
sudo nginx -t
sudo systemctl reload nginx
```

Cloudflare 사용 시 원본 서버 443에 유효한 인증서를 설치하고 **Full (strict)**를 사용합니다. 원본 인증서 조건은 [Cloudflare 공식 문서](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)를 확인합니다. Origin CA 인증서는 Cloudflare 연결용이므로 브라우저 직접 origin 접속용으로 간주하지 않습니다.

사용자 IP는 [Cloudflare IP 복원 문서](https://developers.cloudflare.com/support/troubleshooting/restoring-visitor-ips/restoring-original-visitor-ips/)에 따라 Nginx real-IP 모듈로 복원합니다. `CF-Connecting-IP`는 Cloudflare의 현재 신뢰 IP 대역에서 온 연결에만 적용하고 앱에는 복원된 `$remote_addr`를 전달합니다. 오래된 IP 대역을 고정하지 않습니다. 복원이 없으면 요청 제한은 프록시 IP를 기준으로 작동할 수 있습니다. Cloudflare 캐시 규칙에서도 인증 화면·media·결과지를 우회합니다.

## 6. 배포 후 확인과 운영 명령

`/health/`는 HTTP·DB 응답만 확인합니다. 테스트 회차에서 관리자 로그인 → 팀원·문항·매칭 → PIN 로그인 → 임시 저장·제출 → 마감 → HTML/PDF 미리보기·다운로드 → 검토 승인 → 전달을 확인합니다. 실제 Slack 모드에서는 DM 수신과 HTML/PDF 두 파일의 접근 권한까지 확인합니다.

로컬은 `bun run manage <명령> <회차 ID>`, Docker는 다음 형식입니다. 아래 `1`은 실제 대상 ID로 바꿉니다.

```sh
docker compose exec web bun run scripts/manage.ts generate_reports 1
```

지원 명령은 `start_review_cycle`, `close_review_cycle`, `send_reminders`, `generate_reports`, `publish_reports`입니다. 생성·발송은 큐에 등록되므로 앱 실행기가 동작해야 합니다. CLI `publish_reports`는 이미 승인한 결과지만 처리하며 승인을 대체하지 않습니다. 회차 시작·마감은 관리자 동작이며 예약 시간에 자동 전환하지 않습니다.

명시적 전송 실패는 `FAILED`, 수신 여부가 불명확하거나 전송 중 강제 종료되면 `UNKNOWN`입니다. 메시지 화면에서 `FAILED`만 일괄 재시도합니다. `UNKNOWN`은 Slack 수신 확인 후 ‘수신 확인 완료’ 또는 ‘미수신 확인 및 재전송’으로 처리합니다. 생성·PDF 작업은 재시작 시 복구합니다.

## 7. 백업·복구·업데이트

DB와 media를 같은 시점에 보존하도록 앱을 정지한 뒤 백업합니다. 스크립트는 SQLite `VACUUM INTO`와 media 복사를 사용하며 대상 디렉터리는 새 경로여야 합니다. 백업에는 PIN·답변·세션이 포함되므로 접근을 제한합니다.

Docker 서버에서도 이미지의 스크립트를 실행할 수 있습니다. 디렉터리와 백업 이름은 실제 경로·고유한 이름으로 바꿉니다.

```sh
sudo mkdir -p /srv/peerflow-backups
sudo chmod 700 /srv/peerflow-backups
docker compose stop web
docker compose run --rm --no-deps --volume /srv/peerflow-backups:/backups web bun run scripts/backup.ts /backups/before-update-001
docker compose start web
```

호스트 Bun으로 백업할 때는 앱 정지 후 `bun run scripts/backup.ts /absolute/path/to/new-backup`을 실행합니다. `.env`의 DB/media 경로는 호스트에서 접근 가능한 경로여야 합니다.

복구는 앱 정지 후 백업 DB와 media를 각 설정 경로로 함께 복원합니다. 교체 대상 DB의 `-wal`, `-shm`은 이전 DB와 섞지 않게 따로 보관합니다. 원본 백업을 유지하고 복사본으로 복원합니다.

업데이트 전 현재 커밋과 DB/media 백업을 기록합니다. 로컬 변경이 없는지 확인한 뒤 진행합니다.

```sh
git status --short
git rev-parse HEAD
git pull --ff-only origin main
docker compose build
docker compose up -d
curl --fail http://127.0.0.1:8000/health/
```

스키마 변경 후 이전 코드로 돌아갈 때는 해당 코드와 맞는 DB/media 백업도 복원합니다. `legacy-django`를 실행할 경우 Bun DB가 아닌 기존 Django DB·media·환경 설정이 필요합니다. 별도 디렉터리에 `git clone --branch legacy-django https://github.com/yourssu/who-to-feedback.git`로 레거시 코드를 확인하고 실행 중인 운영 체크아웃에서 브랜치만 바꾸지 않습니다.

## 8. 개발·CI 검증과 문제 해결

```sh
bun run format:check
bun run typecheck
bun run test
bun run test:ui
bun run test:pdf
```

PDF 검증에는 Poppler가 필요합니다. macOS는 `brew install poppler`, Ubuntu는 `sudo apt-get install poppler-utils`로 설치합니다. Poppler는 검증 도구이며 운영 PDF 생성 의존성은 아닙니다. UI 캡처는 `artifacts/ui/`, 예시 PDF는 `output/pdf/`, 긴 피드백 PDF는 `artifacts/pdf/`에 저장됩니다.

기존 Chromium은 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`로 지정합니다. PDF는 `PDF_CHROMIUM_EXECUTABLE`을 우선 사용하고 UI용 경로를 대체 값으로 사용합니다. CI 정의는 `.github/workflows/verify.yml`입니다.

| 증상 | 확인 항목 |
|---|---|
| 컨테이너 접속 불가 | Compose 상태·로그, 내부 HOST, 호스트 포트, Nginx upstream |
| 운영 로그인 유지 안 됨 | HTTPS, SITE_URL, Secure 쿠키, 프록시·캐시 규칙 |
| CSRF 오류 | 실제 origin과 SITE_URL 일치 여부 |
| PDF 생성 실패 | Chromium 설치·실행 경로·라이브러리, 보고서 오류·HTML 크기·변환 시간 |
| Slack 실패 | mock 모드, 토큰·권한·이메일, 실패/확인 필요 이력 |
| media가 비로그인 노출 | 기존 Nginx alias·CDN 공개 캐시 제거 여부 |

### 로컬 Docker 검증

Docker 데몬과 호스트 Bun·Poppler가 준비되어 있으면 다음 명령으로 이미지를 검증합니다.

```sh
docker build -t peerflow:local-verification .
bun run scripts/verify-docker.ts
```

스크립트는 `.env`를 컨테이너에 전달하지 않으며 별도 테스트 볼륨·임의의 localhost 포트·mock Slack을 사용합니다. 운영 모드에서 초기 설정·관리자/PIN 로그인·리뷰 제출·실제 PDF·mock 발송·재시작·백업을 확인하고 임시 컨테이너와 볼륨을 제거합니다. Secure 쿠키는 HTTPS 프록시 뒤의 앱을 흉내 내기 위해 테스트 클라이언트가 직접 전달합니다. 따라서 Nginx·TLS·브라우저의 HTTPS 쿠키 처리를 검증한 결과는 아닙니다. 산출물은 `artifacts/docker/`에 저장됩니다.

로컬 통과는 원격 CI·실제 Slack 전달·운영 배포 완료의 증거가 아닙니다. 현재 검증 범위는 [리팩토링 결과](REFACTOR_RESULT.md), PDF 변경은 [커스텀 양식 가이드](CUSTOM_HTML_TEMPLATE_GUIDE.md)를 확인합니다.
