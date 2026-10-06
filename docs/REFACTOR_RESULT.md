# Bun + TypeScript 리팩토링 결과

작성일: 2026-10-06. 기존 웹사이트를 바탕으로 중단된 전환 작업을 이어서 구현했습니다. DB 이관은 제외했고, PDF 생성까지 TS로 전환했습니다. 운영 배포는 수행하지 않았습니다.

## 구현 결과

업무 흐름은 회차·팀원·문항 준비 → 매칭·PIN 발급 → 리뷰 임시 저장·제출 → 관리자 마감 → HTML·PDF 생성 → 검토 승인 → Slack 전달입니다. Hono HTTP 서버, Nunjucks 템플릿, SQLite 저장소·작업 큐를 사용합니다.

| 영역 | 결과 |
|---|---|
| HTTP 구조 | 공통 인증·세션·CSRF 처리와 10개 기능별 라우트 모듈을 분리했습니다. |
| 데이터·업무 규칙 | 제출 트랜잭션, 회차·매칭 권한, 상태별 편집 제한, CSV 전체 롤백·검증 이력, 버전 이력을 검증했습니다. 신규 Bun DB로 시작하며 Django DB는 이관하지 않습니다. |
| 웹사이트 | 기존 템플릿·CSS·폰트를 유지하는 방향으로 전환했습니다. 빈 이력 화면 오류와 390px 검증 화면의 가로 넘침을 수정했습니다. 실패·확인 필요 작업에 필요한 운영 버튼을 추가했습니다. |
| PDF | Python 변환기를 제거하고 별도 TS 프로세스에서 Playwright Chromium으로 생성합니다. 변환 시간 제한, 결과 형식 확인, 외부 요청·문서 스크립트 차단을 적용했습니다. |
| 보고서 데이터 | 긴 피드백을 원문을 보존해 페이지로 분할하고, 임의의 예시 키워드 대신 실제 선택 데이터를 표시합니다. 차트의 한글은 폰트 윤곽선으로 렌더링합니다. |
| 승인·발송 | 동일 내용 재생성은 PDF·발송 이력을 보존합니다. 변경된 내용은 새 버전으로 생성하고 재승인합니다. 이전 작업이 변경된 보고서를 보내지 않도록 승인 해시·버전을 확인합니다. |
| 장애 복구 | 생성 작업은 재실행하고, 수신 여부가 불명확한 발송은 `UNKNOWN`으로 남깁니다. 관리자가 수신 여부를 확인한 뒤 처리하며 자동 중복 발송을 피합니다. 손상된 payload·생성 실패도 실패 이력으로 남깁니다. |
| 운영 | TS 운영 명령·SQLite/media 백업 스크립트, Bun/Chromium Docker 구성, 타입·업무·UI·PDF CI 검증을 마련했습니다. |

## PDF 디자인 변경 지점

웹사이트와 별도로 다음 세 파일에서 PDF 디자인을 변경할 수 있습니다.

- [보고서 HTML·CSS](../core/templates/reports/peer_review_report.html): 표지·카드·차트 배치와 제품 문구
- [인쇄 설정](../src/reporting/print-style.ts): 페이지 크기·인쇄 색상·이미지 높이
- [페이지 분할](../src/reporting/pagination.ts): 긴 텍스트와 선택지의 페이지 배치

집계·승인·발송은 [보고서 서비스](../src/reports.ts)에 분리되어 있습니다. 현재 기본 PDF는 1280 × 720 슬라이드입니다. 한글 본문은 텍스트 추출이 가능하고, 차트 글자는 윤곽선으로 출력됩니다. 새 디자인을 적용하면 HTML·PDF를 다시 생성하고 검토해야 합니다.

## 최종 검증

| 검증 | 결과 |
|---|---|
| `bun run format:check` | 통과 |
| `bun run typecheck` | 통과 |
| `bun run test` | 57건 통과, 실패 0건, assertion 219건 |
| `bun run test:ui` | 33개 화면 × 데스크톱/모바일 × 라이트/다크, 총 132개 캡처. 가로 넘침 검사 및 브라우저 임시 저장·제출 흐름 통과 |
| `bun run test:pdf` | 예시 3건 각각 7페이지, 긴 피드백 11페이지. 실제 PDF 페이지 수·한글 원문 보존 검사 통과 |
| PDF 시각 점검 | 예시 1건의 전체 7페이지와 긴 피드백 중간 4페이지를 렌더링해 카드·본문·바닥글 잘림을 점검 |
| Compose 정적 검증 | `.env.example`로 구성 해석. 컨테이너 `HOST=0.0.0.0`, `NODE_ENV=production`, 호스트 `127.0.0.1:8000` 확인 |
| `git diff --check` | 통과 |

UI 산출물은 `artifacts/ui/checks.json`과 같은 디렉터리의 화면 캡처이며, PDF 산출물은 `output/pdf/`와 `artifacts/pdf/`입니다. 로컬 Chromium 경로를 명시해 실행했습니다. Playwright 기본 브라우저를 쓰는 환경에서는 README의 브라우저 설치 절차가 필요합니다.

[기존 58개 Django 테스트 시나리오 대응표](FEATURE_PARITY.md)는 신규 구현·검증과의 연결을 기록합니다. 기존 Python 테스트 자체를 실행한 결과는 아닙니다.

## 검증 범위와 운영 전 확인

- Docker 데몬이 실행되지 않아 이미지 빌드·컨테이너 실행을 검증하지 못했습니다. 배포 환경에서 Docker 빌드와 PDF 생성을 확인해야 합니다.
- Slack 테스트는 대체 어댑터를 사용했습니다. 실제 토큰·워크스페이스 권한·DM·HTML/PDF 업로드는 별도 테스트 회차로 확인해야 합니다.
- GitHub Actions 워크플로를 추가했으며 원격 CI 실행 결과는 아직 없습니다.
- UI 검증은 현재 코드의 렌더링·응답·반응형·오류 상태 검증입니다. 최신 Figma 재조회 또는 이전 Django 화면과의 픽셀 단위 일치 검증은 수행하지 않았습니다.
- 기본 양식과 예시·긴 피드백을 검증했습니다. 임의의 커스텀 HTML, 매우 긴 문항 제목, 모든 문항·카테고리 조합의 배치는 자동 검증 완료로 간주하지 않습니다.
- 기존 Bun 스키마의 테이블 갱신·데이터 보존은 테스트했지만, 중단된 버전의 승인·발송 큐 승계는 운영 검증하지 않았습니다. 이번 전환은 사용자 요청대로 빈 신규 DB를 기준으로 합니다.
- 웹사이트에 들어 있던 기존 폰트를 유지했습니다. 보고서 디자인을 교체할 때 폰트 파일의 실제 서체와 사용 권한도 함께 확인하는 편이 좋습니다.

## 작업 보존과 문서

리팩토링 작업은 `codex/bun-refactor`에서 진행했으며 로컬 기준 커밋 `ae02b6f`는 `codex/django-baseline`으로 보존했습니다. 재개 직전 코드 사본은 `/private/tmp/peerflow-code-baseline-20261005.tar.gz`에 있습니다. 임시 디렉터리의 사본은 장기 보관용이 아니므로 필요하면 별도 위치로 옮겨야 합니다. 최초 로컬 검증 단계에서는 커밋·푸시를 수행하지 않았습니다. 이후 사용자 요청으로 개발·배포 문서를 `DEPLOYMENT.md`에 통합하고, 원격 Django 기준 커밋 `9f04ff99bae4fe0df151167a5bd6f279f8070f67`을 `legacy-django`로 보존하며 신규 시스템을 `main`에 게시하는 작업을 진행합니다. 실제 DB 이관·실제 Slack 발송·운영 배포는 수행하지 않았습니다.

- [개발 실행·검증 명령](../README.md)
- [구현 구조](TECHNICAL_SPECIFICATION.md)
- [배포·백업·복구](DEPLOYMENT.md)
- [Slack 연동](SLACK_INTEGRATION_GUIDE.md)
- [커스텀 보고서 양식](CUSTOM_HTML_TEMPLATE_GUIDE.md)
- [승인된 재개 계획과 최초 진단](REFACTOR_CONTINUATION_SPEC.md)

PDF 구현 방식은 [Playwright `page.pdf` 공식 문서](https://playwright.dev/docs/api/class-page#page-pdf)를 확인했습니다. 컨테이너 브라우저 구성은 [Playwright Docker 문서](https://playwright.dev/docs/docker), 이메일 조회 권한은 [Slack `users.lookupByEmail` 공식 문서](https://docs.slack.dev/reference/methods/users.lookupByEmail/)를 기준으로 정리했습니다.
