# 기술 명세서 및 시스템 아키텍처 (Technical Specification)

본 문서는 Django 기반 피어리뷰 웹 애플리케이션의 내부 구조, 시스템 파이프라인, 데이터 모델 및 API 연동 명세서입니다.

---

## 1. 시스템 구조 및 워크플로우

시스템은 웹 애플리케이션(Django), 인증 및 메세징 서비스(Slack SDK), PDF 생성 엔진(xhtml2pdf)으로 구성됩니다.

```
[관리자 (Admin Panel)] ──> [Django 웹 시스템] <─── [리뷰어 (피어리뷰 작성)]
                                │
                        [Slack API (DM)]
                                │
                    (PIN 코드 / 리마인더 / PDF 리포트)
```

---

## 2. 주요 모듈 명세

### 2.1 인증 서비스 (`core/views/auth_views.py`, `core/services/slack_service.py`)
- **PIN 코드 생성**: 리뷰 회차 시작 시 `ReviewAuthCode` 모델을 통해 각 사용자별 6자리 숫자 PIN 코드를 생성합니다.
- **Slack DM 메세지 발송**: `slack_sdk.WebClient.chat_postMessage` API를 이용하여 사용자 Slack ID로 PIN 코드와 접속 URL을 전송합니다.
- **세션 인증**: 사용자는 6자리 PIN 코드를 입력하여 로그인하며, 세션에 `member_id` 및 `cycle_id`가 저장됩니다. 테스트 환경에서는 서버 로거 및 콘솔에 PIN 코드가 함께 출력됩니다.

### 2.2 리뷰 작성 및 응답 저장 (`core/views/review_views.py`)
- 관리자가 매칭한 리뷰어-리뷰이 쌍(`ReviewAssignment`) 단위로 응답을 작성합니다.
- 문항 유형별 저장 방식:
  - `RATING`: 1~5 정수값 저장 및 척도 라벨 옵션 (`NUMERIC_5`: 1~5점 / `TEXT_5`: 매우 아님 ~ 매우 그럼) 지원
  - `TEXT`: 문자열 텍스트 저장 (`ReviewAnswer.answer_text`)
  - `SINGLE_CHOICE`: `QuestionOption` 객체 단일 매핑 (`ReviewAnswer.selected_options`)
  - `MULTIPLE_CHOICE`: `QuestionOption` 객체 다중 매핑 (`ReviewAnswer.selected_options`)

### 2.3 커스텀 관리자 웹 UI (`core/views/admin_views.py`)
기존 Django Admin을 대체하는 6개의 전용 웹 페이지로 구성되어 있으며, 모든 페이지는 Django superuser 계정(`is_superuser=True`)으로 로그인되어야 접근 가능합니다(`@superuser_required`). 비인가 사용자 접근 시 `/admin/login/`으로 이동합니다.

1. **메인 대시보드 (`/admin-panel/`)**: 등록된 리뷰 회차 목록, 회차별 진행률(%) 및 회차 생성
2. **팀원 관리 (`/admin-panel/members/`)**: 사용자 데이터 등록(이름, 이메일, Slack User ID, 부서), 수정 및 삭제
3. **질문지 제작 (`/admin-panel/cycles/<id>/questions/`)**: 문항 추가, 삭제 및 객관식 선택지(`QuestionOption`) 관리
4. **매칭 관리 (`/admin-panel/cycles/<id>/assignments/`)**:
   - 부서별 필터링 기반 1:1/1:N 매칭 지정 및 삭제, 360도 전체 매칭 생성
   - `ACTIVE` 진행 상태에서 매칭 추가 시 신규 리뷰어에게 PIN 코드가 전송됨
5. **진행 상태 대시보드 (`/admin-panel/cycles/<id>/status/`)**:
   - 회차 진행률 프로그레스 바 및 리뷰어별 미작성 동료 명단 조회
   - 회차 시작(`start_cycle`), 독촉 리마인더(`send_reminder`), PDF 리포트 일괄 생성 (`generate_reports`)
6. **HTML/PDF 검토 (`/admin-panel/cycles/<id>/reports/`)**:
   - 피어리뷰 수신 피드백 익명 요약 HTML 미리보기 및 PDF 파일 다운로드
   - 승인 배포 실행 시 Reviewee의 Slack DM으로 PDF 파일 업로드 (`files.upload_v2`)
7. **Slack DM 메세지 전송 (`/admin-panel/messages/send/`)**: 특정 사용자 또는 전체 사용자 대상 메시지 직접 전송

### 2.4 미작성자 알림 및 마감 제어
- **리마인더 알림**: 마감 전 미제출된 매칭(`is_submitted=False`)을 확인하여 해당 리뷰어가 작성해야 하는 리뷰이(동료) 목록을 추출 후 Slack DM으로 안내합니다.
- **마감 제어**: 모든 매칭의 제출이 완료되어야 회차 상태가 `COMPLETED`로 변경되며, PDF 생성이 허용됩니다.

---

## 3. 데이터베이스 ORM 스키마

- **Member**: `name`, `email` (unique), `slack_user_id`, `department`
- **ReviewCycle**: `title`, `start_at`, `end_at`, `status` (`DRAFT` | `ACTIVE` | `COMPLETED` | `CLOSED`)
- **ReviewQuestion**: `cycle` (FK), `order`, `question_type` (`RATING` | `TEXT` | `SINGLE_CHOICE` | `MULTIPLE_CHOICE`), `content`
- **QuestionOption**: `question` (FK), `option_text`, `order`
- **ReviewAuthCode**: `member` (FK), `cycle` (FK), `code` (char 6), `created_at`, `is_used`
- **ReviewAssignment**: `cycle` (FK), `reviewer` (FK Member), `reviewee` (FK Member), `is_submitted`, `submitted_at`, `last_reminded_at`
- **ReviewAnswer**: `assignment` (FK), `question` (FK), `rating_value`, `answer_text`, `selected_options` (M2M QuestionOption)
- **ReviewReport**: `cycle` (FK), `reviewee` (FK Member), `pdf_file`, `created_at`, `is_sent`, `sent_at`

---

## 5. 실제 Slack App 연동 세팅 가이드

1. **Slack App 생성**: [https://api.slack.com/apps](https://api.slack.com/apps) 접속 후 `From scratch`로 앱 생성
2. **Bot Token Scopes 4가지 부여**: `chat:write`, `files:write`, `im:write`, `users:read`
3. **Bot Token 발급**: `Install to Workspace` 실행 후 `xoxb-` 토큰 복사
4. **환경 변수 설정**: `export SLACK_BOT_TOKEN="xoxb-..."`, `export MOCK_SLACK_MODE="False"`
5. **Slack Member ID 입력**: Slack 사용자 프로필에서 복사한 `U12345678` ID를 `/admin-panel/members/` 등록
