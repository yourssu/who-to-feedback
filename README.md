# PeerFlow

팀원 간 피어리뷰 작성과 보고서 제작·Slack 전달을 자동화하는 Bun + TypeScript 애플리케이션입니다. Hono, Nunjucks, SQLite를 사용하며 기존 웹사이트의 HTML·CSS·폰트·반응형·라이트/다크 테마를 유지합니다. Django DB 이관은 지원하지 않습니다.

팀원·회차·문항·매칭 준비 → 회차 시작과 PIN 발급 → 리뷰 임시 저장·제출 → 관리자 마감 → HTML·PDF 생성 → 검토 승인 → Slack 전달 순서로 동작합니다. 예약 자동 시작·자동 마감은 수행하지 않습니다.

## 개발 실행

```sh
bun install --frozen-lockfile
bunx playwright install chromium
bun run dev
```

`.env.example`을 `.env`로 복사하고 `SITE_URL`을 실제 접속 origin과 맞춥니다. `/setup/`에서 최초 관리자를 생성합니다. 이후 초기 설정은 404를 반환합니다. 관리자 로그인은 `/admin/login/`, 관리자 센터는 `/admin-panel/`, 리뷰어 로그인은 `/login/`입니다.

빈 개발 DB에서 `bun run seed`를 실행하면 예시 팀원·회차·문항·리뷰와 개발 PIN이 생성됩니다. 운영 또는 실제 Slack 모드에서는 실행할 수 없습니다. 기존 Django DB는 읽거나 변경하지 않으며 새 DB는 `data/peerflow.sqlite3`를 사용합니다.

## PDF 생성과 디자인 교체

PDF는 TS 작업 프로세스가 Playwright Chromium으로 HTML·CSS·SVG를 직접 인쇄합니다. Python·WeasyPrint·Pango 설치가 필요하지 않습니다. 출력은 텍스트를 추출할 수 있는 PDF이며 화면 캡처를 PDF로 조립하지 않습니다. 이미지와 폰트는 data URL로 포함하고 변환 중 외부 요청과 문서 스크립트를 차단합니다.

디자인은 `core/templates/reports/peer_review_report.html`, 인쇄 설정은 `src/reporting/print-style.ts`, 피드백 페이지 분할은 `src/reporting/pagination.ts`에서 교체합니다. 보고서 데이터를 집계하는 업무 로직과 분리되어 있습니다. 기본 보고서는 1280 × 720 슬라이드이며 긴 피드백은 원문을 보존해 이어지는 페이지로 나눕니다. 커스텀 양식의 배치는 관리자가 HTML·PDF로 검수해야 합니다.

Chromium이 이미 설치되어 있으면 `.env`의 `PDF_CHROMIUM_EXECUTABLE`로 경로를 지정할 수 있습니다. UI 검증에는 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`을 사용합니다. PDF 변환기도 이 값을 대체 경로로 사용할 수 있습니다.

## 승인·발송·복구

생성과 승인은 별개입니다. 전체 HTML·PDF가 준비된 뒤 ‘검토 완료 및 발송’이 현재 생성물의 버전·해시를 승인하고 두 파일을 Slack에 전달합니다. 동일 내용의 재생성은 기존 PDF·발송 이력을 보존합니다. 내용이 바뀌면 새 생성물 버전으로 다시 생성·검토합니다.

생성·변환·Slack 발송은 SQLite 큐에서 순차 처리합니다. 단일 앱 인스턴스로 운영합니다. 발송이 명시적으로 실패하면 `FAILED`, 수신 여부가 불명확하거나 전송 중 서버가 종료되면 `UNKNOWN`입니다. `UNKNOWN`은 자동 재전송하지 않습니다. 관리자 메시지 화면에서 Slack 수신 여부를 확인한 뒤 ‘수신 확인 완료’ 또는 ‘미수신 확인 및 재전송’으로 처리합니다.

## 검증

```sh
bun run typecheck
bun run test
bun run test:ui
bun run test:pdf
```

UI 검증은 메모리 DB·localhost HTTP 서버·가상 Slack으로 일반·빈 상태·오류·잠금·발송 실패·확인 필요 화면의 데스크톱/모바일 × 라이트/다크를 검사하며, 실제 브라우저에서 임시 저장·제출 흐름을 실행합니다. 산출물은 `artifacts/ui/`입니다.

PDF 검증은 실제 TS 변환기를 실행하고 Poppler의 `pdfinfo`, `pdftotext`로 페이지 수와 한글 피드백 원문을 확인합니다. macOS는 `brew install poppler`, Ubuntu는 `sudo apt-get install poppler-utils`로 검증 도구를 설치합니다. 예시 PDF는 `output/pdf/`, 긴 피드백 검증 PDF는 `artifacts/pdf/`에 저장됩니다. Poppler는 검증 도구이며 앱의 PDF 생성 의존성은 아닙니다.

기존 Chromium을 이용한 실행 예:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE="/Applications/Chromium.app/Contents/MacOS/Chromium" bun run test:ui
PLAYWRIGHT_CHROMIUM_EXECUTABLE="/Applications/Chromium.app/Contents/MacOS/Chromium" bun run test:pdf
```

`.github/workflows/verify.yml`은 정적·업무 검사와 브라우저 검사를 병렬 실행합니다. UI는 132개 변형을 유지하며 실제 PDF 검증은 별도 단계에서 실행합니다. Chromium headless shell 캐시를 사용하고 PDF·화면 캡처를 보존합니다. 로컬 검증 통과는 실제 Slack 전달 또는 운영 배포 완료를 의미하지 않습니다.

## 문서

- [구현 구조와 업무 규칙](docs/TECHNICAL_SPECIFICATION.md)
- [개발·배포·운영·백업·복구](docs/DEPLOYMENT.md)
- [Slack 연동](docs/SLACK_INTEGRATION_GUIDE.md)
- [프론트엔드 변경](docs/FRONTEND_MODIFICATION_GUIDE.md)
- [커스텀 보고서 양식](docs/CUSTOM_HTML_TEMPLATE_GUIDE.md)
- [리팩토링 결과](docs/REFACTOR_RESULT.md)
- [성능 개선·CI 검증 결과](docs/PERFORMANCE.md)
