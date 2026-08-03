# PeerFlow 피어리뷰 시스템 통합 기술 명세서 (Technical Specification)

본 문서는 **Django 기반 익명 피어리뷰 및 AI/자동화 리포트 생성 시스템 (PeerFlow)**의 전체 시스템 아키텍처, 데이터 모델, 서비스 계층, 권한/보안 체계, 리포트 파이프라인 및 URL 라우팅 명세를 다룹니다.

---

## 1. 시스템 아키텍처 개요 (Architecture Overview)

PeerFlow 백엔드는 MVC(Model-View-Controller, Django MVT) 패턴과 독립된 **서비스 아키텍처(Service Layer)**를 채택하여 백엔드 비즈니스 로직, 데이터 검증, 리포트 생성 엔진, Slack 메시징 서비스를 모듈화하였습니다.

```mermaid
graph TD
    Client[리뷰어 / 관리자 클라이언트] --> DjangoURL[Django URL Router (core/urls.py)]
    DjangoURL --> AdminViews[관리자 센터 뷰 (admin_views.py)]
    DjangoURL --> ReviewViews[리뷰어 폼/대시보드 뷰 (review_views.py)]
    
    AdminViews --> AuthDecorator[@superuser_required 데코레이터]
    
    AdminViews --> ValService[DataValidationService (사전검증/정규화)]
    AdminViews --> LayoutService[LayoutCheckService (자동 레이아웃 검수)]
    AdminViews --> ReportServices[ReportService / PDFReportService / PPTReportService (HTML 리포트 엔진)]
    AdminViews --> SlackService[SlackService (PIN/독촉/리포트 DM)]
    
    ValService --> ORM[(SQLite / Django ORM DB)]
    LayoutService --> ORM
    ReportServices --> MediaStore[(Media Storage /reports_pdf/)]
```

---

## 2. 데이터베이스 ORM 스키마 명세 (`core/models.py`)

시스템은 총 **10개의 데이터 모델**로 구성되어 있습니다.

### 1) `Member` (팀원 정보 및 권한)
- `name`: 성명 (CharField, max_length=50)
- `email`: 이메일 주소 (EmailField, unique=True)
- `slack_user_id`: Slack User ID (CharField, max_length=50)
- `department`: 소속 부서 (CharField, max_length=100)
- `role`: 권한 역할 (`ADMIN` | `MEMBER`, CharField)
- `normalized_name`: 정규화 병합된 이름 (CharField, blank=True)

### 2) `ReviewCycle` (피어리뷰 회차 관리)
- `title`: 회차명 (CharField, max_length=200)
- `start_at`: 시작 일시 (DateTimeField)
- `end_at`: 마감 일시 (DateTimeField)
- `status`: 진행 상태 (`DRAFT` | `ACTIVE` | `COMPLETED` | `CLOSED`)
- `auto_reminder_enabled`: 자동 독촉 활성화 여부 (BooleanField, default=True)
- `auto_reminder_time`: 자동 독촉 시각 (TimeField, default="10:00")
- `version`: 템플릿/문항 버전 (CharField, default="v1")
- **프로퍼티**: `completion_rate`, `is_all_submitted`, `is_deadline_passed`, `is_question_locked`

### 3) `ReviewCycleVersionLog` (회차 버전 변경 이력)
- `cycle`: FK `ReviewCycle` (CASCADE)
- `version`: 버전 (CharField, max_length=10)
- `changed_summary`: 변경 내용 요약 (TextField)
- `created_at`: 기록 일시 (DateTimeField)

### 4) `ReviewQuestion` (리뷰 질문 문항)
- `cycle`: FK `ReviewCycle` (CASCADE)
- `order`: 문항 순서 (PositiveIntegerField)
- `question_type`: 문항 유형 (`RATING` | `TEXT` | `SINGLE_CHOICE` | `MULTIPLE_CHOICE`)
- `scale_type`: 척도 유형 (`NUMERIC_5` | `TEXT_5`)
- `content`: 질문 내용 (TextField)

### 5) `QuestionOption` (객관식 선택지)
- `question`: FK `ReviewQuestion` (CASCADE)
- `option_text`: 선택지 텍스트 (CharField, max_length=200)
- `order`: 선택지 순서 (PositiveIntegerField)

### 6) `ReviewAuthCode` (Slack 6자리 PIN 인증 코드)
- `member`: FK `Member`
- `cycle`: FK `ReviewCycle`
- `code`: 6자리 핀코드 (CharField, max_length=6)
- `is_used`: 사용 여부 (BooleanField)

### 7) `ReviewAssignment` (리뷰 매칭)
- `cycle`: FK `ReviewCycle`
- `reviewer`: FK `Member` (리뷰 작성자)
- `reviewee`: FK `Member` (리뷰 대상자)
- `is_submitted`: 제출 완료 여부 (BooleanField)
- `submitted_at`: 제출 일시 (DateTimeField)
- `draft_data`: 전체 폼 통합 임시 저장 데이터 (JSONField, null=True)
- `draft_saved_at`: 임시 저장 일시 (DateTimeField)

### 8) `ReviewAnswer` (리뷰 답변 데이터)
- `assignment`: FK `ReviewAssignment`
- `question`: FK `ReviewQuestion`
- `rating_value`: 척도 점수 (IntegerField, 1~5)
- `answer_text`: 주관식 피드백 (TextField)
- `selected_options`: M2M `QuestionOption`
- `is_excluded_from_report`: 응답 품질 필터 제외 여부 (BooleanField)
- `exclusion_reason`: 제외 사유 (CharField)

### 9) `ReviewReport` (피드백 결과 리포트)
- `cycle`: FK `ReviewCycle`
- `reviewee`: FK `Member`
- `pdf_file`: 결과지 리포트 파일 경로 (FileField, upload_to='reports_pdf/')
- `ppt_file`: PPT 연동 리포트 파일 경로 (FileField, upload_to='reports_ppt/')
- `version`: 리포트 버전 (CharField)
- `validation_status`: 5단계 검수 상태 (`GENERATED` | `NEEDS_REVIEW` | `APPROVED` | `SENT` | `FAILED`)
- `admin_memo`: 관리자 수정 메모/코멘트 (TextField)
- `layout_check_passed`: 자동 레이아웃 검수 통과 여부 (BooleanField)
- `layout_issue_notes`: 레이아웃 검수 이슈 노트 (TextField)
- `error_log`: 생성 예외 로그 (TextField)
- `is_sent`: Slack DM 발송 여부 (BooleanField)

### 10) `SlackDeliveryLog` (Slack DM 발송 이력)
- `cycle`: FK `ReviewCycle` (null=True)
- `member`: FK `Member`
- `delivery_type`: DM 종류 (`AUTH_CODE` | `REMINDER` | `REPORT` | `CUSTOM_MSG` | `TEST_DM`)
- `message_content`: 메시지 본문 (TextField)
- `is_success`: 성공 여부 (BooleanField)
- `error_message`: 오류 원인 (TextField)

---

## 3. 핵심 서비스 모듈 명세 (`core/services/`)

### 1) `DataValidationService` ([validation_service.py](file:///Users/yoon/who-to-feedback/core/services/validation_service.py))
- **`validate_excel_data(file_obj, cycle)`**: 엑셀 업로드 직후 이름 누락, 중복 이름, 대소문자 불일치, 팀/역할 누락 등 6가지 데이터 오류 사전 검증.
- **`get_normalization_suggestions(cycle)`**: `difflib.SequenceMatcher` 알고리즘으로 유사도 85% 이상 닉네임/영문 이름(`Alex / alex / ALEX`) 정규화 병합 제안.
- **`filter_response_quality(answers)`**: `"없습니다"`, `"잘 모르겠습니다"` 등 의미 없는 주관식 답변 자동 감지 및 제외 처리.

### 2) `LayoutCheckService` ([layout_service.py](file:///Users/yoon/who-to-feedback/core/services/layout_service.py))
- **`check_layout_overflow(cycle, reviewee)`**: 300자/500자 이상 긴 글 overflow 및 키워드 태그 8개 이상 넘침 현상을 자동 검사하여 `layout_check_passed` 및 이슈 사유 저장.

### 3) `PDFReportService`, `PPTReportService`, `ReportManagementService` ([report_service.py](file:///Users/yoon/who-to-feedback/core/services/report_service.py))
- **통합 서비스 모듈**: 리포트 데이터 바인딩, HTML 렌더링, 파일 저장, 샘플 리포트 생성 및 체크리스트집계를 단일 서비스 모듈로 통합.
- **`generate_pdf_report(cycle, reviewee)`**: 템플릿 렌더링 결과물을 HTML 정적 리포트 파일로 즉시 저장하여 안정적인 웹 서빙 지원.
- **`generate_sample_reports(cycle, sample_count=3)`**: 실데이터 발송 전 대표 샘플 2~3명만 리포트를 미리 생성해 템플릿 테스트 모드 구동.
- **`get_delivery_checklist(cycle)`**: Slack 발송 전 이름 / 팀 / Slack ID / 리포트 존재 여부 / 승인 여부 5가지 지표 표 집계.

### 4) `SlackService` ([slack_service.py](file:///Users/yoon/who-to-feedback/core/services/slack_service.py))
- `send_auth_code_dm`, `send_reminder_dm`, `send_pdf_report_dm`, `send_test_dm`, `send_failed_reminders_retry` 메서드를 포함하며, 모든 DM 발송 결과를 `SlackDeliveryLog`에 전수 저장.

---

## 4. 보안 및 접근 제어 명세 (Security & Permissions)

- **관리자 권한 분리**: `@superuser_required` 데코레이터 적용 ➔ Django Superuser 또는 `role == 'ADMIN'` 인 계정만 커스텀 어드민 센터(`/admin-panel/`) 접근 허용.
- **리뷰어 세션 검증**: `/review/<assignment_id>/` 진입 시 `request.session['member_id']`와 `assignment.reviewer_id`를 검증하여 본인 할당 리뷰만 작성 허용.
- **질문지 잠금 정책 (ACTIVE Lock)**: 회차가 시작(`ACTIVE`)된 이후에는 질문 문항 및 선택지 추가/삭제 요청을 백엔드 뷰 차원에서 차단.
- **마감 전 수정 / 마감 후 잠금**: 마감 시각 이전(`now <= cycle.end_at`)에는 재수정 허용, 마감 시각 경과 후에는 `is_locked = True` 처리하여 수정 금지.

---

## 5. URL 라우팅 패치 명세 (`core/urls.py`)

| URL 패턴 | 뷰 함수 | 기능 설명 |
|---|---|---|
| `/login/` | `auth_views.login_view` | Slack 6자리 PIN 코드 인증 로그인 |
| `/` | `review_views.review_dashboard` | 리뷰어 개인 대시보드 |
| `/review/<assignment_id>/` | `review_views.review_form` | 피어리뷰 폼 작성 및 마감 잠금 제어 |
| `/review/<assignment_id>/save-draft/` | `review_views.save_draft` | 전체 질문지 폼 통합 임시 저장 API |
| `/admin-panel/` | `admin_views.admin_dashboard` | 관리자 메인 대시보드 |
| `/admin-panel/validation/` | `admin_views.admin_validation` | 데이터 사전 검증 & 정규화 센터 |
| `/admin-panel/cycles/<id>/sample-reports/` | `admin_views.admin_generate_sample_reports` | 샘플 3명 미리보기 테스트 리포트 생성 |
| `/admin-panel/cycles/<id>/layout-check/` | `admin_views.admin_run_layout_check` | 자동 레이아웃 검수 일괄 실행 |
| `/admin-panel/reports/<id>/regenerate/` | `admin_views.admin_regenerate_report` | 1클릭 개별 리포트/실패 재시도 |
| `/admin-panel/reports/<id>/memo/` | `admin_views.admin_save_report_memo` | 관리자 수정 메모/코멘트 저장 API |
| `/admin-panel/cycles/<id>/history/` | `admin_views.admin_cycle_history` | 회차 및 템플릿/문항 버전 변경 이력 뷰 |
| `/admin-panel/cycles/<id>/checklist/` | `admin_views.admin_delivery_checklist` | 발송 대상 체크리스트 뷰 |
| `/admin-panel/messages/retry-failed/` | `admin_views.admin_retry_failed_messages` | 실패한 Slack DM 1클릭 재발송 |
| `/admin-panel/messages/send-test/` | `admin_views.admin_send_test_dm` | 발송 전 관리자 테스트 DM 전송 |
