# 05. 배포, 테스트 및 운영 가이드

본 문서는 **PeerFlow v2**를 로컬에서 테스트하고 개인 또는 팀 Cloudflare 계정(`*.workers.dev`)에 배포·운영하는 방법과 실제 테스트 과정에서 해결한 주요 기술적 이슈를 정리합니다.

---

## 1. 로컬 개발 및 테스트 실행

Node.js **v22 이상**(내장 `node:sqlite` 및 `--experimental-strip-types` 지원) 환경을 권장합니다.

```bash
# 1. 의존성 설치
npm install

# 2. TypeScript 타입 검사
npm run typecheck

# 3. 전체 파이프라인 E2E 테스트 실행 (인메모리 D1 + R2 + Queues 하네스)
npm test

# 4. 로컬 D1 마이그레이션 및 로컬 개발 서버 실행
npm run db:migrate:local
npm run dev
```

---

## 2. Cloudflare 계정 배포 방법 (`*.workers.dev`)

커스텀 도메인 없이 Cloudflare의 기본 `*.workers.dev` 도메인으로 즉시 배포할 수 있도록 [`wrangler.jsonc`](../wrangler.jsonc)와 자동 배포 스크립트([`scripts/deploy.sh`](../scripts/deploy.sh))가 구성되어 있습니다.

### 2.1 환경 변수 설정 (`.env.cloudflare`)
프로젝트 루트의 [`.env.cloudflare.example`](../.env.cloudflare.example)을 참고하여 `.env.cloudflare` 파일에 본인의 Cloudflare 계정 정보를 입력합니다:

```env
CLOUDFLARE_ACCOUNT_ID="본인의_Cloudflare_Account_ID"
CLOUDFLARE_API_TOKEN="본인의_Cloudflare_API_Token"

# "true" 설정 시 실제 Slack API 호출 없이 발송 성공으로 시뮬레이션하며 Workers 로그에 PIN 출력
# 실제 Slack DM 발송 시 "false"로 변경하고 SLACK_BOT_TOKEN 입력
MOCK_SLACK_MODE="true"
SLACK_BOT_TOKEN="xoxb-YOUR-SLACK-BOT-TOKEN-HERE"
SITE_URL=""
```

### 2.2 배포 명령어
```bash
# 일반 배포 (기존 D1 데이터 유지)
./scripts/deploy.sh

# 원격 D1 데이터베이스 전체 초기화 후 재배포 (테스트 데이터 초기화 필요 시)
./scripts/deploy.sh --reset-db
```

`./scripts/deploy.sh`는 다음 작업을 순서대로 자동 수행합니다:
1. Cloudflare 인증 확인 (`wrangler whoami`)
2. D1 데이터베이스(`peerflow-db`) 존재 여부 확인 및 없을 시 자동 생성 후 `wrangler.jsonc`에 `database_id` 주입
3. 원격 D1 스키마 마이그레이션(`migrations/0001_initial.sql`) 적용 (`--reset-db` 옵션 시 기존 테이블 초기화 후 재적용)
4. R2 버킷(`peerflow-files`) 및 Queues(`peerflow-report-queue`, `peerflow-delivery-queue`) 준비
5. Cloudflare Workers + Static Assets(`web/`) 번들 업로드 및 배포

---

## 3. `MOCK_SLACK_MODE`에서 로그인 PIN 코드 확인 방법

`MOCK_SLACK_MODE="true"` 상태에서는 실제 Slack 메시지를 보내지 않고 Cloudflare Workers 로그(Observability / `npx wrangler tail`)에 발급된 6자리 PIN 코드와 DM 본문을 출력합니다.

* **실시간 로그 스트리밍 명령어**:
  ```bash
  npx wrangler tail
  ```
* **출력 로그 예시**:
  ```text
  [MOCK_SLACK_MODE][PIN_CODE] cycle_id=1 | reviewer="김철수" <chulsoo@example.com> | login_pin_code=560558
  [MOCK_SLACK_MODE][SLACK_DM] to=<chulsoo@example.com> (slack_user_id=U10001) | message=[2026 상반기 피어리뷰] 피어리뷰를 시작해 주세요. | 6자리 PIN: 560558 | 참여 링크: https://peerflow.<서브도메인>.workers.dev/login
  ```

---

## 4. 주요 트러블슈팅 및 아키텍처 개선 기록

실제 Cloudflare 배포 및 테스트 과정에서 발견하고 해결한 핵심 기술 이슈들입니다.

### 4.1 `@cloudflare/puppeteer` 번들링 누락 (`Error: No such module "@cloudflare/puppeteer"`)
* **원인**: 동적 변수 임포트(`const mod = "@cloudflare/puppeteer"; await import(mod)`)를 사용하면 Wrangler 내부의 esbuild가 정적 분석 시점에 모듈을 인식하지 못해 Worker 업로드 번들에서 `@cloudflare/puppeteer`를 제외합니다.
* **해결**: `import puppeteer from "@cloudflare/puppeteer";` 정적 임포트로 변경하여 esbuild가 번들에 포함하도록 수정했습니다.

### 4.2 다수 피평가자 동시 PDF 생성 시 Browser Rendering 속도 제한(`429`) 및 15초 자동 재시도
* **원인**: 회차 마감 시 피평가자마다 개별적으로 `puppeteer.launch(env.BROWSER)`를 동시에 호출하면 Cloudflare Browser Rendering의 브라우저 인스턴스 생성 속도 제한(분당 2회 제한 등)에 걸려 일부 리포트의 PDF 생성이 실패했습니다.
* **해결**:
  1. `peerflow-report-queue` 컨슈머 설정을 `max_batch_size: 10`, `max_concurrency: 1`로 조정하고, **배치 처리 시 단 1개의 HeadlessChrome 브라우저(`sharedBrowser`)만 실행하여 배치 내 모든 피평가자의 PDF를 탭(`browser.newPage()`)만 바꿔가며 순차 렌더링**하도록 개선했습니다.
  2. 일시적 오류로 리포트 생성이 실패(`FAILED`)할 경우 더미 PDF로 대체하지 않고, Queue 레벨(`msg.retry({ delaySeconds: 15 })`)과 API 폴링 레벨(`GET /api/admin/cycles/{cycleId}/reports`) 양쪽에서 **15초 주기로 자동 재시도**하여 모든 리포트가 정상적인 다중 페이지 한글 PDF(`READY`)로 완성되도록 보장했습니다.

### 4.3 새 탭에서 리포트 HTML/PDF 미리보기 클릭 시 `/login`으로 이동하던 현상
* **원인**: `wrangler.jsonc`의 Static Assets 설정에 `"not_found_handling": "single-page-application"`만 설정되어 있으면, 새 탭(`target="_blank"`)으로 `/api/admin/reports/{id}/html` 요청 시 브라우저가 보내는 `Accept: text/html` 내비게이션 요청을 Cloudflare Assets 계층이 가로채어 Worker 대신 `/index.html`(SPA)을 반환했습니다.
* **해결**: `wrangler.jsonc`의 `assets` 설정에 `"run_worker_first": true`를 추가하여 모든 `/api/*` 경로는 새 탭 내비게이션에서도 항상 Worker가 직접 응답하도록 수정했습니다.

### 4.4 미제출 리마인더 반복 발송 지원
* **원인**: 리마인더 중복 방지 키(`dedupe_key`)를 날짜(`YYYY-MM-DD`) 기준으로 고정하면 하루에 1회만 리마인더를 보낼 수 있었습니다.
* **해결**: 현재 큐에 아직 처리되지 않은 대기 중(`status = 'PENDING'`) 리마인더가 있는 경우에만 중복 등록을 건너뛰고, 이전 리마인더가 발송 완료(`SENT`)된 이후에는 관리자가 원할 때마다 새 고유 키로 리마인더를 반복 발송할 수 있도록 개선했습니다.
