# 기술 명세서 및 시스템 아키텍처 (Technical Specification)

본 문서는 Django 기반 피어리뷰 웹 애플리케이션 (PeerFlow)의 내부 구조, 시스템 파이프라인, 데이터 모델, 8개 관리자 센터 및 API 연동 명세서입니다.

---

## 1. 시스템 구조 및 워크플로우

시스템은 웹 애플리케이션(Django), 인증 및 메세징 서비스(Slack SDK), PDF/PPT 생성 엔진(xhtml2pdf / python-pptx)으로 구성됩니다.

```
[관리자 (PeerFlow Admin Panel)] ──> [Django 웹 시스템] <─── [리뷰어 (PeerFlow Reviewer)]
                                         │
                                 [Slack API (DM)]
                                         │
                       (PIN 코드 / 리마인더 / PDF/PPT 리포트)
```

---

## 2. 주요 모듈 명세

### 2.1 인증 서비스 (`core/views/auth_views.py`, `core/services/slack_service.py`)
- **PIN 코드 생성**: 리뷰 회차 시작 시 `ReviewAuthCode` 모델을 통해 각 사용자별 6자리 숫자 PIN 코드를 생성합니다.
- **Slack DM 메세지 발송**: `slack_sdk.WebClient.chat_postMessage` API를 이용하여 사용자 Slack ID로 PIN 코드와 접속 URL을 전송합니다.
- **세션 인증**: 사용자는 6자리 PIN 코드를 입력하여 로그인하며, 세션에 `member_id` 및 `cycle_id`가 저장됩니다.

### 2.2 리뷰 작성, 임시 저장 및 마감 제어 (`core/views/review_views.py`)
- 관리자가 매칭한 리뷰어-리뷰이 쌍(`ReviewAssignment`) 단위로 응답을 작성합니다.
- **임시 저장 (Draft)**: 작성 중인 답변을 `ReviewAssignment.draft_data`에 JSON 형식으로 보존합니다.
- **마감 시각 기반 수정 및 자동 잠금**:
  - 마감 이전 (`now <= cycle.end_at`): 제출 완료 후에도 마감 시각 전까지는 수정 허용 (`r-submitted-editable`)
  - 마감 경과 (`now > cycle.end_at`): 제출 답변 수정 불가능 및 자동 잠금 (`r-submitted-locked`)

### 2.3 커스텀 관리자 웹 UI (`core/views/admin_views.py` - 8개 전용 센터)
모든 페이지는 Django superuser 계정(`is_superuser=True`)으로 로그인되어야 접근 가능합니다(`@superuser_required`).

1. **메인 대시보드 (`/admin-panel/`)**: 등록된 회차 목록, 회차별 제출 진행률(%), 검토 대기 리포트 개수 및 빠른 작업 버튼
2. **팀원 관리 (`/admin-panel/members/`)**: 사용자 데이터 등록(이름, 이메일, Slack User ID, 부서, 역할 `ADMIN`/`MEMBER`), 수정 및 삭제
3. **⭐ 데이터 검증 (`/admin-panel/validation/`)**:
   - 엑셀 업로드 직후 필수값 오류 검출 (이름 누락, 팀/역할 누락, 점수 누락 등)
   - 이름/닉네임 유사도 기반 정규화 자동 병합 제안 (`Alex / alex / ALEX` ➔ `Alex` 병합)
   - 응답 품질 필터 ("없습니다", "잘 모르겠습니다" 등 의미 없는 서술형 피드백 자동 검출 및 리포트 제외)
   - 샘플 데이터 3명 레이아웃 검수 모드
4. **질문지 제작 (`/admin-panel/cycles/<id>/questions/`)**: 문항 추가, 삭제, 4가지 유형 및 척도 라벨(`NUMERIC_5`/`TEXT_5`) 옵션 선택
5. **매칭 관리 (`/admin-panel/cycles/<id>/assignments/`)**:
   - 부서별 필터링 기반 1:1/1:N 매칭 지정 및 360도 전체 매칭 생성
   - `ACTIVE` 진행 상태에서 매칭 추가 시 신규 리뷰어에게 PIN 코드가 전송됨
6. **진행 상태 대시보드 (`/admin-panel/cycles/<id>/status/`)**:
   - 회차 진행률 프로그레스 바 및 리뷰어별 미작성 동료 명단 조회
   - 자동 리마인더 설정 (매일 10:00 자동 발송) 및 Strict 100% 제출 게이트 제어
7. **리포트 검토 (`/admin-panel/cycles/<id>/reports/`)**:
   - 수신자별 익명 피드백 웹 요약 미리보기, PDF 및 PPT 결과 리포트 다운로드
   - 생성 실패 로그 보존 및 1클릭 재생성, 버전별(v1/v2) 부분 재생성 지원
8. **Slack DM 메세지 전송 (`/admin-panel/messages/send/`)**: 특정 사용자 또는 전체 사용자 대상 커스텀 DM 전송 및 실패한 대상만 재발송

---

## 3. 데이터베이스 ORM 스키마

- **Member**: `name`, `email` (unique), `slack_user_id`, `department`, `role` (`ADMIN` | `MEMBER`), `normalized_name`
- **ReviewCycle**: `title`, `start_at`, `end_at`, `status` (`DRAFT` | `ACTIVE` | `COMPLETED` | `CLOSED`), `auto_reminder_enabled`, `version`
- **ReviewQuestion**: `cycle` (FK), `order`, `question_type` (`RATING` | `TEXT` | `SINGLE_CHOICE` | `MULTIPLE_CHOICE`), `scale_type` (`NUMERIC_5` | `TEXT_5`), `content`
- **QuestionOption**: `question` (FK), `option_text`, `order`
- **ReviewAuthCode**: `member` (FK), `cycle` (FK), `code` (char 6), `created_at`, `is_used`
- **ReviewAssignment**: `cycle` (FK), `reviewer` (FK Member), `reviewee` (FK Member), `is_submitted`, `submitted_at`, `draft_data` (JSON), `draft_saved_at`
- **ReviewAnswer**: `assignment` (FK), `question` (FK), `rating_value`, `answer_text`, `selected_options` (M2M QuestionOption), `is_excluded_from_report`
- **ReviewReport**: `cycle` (FK), `reviewee` (FK Member), `pdf_file`, `ppt_file`, `version`, `validation_status` (`APPROVED` | `NEEDS_REVIEW` | `FAILED`), `created_at`, `is_sent`, `sent_at`, `error_log`
- **DataValidationLog**: `cycle` (FK), `row_index`, `issue_type`, `current_value`, `is_resolved`

---

## 4. 실제 Slack App 연동 세팅 가이드

1. **Slack App 생성**: [https://api.slack.com/apps](https://api.slack.com/apps) 접속 후 `From scratch`로 앱 생성
2. **Bot Token Scopes 4가지 부여**: `chat:write`, `files:write`, `im:write`, `users:read`
3. **Bot Token 발급**: `Install to Workspace` 실행 후 `xoxb-` 토큰 복사
4. **환경 변수 설정**: `.env` 파일에 `SLACK_BOT_TOKEN="xoxb-..."`, `MOCK_SLACK_MODE="False"` 지정
5. **Slack Member ID 입력**: Slack 사용자 프로필에서 복사한 `U12345678` ID를 `/admin-panel/members/` 등록
