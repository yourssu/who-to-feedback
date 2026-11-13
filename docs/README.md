# PeerFlow v2 문서 아카이브 (`docs/`)

본 디렉터리는 기존 레거시 피어리뷰 시스템(`legacy-django`, `legacy-ts`)을 전면 폐기하고 **Cloudflare Workers + Pages + D1 + R2 + Queues + Browser Rendering** 기반의 서버리스 아키텍처(**PeerFlow v2**)로 재설계·재구현한 모든 배경, 의사결정, 데이터베이스 스키마, REST API 명세, 배포 및 운영 가이드를 기록한 문서 모음입니다.

---

## 문서 목차

| 문서 파일 | 설명 |
| :--- | :--- |
| **[01. 재설계 배경 및 기능 범위 정의](./01-redesign-background-and-scope.md)** | 레거시 코드베이스 폐기 사유, 구조적 문제점 분석, 유지·제거·보류 기능 의사결정 내역 |
| **[02. 서버리스 아키텍처 및 서비스 파이프라인](./02-architecture-and-pipeline.md)** | Cloudflare 서버리스 아키텍처 구성, 4단계 회차 상태 머신(`DRAFT` → `ACTIVE` → `COMPLETED` → `CLOSED`), 비동기 큐 파이프라인 |
| **[03. 데이터베이스 스키마 및 스토리지 명세](./03-database-schema.md)** | Cloudflare D1 13개 정규화 테이블 DDL, ERD, 레거시 대비 변경점, R2 디렉터리 구조, Queue 메시지 스키마 |
| **[04. OpenAPI 3.1.0 REST API 명세](./04-api-specification.md)** | OpenAPI 3.1.0 설계 원칙, 10개 소문자 단일 단어 태그별 엔드포인트 명세, 인증·CSRF·에러 응답 규격 (원본: [`../openapi.yaml`](../openapi.yaml)) |
| **[05. 배포, 테스트 및 운영 가이드](./05-deployment-and-operations.md)** | 개인 Cloudflare 계정(`*.workers.dev`) 배포 방법, `MOCK_SLACK_MODE` 로그 확인, 트러블슈팅 및 운영 노하우 |

---

## 브랜치 아카이브 안내

* **`main`**: OpenAPI 3.1.0 및 Cloudflare D1 스키마 기준으로 처음부터 재설계·구현된 **PeerFlow v2** 코드베이스
* **`legacy-ts`**: 재설계 이전의 TypeScript/Hono + Nunjucks SSR 하이브리드 레거시 코드베이스 아카이브
* **`legacy-django`**: 초기 Python Django 기반 프로토타입 아카이브
