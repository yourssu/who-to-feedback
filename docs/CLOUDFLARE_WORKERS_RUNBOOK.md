# PeerFlow Workers 실행·배포·복구

## 구현 구성과 설계 변경

HTTP는 Hono Worker, 관계 데이터·세션·작업 상태는 **SQLite 기반 Durable Object**(`Peerflow`, 객체 이름 `peerflow-v1`), 파일은 비공개 R2, 공개 CSS·JS·폰트는 Static Assets, 비동기 실행은 두 Queues, PDF는 Browser Run이다. D1은 사용하지 않는다.

기존 업무의 동기 조회·분기·중첩 트랜잭션을 D1 `batch()`로 그대로 옮길 수 없어 이전 계획서 §3의 대안을 채택했다. Durable Object `transactionSync()`로 제출·회차 시작·PIN 및 outbox 등록·CSV 전체 롤백을 보존한다. 이는 별도 DB 서버나 컨테이너가 필요한 구성이 아니다. 배포 환경별로 하나의 객체에 업무 데이터를 모으므로 수평 분산 DB가 아니며, 큰 부서의 전체 상호 매칭은 여전히 O(n²)이다. 실제 최대 부서 규모는 스테이징에서 부하 검증해야 한다. [공식 SQLite API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [공식 제한](https://developers.cloudflare.com/durable-objects/platform/limits/)

기존 Bun/Docker 진입점과 개발 DB는 회귀 비교용으로 유지했다. Workers의 실행 진입점은 `src/workers/index.ts`이며 `src/index.ts`, `bun:sqlite`, 로컬 Chromium 하위 프로세스를 실행하지 않는다. `bun run manage`, `seed`, 기존 SQLite 파일 백업은 **Workers 원격 DB에 적용되지 않는다**. 운영 업무는 기존 관리자 화면으로 수행한다.

## 로컬 실행

Node.js 22 이상과 Bun 1.3.12 이상을 사용한다.

```sh
bun install --frozen-lockfile
bun run dev:workers
```

`wrangler dev --env staging`의 로컬 SQLite/R2/Queues/Browser 바인딩을 사용한다. 상태는 `.wrangler/`에 저장된다. 첫 PDF 실행 시 Wrangler가 로컬 Chromium을 다운로드할 수 있다. `.env`의 Docker용 시크릿은 자동으로 읽지 않도록 실행 래퍼가 차단한다. `.dev.vars.staging`이 필요한 경우에만 만들고 커밋하지 않는다. 기본 발송은 Mock이다.

macOS 파일 감시 한도로 `EMFILE`이 발생하면 `CHOKIDAR_USEPOLLING=1 bun run dev:workers`로 실행한다. 로컬 Cron은 자동 실행되지 않으며 Wrangler가 출력하는 `/cdn-cgi/local/scheduled` URL로 수동 호출한다.

접속 URL에서 `/setup/`으로 관리자를 만들고 `/admin`을 사용한다. Workers 쿠키는 항상 Secure이며 실제 배포는 HTTPS를 사용한다. 최신 Chromium은 localhost의 Secure 쿠키를 지원한다. 브라우저 환경에서 HTTP localhost 쿠키가 차단되면 로컬 HTTPS 옵션을 사용한다.

`SITE_URL`을 지정하면 CSRF origin과 PIN/리마인더 링크의 기준으로 사용한다. 미지정 로컬·스테이징은 요청 origin을 사용한다. 운영에서는 반드시 실제 canonical HTTPS origin으로 설정한다. 프록시 IP는 Cloudflare ingress의 `CF-Connecting-IP`를 사용하고 `X-Real-IP`는 신뢰하지 않는다.

## 배포하지 않는 검증

```sh
bun run build:workers
bun run typecheck
bun run test
bun run scripts/capture-http-contract.ts --check
bun run check:workers
bun run test:workers
```

`check:workers`는 **dry-run만** 수행한다. 원격 리소스 생성·코드 배포·실제 Slack 발송은 하지 않는다. `test:workers`는 임시 workerd 상태와 localhost 서버에서 실행하고 종료 시 폐기한다. 이 테스트는 Poppler의 `pdfinfo`, `pdftotext`가 필요하다.

- 기존 method/path 58개 계약 fixture
- 기존 업무·인증·보고서 회귀와 새 양식/PBKDF2/Slack 어댑터 테스트
- 실제 workerd/SQLite: 초기 설정, 권한, 중첩 롤백, CSV 10,000행 및 오류 전체 롤백, PIN 로그인, 리뷰 제출
- 로컬 Queues, R2 HTML/PDF, Browser Run 바인딩의 실제 로컬 Chromium PDF, Mock 발송과 회차 종료
- 중복 작업, 임대 만료 UNKNOWN, 손상된 payload 실패 처리
- 기존 UI 검증은 별도 `bun run test:ui`, 기존 실제 PDF 비교는 `bun run test:pdf`

Cloudflare 원격 계정·할당량·실제 Browser Run·실제 Slack은 로컬 성공과 별개다. CI는 테스트와 dry-run만 실행하며 자동 배포하지 않는다.

## 승인 후 최초 스테이징 배포 절차

아래는 최초 스테이징 배포 명령이다. 2026-10-24 개인 계정 배포는 사용자 승인 후 실행했다. Wrangler 인증과 대상 Cloudflare 계정을 먼저 확인한다. 환경 이름을 생략하지 않는다.

```sh
bunx wrangler whoami
bunx wrangler r2 bucket create peerflow-staging-files
bunx wrangler queues create peerflow-staging-generate
bunx wrangler queues create peerflow-staging-delivery
bunx wrangler queues create peerflow-staging-dlq
bun run build:workers
node scripts/workers/wrangler.mjs deploy --env staging
```

`wrangler.jsonc`의 migrations가 `Peerflow` SQLite 객체 클래스를 생성한다. 최초 객체 실행 시 앱 SQL migration이 적용된다. 기존 EC2 DB는 가져오거나 삭제하지 않는다. R2 버킷을 공개하거나 r2.dev 접근을 활성화하지 않는다. Browser Run·Queues·Durable Objects 사용 권한과 요금제를 확인한다. production CPU 설정은 최대 300,000ms이며 이를 지원하는 요금제가 필요하다. staging은 무료 요금제와 호환되도록 CPU 설정을 생략하고 플랫폼 기본 한도를 사용한다.

배포 URL에서 최초 관리자 생성 → 작은 CSV·모든 문항 유형·이미지 업로드 → PIN 로그인·draft·제출 → 마감 → HTML/PDF → 승인·Mock 발송까지 확인한다. 스테이징은 운영과 DB·R2·큐 이름이 완전히 분리된다.

실제 Slack 검증은 수신 대상과 전송 범위를 별도로 승인받은 뒤 수행한다. 토큰은 다음 명령으로만 Secret에 저장하고 `MOCK_SLACK_MODE`를 명시적으로 `false`로 바꾼다.

```sh
node scripts/workers/wrangler.mjs secret put SLACK_BOT_TOKEN --env staging
```

토큰에는 기존 DM·이메일 조회·파일 업로드 권한이 필요하다. HTML과 PDF 두 파일을 `files.getUploadURLExternal` → 업로드 → `files.completeUploadExternal`로 전달한다. 일부 업로드 이후 오류는 `UNKNOWN`으로 처리한다. [Slack 업로드 URL API](https://docs.slack.dev/reference/methods/files.getUploadURLExternal/), [완료 API](https://docs.slack.dev/reference/methods/files.completeUploadExternal/)

운영도 같은 절차로 `production` 환경과 `peerflow-production-*` 리소스를 사용한다. `SITE_URL`과 Slack 모드를 검토하고, **Mock 상태에서 실제 피드백을 승인·발송 완료 처리하지 않는다**. 기존 EC2 발송기를 중지하고 도메인을 전환하는 일은 별도 운영 승인 대상이다.

## 데이터·파일·작업 보장

- DB의 `reports.html`에는 `r2:reports/<SHA256>-<UUID>.html` 문자열, `reports.pdf`에는 같은 형태의 PDF 참조 UTF-8 바이트를 저장한다. 큰 본문은 DB에 저장하지 않는다. 참조는 Workers 저장소에서만 사용하는 내부 표현이다.
- 파일 키는 매 업로드마다 새로 만든다. R2 업로드 성공 후 DB 포인터를 반영한다. 동일 HTML 해시는 기존 승인·PDF·발송 상태를 보존한다. 실패한 새 업로드는 고아 파일로 남는다.
- 렌더링 입력 변경을 SQL trigger epoch로 추적한다. R2 대기 중 입력이 변경되거나 작업 실행권이 만료되면 이전 결과를 커밋하지 않는다.
- HTML 최대 32MiB, PDF 최대 64MiB. 다운로드 및 Slack 파일 업로드는 R2 stream을 사용한다. 업로드 이미지 2MiB, CSV 2MiB/10,000행, 사용자 양식 1MiB, draft 100KiB 제한을 유지한다.
- 기본 템플릿 18개는 빌드 시 컴파일한다. 사용자 양식은 변수·if/not/else·for를 해석하며 함수·prototype 접근을 차단하고 깊이 32, 실행 단계 100,000, 출력 32MiB 제한을 둔다.
- 새 관리자 비밀번호는 PBKDF2-SHA256 600,000회, 16바이트 무작위 salt로 저장한다. 기존 Argon2 계정을 이관하지 않는다.
- 업무 변경과 outbox job 등록은 같은 DB 트랜잭션이다. 전송 실패·프로세스 종료로 Queue 전달이 빠지면 5분 Cron이 재전달한다. 큐 메시지는 job ID만 담는다.
- 조건부 claim, 10분 임대와 UUID 실행 토큰으로 중복 실행과 오래된 완료를 차단한다. 전체 생성 작업은 수신자별 작업으로 분할한다. 생성/PDF는 제한된 재시도, 명시적 Slack 429는 최대 5회, 불확실한 외부 전송은 UNKNOWN으로 남긴다.
- 외부 전송 성공 로그·보고서 SENT·job DONE은 하나의 DB 트랜잭션이다. 외부 성공 직후 실행 중단은 자동 재발송하지 않는다. 관리자 화면에서 실제 수신 여부를 확인해야 한다.
- 각 큐는 batch 1, concurrency 1이다. 큐별 최대 재전달 초과는 공용 환경별 DLQ로 이동한다. DB job 상태가 기준이며 DLQ를 무조건 재발송하지 않는다.

## 관측·복구

Wrangler tail/Cloudflare 로그에서 `job failed`, `outbox dispatch failed`, `queue processing failed`를 확인한다. 관리자의 메시지 화면에서 FAILED/UNKNOWN을 확인하고, 큐 backlog·DLQ 건수·실행 시간·R2 오류·메모리 한도를 관찰한다. `UNKNOWN`은 Slack 수신 확인 없이 재시도하면 중복 발송할 수 있다.

Cron은 만료 세션/인증 실패를 정리하고 임대 만료를 복구한다. 생성/PDF의 RUNNING은 PENDING, 발송 RUNNING은 UNKNOWN으로 전환한다. R2는 35일보다 오래되고 현재 참조되지 않는 파일만 최대 100개씩 순회 정리한다. 객체 이름 `peerflow-v1`과 Durable Object 클래스 이름을 바꾸면 기존 데이터 대신 새 DB가 열릴 수 있으므로 임의 변경하지 않는다.

SQLite Durable Object는 Cloudflare의 Point-in-Time Recovery를 사용한다. 복구 전 트래픽과 큐 소비를 멈추고 복구 대상 bookmark/시각과 현재 버전을 기록한다. DB 복구 후 참조된 R2 파일 존재 여부를 확인하고, 복원된 PENDING/UNKNOWN 발송 작업을 실제 Slack 수신 이력과 대조한다. R2의 비참조 파일 보존 기간 35일은 DB PITR용 여유이며, 영구 백업을 대체하지 않는다. 별도 장기 보존은 R2 외부 백업과 운영 정책으로 관리한다. [공식 SQLite/PITR API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

이번 변경은 클라이언트용 DB 관리·복구 엔드포인트를 공개하지 않는다. 관리자 CLI가 필요한 경우 인증·감사 범위를 정한 별도 운영 도구로 추가한다. 기존 `scripts/backup.ts`를 원격 백업 도구로 오인하지 않는다.

## 스테이징에서 남은 검증

1. 실제 계정의 Browser Run 세션·CPU·메모리·Queue 한도와 요금 확인.
2. 실제 원격 바인딩에서 한국어·SVG·이미지·긴 답변·사용자 양식 PDF 비교.
3. 승인된 Slack 테스트 수신자에게 두 파일 전송 및 429/부분 성공 운영 절차 확인.
4. 최대 예상 부서의 전체 매칭, 다수 수신자 보고서 생성과 최대 크기 입력에서 자원 측정.
5. 배포 교체 중 작업 임대 복구, DLQ 및 PITR 복구 연습.

로컬 테스트 시간은 wall time이며 Cloudflare CPU 과금·운영 부하 보장으로 해석하지 않는다. 위 공식 링크는 2026-10-23 접근을 확인했다.


## 2026-10-23 로컬 검증 기록

- 타입 검사, 서식 검사, `git diff --check`, 58개 HTTP 계약: 통과.
- Bun 업무·회귀·어댑터 테스트: 80개, 318 assertions 통과.
- workerd: 동시 최초 관리자 생성 경합·SQLite 중첩 롤백·CSV 10,000행·PIN/제출·2MiB R2 이미지·기본/사용자 양식 실제 PDF·Mock 발송·중복 메시지·임대 만료 UNKNOWN·잘못된 payload 실패 처리 통과.
- 최대 행 CSV wall time 약 161ms, PBKDF2 setup 약 56ms인 단일 로컬 실행을 관찰했다. 플랫폼 CPU 보장은 아니다.
- Workers 대시보드: 390/1440px × light/dark의 실제 localhost 브라우저 캡처. 대표 모바일 다크 화면을 시각 확인했다.
- 기존 UI 회귀: 33개 화면 × 4개 변형(132개), 리뷰 상태 및 실제 제출 흐름 통과. Figma 검수는 수행하지 않았다.
- 기존 PDF: 기본 3개 각 7페이지와 긴 피드백 11페이지의 한국어 원문 보존 통과. Worker 기본 PDF는 5페이지/960×540pt, 사용자 양식 PDF도 한글 추출 및 스크립트 미실행 확인. 사용자 양식의 첫 페이지를 렌더링해 시각 확인했다.
- 로컬 Browser Run의 Chrome 126 PDF에는 Poppler의 폰트 형식 경고가 출력됐다. 한글 추출과 확인한 페이지 렌더링은 정상이며, 원격 Browser Run의 PDF 비교는 스테이징 검증에 포함한다.
- Wrangler staging/production dry-run: 압축 번들 약 465KiB, 18개 사전 컴파일 템플릿, 13개 static assets. 실제 Wrangler 설정으로 `/health/` 200 응답도 확인했다. 최종 번들에서 `Bun.*`, `bun:sqlite`, `node:fs` 의존성이 없는지도 검사한다.
- CI 정의는 추가했으나 원격 CI 실행 결과는 아직 없다. 원격 리소스 생성·배포·실제 Slack 발송은 수행하지 않았다.


## 2026-10-24 개인 계정 원격 검증

- workers.dev: https://peerflow-staging.twitchproxy0744.workers.dev
- 배포 버전: `88be3bb5-ff78-4acc-959a-e13ce29731e9`. 개인 도메인과 운영 환경은 배포하지 않았다.
- R2 `peerflow-staging-files`, 생성·발송·DLQ 3개 큐를 생성했다. Slack은 Mock이며 실제 발송은 하지 않았다.
- 관리자 setup/로그인, 인증 보호, CSV 등록, 회차·문항·매칭, 시작·마감, Queue 처리, R2 HTML/PDF 다운로드, 실제 Browser Run 한글 PDF, Mock 결과 발송을 확인했다.
- 성공 증거: 로컬 ignored `artifacts/remote-1792826006091/result.json` 및 PDF/HTML. 관리자 자격 증명은 `artifacts/remote-1792825909112/credentials.json`에 권한 0600으로 저장했다. 이 파일들은 커밋하지 않는다.
- 실제 PDF 4페이지·960×540pt·289,555바이트. 한글 추출 및 표지 시각 확인 통과. Poppler Type 3 글리프 경고는 남아 있다.
- 원격 PIN 제출·실제 Slack·최대 부하·PITR 복구는 미검증이다. 테스트 데이터 2개 회차는 검토용으로 남긴다.
- Hosted Workers의 PBKDF2 100,000회 제한은 로컬에서 재현되지 않았다. `@noble/hashes`로 600,000회와 기존 저장 형식을 유지했고 Node 기준값과 일치함을 테스트했다.

재검증은 Mock 모드를 확인한 후 아래처럼 명시적으로 실행한다. 기존 DB에는 관리자 자격 증명 파일 경로를 지정하고, 새 DB에서는 생략한다. 테스트는 회차와 샘플 팀원을 생성하며 운영 데이터에 실행하지 않는다.

```sh
PEERFLOW_STAGING_URL=https://peerflow-staging.twitchproxy0744.workers.dev \
PEERFLOW_STAGING_MOCK_CONFIRMED=true \
PEERFLOW_STAGING_CREDENTIALS=artifacts/remote-1792825909112/credentials.json \
node tests/workers/remote.mjs
```


## 직접 테스트하기: TEST_MODE

Cloudflare 대시보드 → Workers & Pages → peerflow-staging → Settings → Variables and Secrets에서 문자열 `TEST_MODE=true`를 설정하고 Deploy한다. `false`로 설정하거나 제거하면 테스트 PIN 표시는 꺼진다. 저장소의 staging 기본값은 true, production은 false이다. Wrangler 재배포는 저장소 설정을 적용하므로 영구 변경은 `wrangler.jsonc`도 함께 수정한다.

1. `/admin`에 접속해 관리자 계정으로 로그인한다. `/admin/`과 이전 `/admin-panel/...`는 새 관리자 경로로 308 이동한다.
2. 팀원 2명 이상, 문항, 리뷰 매칭을 만들고 회차를 시작한다.
3. 관리자 **진행 상태** 화면의 **테스트용 리뷰어 PIN**을 확인한다. PIN은 관리자 인증 후에만, 마감 전 ACTIVE 회차에서만 보인다.
4. 별도 브라우저/시크릿 창의 `/login/`에서 PIN으로 로그인하고 리뷰를 제출한다. 같은 창에서 로그인하면 세션이 리뷰어로 교체되므로 관리자 창과 분리한다.
5. 관리자에서 마감 → 결과 HTML/PDF 확인 → 승인·Mock 발송을 시험한다.

`TEST_MODE=true`이면 `MOCK_SLACK_MODE=false`여도 실제 Slack 호출은 하지 않는다. 테스트 모드는 인증을 우회하거나 기존 데이터를 초기화하지 않으며 제출·승인·발송 완료 상태는 DB에 실제로 저장된다. 테스트 데이터 전용 staging에서 사용한다. 테스트 모드를 끈 뒤에도 `MOCK_SLACK_MODE=true`라면 발송은 여전히 Mock이다.
