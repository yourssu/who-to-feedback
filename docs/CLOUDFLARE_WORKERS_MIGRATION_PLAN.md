# Cloudflare Workers 이전 계획서

작성일: 2026-10-23
검토 기준: Git `cd80fe7`, 현재 Bun + TypeScript 구현
상태: 아래는 최초 계획 원문이며, 구현 시 확정한 변경은 §10에 기록한다. 원격 리소스 생성·배포는 미수행.

## 1. 목표와 전제

EC2에서 실행 중인 Docker 웹 서버, 로컬 SQLite, 파일 저장소, 상주 작업 처리기와 Chromium 의존성을 Cloudflare 관리형 서비스로 이전한다. Hono, TypeScript, 기존 화면과 제품 동작은 최대한 유지한다.

“데이터베이스는 유지할 필요 없다”는 기존 SQLite 데이터·계정·세션·PIN·결과지의 이관이 불필요하다는 뜻으로 해석한다. 새 서비스의 영속 저장은 필요하므로 새 D1 데이터베이스로 시작한다. 기존 운영 DB를 삭제하는 작업은 포함하지 않는다.

기본 범위는 API만이 아니라 로그인, 관리자·리뷰어 화면, CSV, 이미지, 사용자 HTML 양식, 결과지 HTML/PDF 생성·다운로드, Slack 발송까지 포함한다. PDF나 사용자 양식을 후속 기능으로 미루지 않는다. 이번에는 이 계획서만 추가하며 애플리케이션 코드·설정·의존성을 수정하지 않는다.

## 2. 현재 코드에서 확인한 구조

| 영역 | 현재 구현과 근거 | 이전 영향 |
| --- | --- | --- |
| 서버 | `src/index.ts`: `Bun.serve`, 종료 시그널, 시간별 정리 | Worker 이벤트 진입점으로 교체 |
| HTTP | `src/app.ts`, `src/routes/*`, `src/templates.ts`: Hono, 명명된 경로, HTML·폼 중심 | Hono와 URL 계약 유지 가능 |
| DB | `src/db.ts`: `bun:sqlite`, 동기 Repository, `transaction().immediate()` | D1 비동기 호출 및 업무별 원자성 재설계 |
| 스키마 | `src/schema.ts`, `src/migrations.ts`: 관계·제약·인덱스, 결과지 revision/hash | 최신 의미를 반영한 신규 D1 SQL migration |
| 인증 | `src/routes/auth.ts`, `src/app.ts`: Argon2id, PIN, DB 세션, CSRF, 실패 잠금 | 비밀번호 구현 교체, 동시 요청 및 IP 처리 재검증 |
| 화면 | `src/templates.ts`, `core/templates`: 18개 템플릿 파일, 파일 로더 및 런타임 컴파일 | 빌드 시 사전 컴파일 |
| 업로드 | `src/routes/questions.ts`, `src/app.ts`: 로컬 이미지 저장과 인증 조회 | 비공개 R2와 기존 `/media/*` 경로 연결 |
| 보고서 | `src/reports.ts`, `src/reporting/*`: 폰트·이미지 내장, SVG 글자 경로, 페이지 분할 | 파일 읽기 제거, 생성물 R2 저장, 메모리·CPU 확인 |
| PDF | `src/pdf.ts`, `src/reporting/pdf-worker.ts`: Bun 하위 프로세스 + Playwright Chromium | Cloudflare Browser Run으로 교체 |
| 작업 | `src/jobs.ts`: 500ms polling, 프로세스 내부 busy 플래그 | Queues, DB 작업 상태와 임대 기반 처리 |
| 발송 | `src/jobs.ts`, `src/deliveries.ts`: Slack SDK, HTML/PDF 첨부, UNKNOWN 수동 확인 | 중복 전달과 종료 시점 불확실성 처리 보존 |
| 운영 | Dockerfile, Compose, `scripts/manage.ts`, `scripts/backup.ts`, CI | Wrangler 개발·배포, 원격 운영·복구 절차로 교체 |

현재 서비스는 독립된 JSON REST API 서버보다 HTML 페이지·POST 폼·리다이렉트 중심이다. 따라서 호환성은 URL뿐 아니라 브라우저 동작까지 포함해야 한다.

## 3. 권장 구성

| 구성 요소 | 역할 |
| --- | --- |
| Workers + Hono | SSR, 기존 HTTP 경로, 인증·권한·입력 검증 |
| Workers Static Assets | `/static/*` CSS·JS·공개 폰트 |
| D1 | 회원·회차·문항·배정·응답·세션·작업·감사 이력·결과지 메타데이터 |
| 비공개 R2 | 질문 이미지, 생성 HTML/PDF, 필요 시 보고서용 대형 폰트 |
| Queues | 결과지 생성·PDF·Slack 작업 실행; 생성과 발송 큐 분리 권장 |
| Cron Trigger | 누락된 작업 전달 복구, 임대 만료 점검, 세션·실패 기록 정리 |
| Browser Run | Cloudflare의 브라우저에서 HTML을 PDF로 변환 |

HTTP 요청은 업무 변경과 작업 등록을 D1에 함께 기록한다. 작업 ID를 Queue에 보내고, 소비자가 D1 상태를 확인해 처리한다. 파일은 R2에 저장하고 다운로드는 Worker 인증을 거친다. Browser Run은 현재 공식 문서의 명칭이며 이전 명칭은 Browser Rendering이다.

Bun은 개발용 패키지 관리·빌드 도구로 유지할 수 있다. 운영 코드에서는 `Bun.*`를 제거한다. `nodejs_compat`는 필요한 Node API에 한해 사용하며 Bun이나 Docker의 대체 실행 모드로 취급하지 않는다. [Node.js 호환성](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)

별도 React/SPA 전환, API 버전 신설, ORM 전면 도입은 필요하지 않다. Durable Objects는 기본 구성에 넣지 않되, D1에서 핵심 원자성 구현이 지나치게 복잡해지는 경우에만 대안으로 재검토한다.

## 4. HTTP·기능 호환성 기준

구현 첫 단계에서 `src/templates.ts`의 경로와 각 라우트 등록을 결합해 method/path별 계약표를 만든다. `/admin/`, `/admin/login/`, `/health/`, `/static/*`, `/media/*`처럼 별도 등록된 경로도 포함한다.

| 범위 | 유지할 계약 |
| --- | --- |
| 초기 설정·로그인 | `/setup/`, `/login/`, `/logout/`, `/admin/login/`, 성공·실패 시 화면과 리다이렉트 |
| 리뷰어 | `/`, `/review/:assignment_id/`, `/review/:assignment_id/save-draft/`, 입력 이름·JSON 구조·권한·마감 정책 |
| 관리자 | `/admin-panel/` 아래 회원·회차·문항·선택지·배정·검증·현황·메시지·보고서 경로와 method |
| 요청 형식 | URL encoded form, multipart, JSON, 다중 선택 필드, `X-CSRFToken`과 `csrfmiddlewaretoken` |
| 응답 | HTML/JSON content type, 상태 코드, Location, JSON 오류 구조, flash 메시지 |
| 파일 | `/media/*` 인증 정책, 결과지 preview/download 경로·파일명·CSP·Content-Disposition |
| 정적 파일 | 기존 경로, 정상 MIME, 캐시 재검증과 304 의미; ETag 문자열 자체는 같을 필요 없음 |
| 쿠키 | `peerflow_session`, `csrftoken`, Secure/HttpOnly/SameSite와 12시간 만료 의미 |

데이터 초기화로 기존 사용자 ID·로그인 세션·PIN·과거 파일 URL의 유효성은 이어지지 않는다. 기존 DB 및 암호 해시 형식 호환은 제외한다. 작업 완료까지의 정확한 지연 시간은 달라질 수 있지만 접수·진행·실패·재시도 동작은 유지한다.

현재 크기 제한도 인수 기준에 포함한다: 요청 본문 3MiB, 이미지 2MiB, CSV 2MiB/10,000행, HTML 양식 1MiB, draft 100KiB. 대형 CSV의 동기 응답·전체 롤백을 플랫폼 제한 안에서 보존할 수 있는지 선행 검증한다. 임의로 행 수를 줄이거나 비동기 접수 응답으로 바꾸지 않는다.

## 5. 핵심 리팩토링 설계

### 5.1 D1과 업무 원자성

Repository, 도메인 함수, view model 작성과 라우트의 DB 호출을 비동기로 전환한다. 현재 동기 DB를 Promise로 감싸는 어댑터만으로는 충분하지 않다. D1 `batch()`는 SQL 묶음을 원자적으로 실행할 수 있지만, 기존 JS 콜백 안의 조회·분기·쓰기와 동일한 인터페이스는 아니다. [D1 API](https://developers.cloudflare.com/d1/worker-api/d1-database/)

각 업무를 읽기 모델과 원자적 쓰기 명령으로 분리한다. 제약조건, 조건부 SQL, 변경 버전 확인, batch를 조합한다. 사전 조회만으로 권한·상태를 판단한 뒤 무조건 쓰지 않는다. 조건부 UPDATE가 0행을 변경해도 SQL 오류는 아니므로, 후속 쓰기까지 차단하거나 전체 실패시키는 방식을 명확히 설계한다.

필수 원자성 목록:

- 최초 관리자 1명 생성: 동시 setup에서도 한 요청만 성공.
- 리뷰 제출: 답변·다중 선택·제출 상태가 모두 반영되거나 모두 롤백.
- draft와 제출·마감 경합: 제출 완료 데이터나 마감 정책을 뒤집지 않음.
- 회차 시작·ACTIVE 배정 추가: PIN·작업 등록·상태·이력이 함께 반영.
- 문항·선택지 변경: 버전·이력·잠금 확인이 일관됨.
- CSV: 사전 전체 검증 후 반영, 중간 오류에 부분 회원 반영 없음.
- 승인·재생성·발송: revision/hash와 작업 등록이 일치함.

생성 ID를 다음 SQL에 전달하는 패턴도 교체한다. `lastInsertRowid`를 단순 이름 치환하는 데 그치지 않고, 같은 batch 내 관계 연결에는 고유키 기반 조회 등 검증 가능한 방식을 사용한다. 읽기 복제는 초기에는 켜지 않고, 로그인·상태 변경 직후의 일관성을 먼저 확보한다.

10,000행 CSV나 큰 부서의 자동 매칭을 요청당 SQL 루프로 옮기지 않는다. 집합 연산 또는 staging 데이터와 최종 원자적 반영 방식을 검증한다. D1의 쿼리당 바인딩 100개·SQL 크기·실행 제한을 고려한다. [D1 제한](https://developers.cloudflare.com/d1/platform/limits/)

### 5.2 파일과 보고서 저장

D1에는 생성물 키·크기·해시·revision·상태를 저장하고 HTML/PDF 본문은 R2에 저장한다. 현재 코드의 HTML 최대 32MiB, PDF 최대 64MiB는 D1의 문자열/BLOB/행 2,000,000바이트 제한에 맞지 않는다. [D1 제한](https://developers.cloudflare.com/d1/platform/limits/)

현재 폰트는 파일시스템 표시 기준 Pretendard TTF 약 15MB, WOFF2 약 3.8MB다. base64 내장으로 HTML이 더 커지므로 폰트 전체를 Worker JS 번들에 포함하지 않는다. assets 또는 R2에서 읽고, SVG 글자 경로 계산에 필요한 TTF 파싱 비용을 측정한다. 폰트 서브셋은 한글 누락·출력 차이 검증 후 선택한다.

R2 객체는 revision/hash를 포함한 변경 불가능한 키로 저장한다. 업로드 완료 후 D1 포인터를 조건부 갱신하며, 실패한 업로드·교체된 생성물은 정리 대상으로 남긴다. R2와 D1을 하나의 트랜잭션으로 간주하지 않는다. 조회·Slack 첨부는 승인된 revision의 객체를 사용한다. [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)

다운로드는 가능한 한 스트리밍한다. 보고서 생성 때 HTML 문자열·base64 폰트·이미지·PDF를 동시에 복제하면 기존 허용 크기에서도 Worker 메모리 한도에 닿을 수 있으므로 최대 입력 시험을 선행한다. [Workers 제한](https://developers.cloudflare.com/workers/platform/limits/)

### 5.3 템플릿과 화면

저장소의 정적 Nunjucks 템플릿은 빌드 때 사전 컴파일하고 runtime-only 렌더러에 등록한다. 기존 필터·URL helper·상속·include·autoescape를 유지한다. 설치된 Nunjucks의 `src/environment.js`에서 `new Function(source)` 사용을 확인했으므로 FileSystemLoader만 교체하는 것으로는 충분하지 않다.

관리자가 업로드하는 양식은 배포 후 들어오므로 빌드 사전 컴파일 대상이 아니다. 현재 허용된 변수 접근·단순 for·if/not/else를 해석하는 제한된 파서/인터프리터로 교체한다. 객체 prototype 접근 차단, HTML escaping, 문법 오류, 중첩·반복량·출력 크기 상한을 검증한다. 현재 허용 양식과 동일한 결과를 내는 fixture를 작성한다. 시작 시 eval 허용 플래그를 요청 중 업로드 컴파일의 해결책으로 사용하지 않는다. [호환성 플래그](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)

Static Assets 출력은 `/static/` 접두사를 유지한다. SSR 경로와 자산 라우팅이 충돌하지 않게 설정하고 HTML 정규화로 POST 또는 끝 슬래시 경로가 달라지지 않는지 확인한다. [HTML handling](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/)

화면 디자인은 현재 구현을 기준으로 보존한다. 이번 조사에서는 Figma를 조회하지 않았으며 Figma 일치 검수로 주장하지 않는다. 향후 디자인 변경이 필요하면 저장소의 화면별 Figma 확인 절차를 적용한다.

### 5.4 인증·설정

- `Bun.password`를 Workers에서 실행 가능한 암호 해시 구현으로 교체한다. Web Crypto 기반 PBKDF2를 우선 실험 대상으로 두고 salt·알고리즘·비용 파라미터를 저장한다. 최종 비용은 보안 기준과 실제 CPU 측정 후 확정하며 단순 SHA-256 암호 저장으로 대체하지 않는다.
- Bun 해시는 Web Crypto 또는 호환되는 Node crypto로 교체하고 기존 해시 출력 의미를 검증한다.
- 세션·로그인 실패 제한은 D1에 유지한다. 실패 횟수 누락, flash 덮어쓰기, 로그아웃 직후 늦게 끝난 요청의 세션 부활을 동시성 시험에 포함한다.
- 운영 IP는 Cloudflare가 제공한 신뢰 경계 안의 값을 사용한다. 현재 `TRUST_PROXY`/`X-Real-IP` 로직을 그대로 복사하지 않는다.
- DB·R2·Queue·Browser binding과 `SITE_URL`, Slack 설정을 요청별 환경으로 주입한다. 전역 mutable 환경으로 요청 간 설정이 섞이지 않게 한다.
- Slack 토큰은 Secret으로 보관하고, 운영의 실제 발송/Mock 모드는 명시적으로 설정한다.

### 5.5 작업 큐와 Slack

`jobs` 테이블을 작업 상태의 기준으로 유지한다. 업무 변경과 job 생성은 같은 DB 원자적 단위로 기록하고 Queue에는 작은 job ID만 보낸다. DB 기록 후 Queue 전송 전에 종료되어도 Cron이 미전달 작업을 다시 전달하도록 한다.

Queues는 중복 전달될 수 있으므로 job ID/dedupe key, 조건부 claim, 임대 만료 시각과 실행 토큰이 필요하다. 프로세스 내부 `busy` 플래그는 제거한다. [Queues 전달 보장](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)

- GENERATE/PDF: 재실행 가능하게 만들고 오래된 실행 토큰·revision의 결과 반영을 거부한다. 회차 전체 생성은 대상별 job으로 나눈다.
- DM/REPORT: 외부 전송 후 DB 성공 기록 전에 종료되면 전송 여부가 불명확하다. 자동 재발송하지 않고 현재처럼 UNKNOWN으로 남겨 관리자가 확인한다.
- Slack 429처럼 명확히 재시도할 수 있는 경우는 재시도 시각을 보존한다. 일반 네트워크 오류와 명확한 API 거절을 구분한다.
- DONE/취소/UNKNOWN 중복 메시지는 다시 발송하지 않는다. 임대 만료된 외부 전송은 UNKNOWN으로 전환한다.
- 생성 작업의 실패 재시도와 Slack 발송 재시도를 분리한다. 한 건 실패로 이미 전송된 다른 Queue 메시지가 다시 전송되지 않도록 개별 완료 처리를 검증한다.
- 최종 실패·DLQ·UNKNOWN 수와 처리 지연을 관측한다. 기존 관리자 재시도·수신 확인 UI와 상태 의미는 유지한다.

Slack SDK는 `nodejs_compat`에서 실제 사용하는 lookup·DM·파일 업로드 경로를 검증한 뒤 유지 여부를 결정한다. 지원되지 않으면 HTTP 어댑터로 교체하되 HTML와 PDF 첨부를 단순 링크 발송으로 바꾸지 않는다. 파일 업로드 중 부분 성공도 UNKNOWN 판정에 포함한다.

### 5.6 PDF

기존 `PdfConverter` 경계를 유지하면서 Browser Run 어댑터로 교체한다. 공식 문서는 Worker에서 브라우저를 제어해 `page.pdf()`로 생성하는 방식을 제공한다. [PDF 생성 문서](https://developers.cloudflare.com/browser-run/how-to/pdf-generation/)

1280×720 인쇄 크기, 여백 0, 배경 출력, 페이지 분할, 한글·SVG·이미지를 비교한다. 기존 JavaScript 비활성화·외부 네트워크 차단도 보존해야 한다. 단순 PDF REST 호출로 이 격리 조건이 충족된다고 가정하지 않는다. Cloudflare용 브라우저 라이브러리와 버전을 고정하고 실제 binding에서 검증한다.

브라우저 동시 실행 한도에 맞춰 Queue 동시성을 제한하고, finally에서 브라우저를 정리한다. 로컬 Chromium 성공과 Cloudflare 브라우저 성공은 별도 증거로 남긴다.

## 6. 구현 순서와 완료 조건

| 단계 | 수행 내용 | 통과 조건 |
| --- | --- | --- |
| M0 계약·위험 실험 | HTTP 계약 fixture, Worker 템플릿, D1 제출/CSV 원자성, 제한 양식, 실제 Browser PDF 소규모 실험 | 핵심 기능을 생략하지 않고 구현 가능한지 확인; 실패 시 설계 재검토 |
| M1 실행 기반 | Worker 진입점, 환경 타입, assets, 신규 D1 migration, 비동기 repository | 새 환경에서 health·초기 설정·로그인·화면 렌더링 |
| M2 업무 기능 | 회원·CSV·회차·문항·배정·리뷰·검증, 세션 경합 대응 | 기존 업무 회귀 + 동시성·롤백 시험 통과 |
| M3 파일·보고서 | R2 이미지·HTML/PDF, 폰트 로딩, 템플릿·해시·revision | 접근 통제·자가 포함 HTML·실제 PDF 및 기존 페이지 분할 검증 |
| M4 작업·발송 | outbox 전달, Queues 소비, Cron 복구, Slack 어댑터 | 중복·중단·429·UNKNOWN·부분 실패·구 revision 시험 통과 |
| M5 통합·운영 준비 | Worker 기반 UI/통합 CI, 관리 명령 대체, 백업·복구·관측·용량 측정 | 스테이징 전체 업무 흐름과 복구 검증, 배포 자료 완성 |
| M6 운영 전환 | 별도 승인 후 초기 관리자 설정, 도메인 전환, EC2 작업 중지 | 새 환경 정상 처리 확인 후 EC2 리소스 회수 |

M0의 원격 실험은 구현 승인 이후 별도 개발 리소스에서 수행한다. 실제 Slack 메시지 전송과 운영 전환은 대상·범위에 대한 명시적 승인 후 진행한다. 코드 구현 승인만으로 운영 발송이나 EC2 종료를 수행하지 않는다.

## 7. 검증 계획

기존 `tests/unit`, `tests/integration`, `tests/ui/verify.ts`, `scripts/verify-pdf.ts`를 기능 기준으로 재사용한다. Bun SQLite 테스트 통과만으로 D1 호환을 판단하지 않는다.

1. 순수 로직: 점수·품질 필터·익명 집계·CSV 인코딩·페이지 분할.
2. Worker 통합: 실제 Worker 런타임과 로컬 D1/R2/Queues에서 라우트·쿠키·CSRF·오류·파일 응답 비교.
3. 경합·장애: 중복 제출, 제출/마감, 동시 setup, 인증 실패 동시 증가, DB/R2/Queue 사이 종료, 오래된 job 완료.
4. 브라우저: 실제 로컬 HTTP 서버에서 관리자·리뷰어 핵심 화면, 데스크톱/모바일 및 라이트/다크, 기존 오류·완료 상태 비교.
5. 보고서: 한국어·긴 답변·많은 선택지·이미지·사용자 양식, PDF 페이지 수·텍스트·시각 결과 비교.
6. 스테이징: 실제 D1/R2/Queues/Browser Run 연결과 허가된 테스트 Slack 수신 확인.
7. 용량: CSV 10,000행, 부서 자동 매칭 증가, 최대 허용 파일, 회차 일괄 보고서 생성에서 CPU·메모리·쿼리 수·대기 시간 측정.

현재 쿼리 수 최적화 테스트는 유지하되, D1 네트워크 왕복과 읽기/쓰기 행 수도 측정한다. 기존 UI/PDF 검증 스크립트의 Bun 서버·파일 DB 가정은 Worker 개발 서버와 테스트 binding에 맞게 변경한다.

운영 CLI의 기능은 기존 관리자 경로로 수행하는 것을 우선한다. `scripts/manage.ts`의 DB 직접 접근 명령은 그대로 실행할 수 없으므로 필요한 자동화는 인증된 운영 인터페이스로 별도 설계하고, 미승인 결과지 발송 금지 규칙을 유지한다. 백업은 SQLite 파일 복사 대신 D1 복구 수단과 R2 객체·메타데이터 정합성 복구 절차로 바꾼다.

## 8. 비용·전환·남은 결정

무료 운영 가능 여부나 절감 금액은 아직 확정하지 않는다. 현재 트래픽·회원 수·회차당 보고서 수·월 PDF 실행 시간이 없기 때문이다. 특히 PDF 브라우저 사용량, D1 읽기/쓰기, R2 저장·요청, Queue 처리량을 스테이징에서 수집해 선택한 계정 요금제와 대조한다.

전환 시 새 데이터로 초기화한다. 기존 서버는 전환 시점에 쓰기·발송을 중지해 두 환경이 동시에 DM을 보내지 않게 한다. 기존 DB·파일은 운영 정책에 따라 별도로 보존할 수 있으나 새 서비스로 자동 이관하지 않는다.

롤백은 단순 DNS 복귀만으로 데이터가 합쳐지지 않는다. 새 환경에서 입력을 받기 전에는 기존 서비스 복귀가 비교적 단순하지만, 입력을 받은 뒤에는 신규 데이터 처리와 재발송 여부를 별도로 결정해야 한다. EC2 자원 삭제는 새 서비스 확인 후 수행한다.

구현 전 또는 M0에서 확정할 항목:

- Cloudflare 계정·도메인·개발/운영 리소스 구분과 사용 가능한 요금제.
- 최대 회원 수·부서 규모·회차 수와 보고서 생성 빈도.
- 암호 해시 방식·비용, D1 대량 작업 전략, Browser Run 라이브러리 선택.
- 운영 CLI 자동화가 실제로 필요한지와 데이터 초기화 시점.

## 9. 이번 조사에서 확인한 범위

현재 소스, 설치된 Nunjucks 컴파일 경로, 테스트 항목, Docker·CI 구성 및 공식 문서의 연결과 본문을 읽었다. 과거 작업 기록은 회귀 검증 맥락을 찾는 용도로만 참고하고 현재 코드를 다시 확인했다.

테스트 실행, Worker 빌드, 실제 Cloudflare 계정의 권한·할당량 조회, 실 Slack 발송, 성능 측정, Figma 검수는 수행하지 않았다. 따라서 본 문서는 코드에 근거한 이전 계획이며 Cloudflare에서 이미 동작한다는 검증 결과가 아니다. 위 외부 링크는 2026-10-23 조사 시 본문 접근을 확인한 Cloudflare 공식 자료다.


## 10. 구현 시 확정한 변경 (2026-10-23)

사용자 승인 후 구현을 진행했다. §3에서 조건부 대안으로 둔 **SQLite Durable Object**를 D1 대신 채택했다. 현재 도메인에는 조회 결과에 따라 후속 SQL을 결정하고 중첩 트랜잭션을 수행하는 경로가 다수 존재한다. 이를 D1 batch로 기계적으로 변환하지 않고, Durable Object `transactionSync`로 기존 업무와 CSV 10,000행의 원자성을 유지했다. 따라서 §5.1의 비동기 D1 재작성 및 D1 migration은 수행하지 않으며, 동기 Repository와 Workers SQLite 드라이버를 사용한다.

관계 데이터·세션·outbox는 환경당 하나의 객체에 저장한다. 단일 객체의 처리량과 큰 부서 전체 매칭의 O(n²) 비용이 제약이다. 수평 분산이 필요한 규모에서는 별도 재설계가 필요하다. 이 결정은 D1을 사용한 것처럼 보고하지 않는다.

R2, Static Assets, Queues 분리, Browser Run, 사전 컴파일 템플릿, 제한 양식 인터프리터, PBKDF2 인증, 임대·실행 토큰, Cron 복구와 기존 HTTP 계약 유지 방향은 구현에 반영했다. R2 파일은 해시와 UUID로 구분하며 HTML/PDF 본문을 SQL 행에 저장하지 않는다. 폰트는 Assets에서 읽고, 각 결과지를 개별 작업으로 생성한다.

M0~M5의 로컬 구현·검증과 원격 스테이징 검증은 구분한다. 원격 계정·할당량·실제 Slack·원격 Browser Run 및 최대 운영 부하 검증은 배포 승인 이후 수행한다. M6 운영 전환은 미수행이다. 구체적인 실행·배포·복구 및 검증 범위는 [Workers 운영 문서](CLOUDFLARE_WORKERS_RUNBOOK.md)를 따른다.
