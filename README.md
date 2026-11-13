# PeerFlow v2

**Cloudflare Workers + Pages + D1 + R2 + Queues + Browser Rendering** 기반의 비공개 상호 피어리뷰 수집 및 리포트(HTML·PDF) 자동 배포 시스템입니다.

---

## 아키텍처 개요

* **Frontend (`web/`)**: Cloudflare Pages / Workers Static Assets 기반 SPA 클라이언트
* **Backend API (`src/`)**: Cloudflare Workers 기반 순수 JSON REST API ([openapi.yaml](openapi.yaml) — OpenAPI 3.1.0 표준 준수)
* **Database (`migrations/0001_initial.sql`)**: Cloudflare D1 (SQLite 호환) 13개 정규화 테이블
* **Storage (`FILES`)**: Cloudflare R2 — 설문 문항 참고 이미지(`questions/{cycle_id}/...`) 및 생성된 리포트(`reports/{cycle_id}/{reviewee_id}/...`) 저장
* **Async Pipeline (`REPORT_QUEUE`, `DELIVERY_QUEUE`)**: Cloudflare Queues — 익명 피드백 집계 및 HTML·PDF 생성, Slack DM 발송(PIN 발급, 미제출 리마인더, 최종 HTML+PDF 리포트 전달)

---

## 디렉터리 구조

```text
.
├── migrations/
│   └── 0001_initial.sql       # Cloudflare D1 초기 스키마 DDL
├── openapi.yaml               # OpenAPI 3.1.0 표준 REST API 명세
├── src/
│   ├── index.ts               # Cloudflare Workers 엔트리포인트 (fetch, queue, scheduled)
│   ├── app.ts                 # 세션·CSRF·권한 검증 미들웨어 및 라우터 연결
│   ├── router.ts              # Web Standards 기반 HTTP 라우터 및 에러 핸들러
│   ├── types.ts               # 도메인·인프라 타입 및 에러 정의
│   ├── schemas.ts             # OpenAPI 3.1.0 요청/파라미터 스키마 검증기
│   ├── crypto.ts              # Web Crypto API 기반 PBKDF2 해싱, SHA-256, CSPRNG PIN 생성
│   ├── db/
│   │   └── queries.ts         # D1 정규화 쿼리 및 트랜잭션 헬퍼
│   ├── routes/                # 태그별 REST API 라우트 핸들러
│   │   ├── auth.ts            # [auth] 초기 설정, 관리자/리뷰어 로그인·로그아웃, 세션 조회
│   │   ├── members.ts         # [members] 팀원 등록·조회·삭제 및 CSV 일괄 업로드
│   │   ├── cycles.ts          # [cycles] 회차 생성·조회·수정·시작·마감·리마인더
│   │   ├── questions.ts       # [questions] 설문 문항(R2 이미지 첨부) 및 객관식 선택지
│   │   ├── assignments.ts     # [assignments] 수동 매칭 및 전체/동일부서 자동 매칭
│   │   ├── reports.ts         # [reports] 리포트 목록, HTML/PDF 조회, 재생성, 일괄 승인·발송
│   │   ├── deliveries.ts      # [deliveries] Slack DM 발송 이력 조회 및 실패 건 재시도
│   │   ├── reviewer.ts        # [reviewer] 리뷰어 대시보드, 문항 조회, 임시 저장, 최종 제출
│   │   └── media.ts           # [media] 문항 첨부 이미지 R2 스트리밍 조회
│   ├── reporting/
│   │   └── generator.ts       # 익명 피드백 집계, SVG 차트 생성, HTML 렌더링 및 PDF 변환
│   └── slack/
│       └── delivery.ts        # Slack Web API 기반 PIN·리마인더·리포트(HTML+PDF) DM 발송
├── web/                       # Cloudflare Pages 프론트엔드 SPA
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── tests/                     # D1 + R2 + Queues 인메모리 하네스 기반 E2E 테스트
│   ├── test-harness.ts
│   └── e2e.test.ts
├── wrangler.jsonc             # Cloudflare Workers / D1 / R2 / Queues 설정
└── package.json
```

---

## 설계 및 운영 문서 (`docs/`)

레거시 폐기 배경부터 아키텍처, D1 DB 스키마, OpenAPI 3.1.0 REST API 명세, 배포 및 트러블슈팅 가이드는 [`docs/`](docs/README.md) 디렉터리에 정리되어 있습니다.

* **[01. 재설계 배경 및 기능 범위 정의](docs/01-redesign-background-and-scope.md)**
* **[02. 서버리스 아키텍처 및 서비스 파이프라인](docs/02-architecture-and-pipeline.md)**
* **[03. 데이터베이스 스키마 및 스토리지 명세](docs/03-database-schema.md)**
* **[04. OpenAPI 3.1.0 REST API 명세](docs/04-api-specification.md)** (전체 스펙: [`openapi.yaml`](openapi.yaml))
* **[05. 배포, 테스트 및 운영 가이드](docs/05-deployment-and-operations.md)**

---

## 주요 명령어

```bash
# 로컬 D1 마이그레이션 적용
npm run db:migrate:local

# 로컬 개발 서버 실행 (Wrangler)
npm run dev

# 전체 파이프라인 E2E 테스트 실행 (Node 22 내장 SQLite & Test Runner)
npm test

# 개인 Cloudflare 계정(*.workers.dev)으로 원클릭 배포
./scripts/deploy.sh
```

---

## 개인 Cloudflare 테스트 배포 가이드 (커스텀 도메인 미사용)

1. [.env.cloudflare](.env.cloudflare) 파일을 열어 Placeholder 값을 본인의 Cloudflare 정보로 변경합니다:
   ```env
   CLOUDFLARE_ACCOUNT_ID="YOUR_CLOUDFLARE_ACCOUNT_ID_HERE"
   CLOUDFLARE_API_TOKEN="YOUR_CLOUDFLARE_API_TOKEN_HERE"
   ```
   *(또는 터미널에서 `npx wrangler login`으로 OAuth 로그인을 수행해도 됩니다.)*
2. 배포 스크립트를 실행합니다:
   ```bash
   ./scripts/deploy.sh
   ```
   - 스크립트가 D1 데이터베이스(`peerflow-db`) 생성 및 `database_id` 자동 주입, 스키마 마이그레이션(`migrations/0001_initial.sql`), R2(`peerflow-files`) 및 Queues 생성(Workers Free 플랜일 경우 자동으로 내장 D1/인라인 폴백 모드로 전환), `*.workers.dev` 배포까지 한 번에 수행합니다.

