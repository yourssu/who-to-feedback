# Django 기능 대응표

기준: `ae02b6f:core/tests.py`의 58개 테스트 시나리오. 기존 Python 테스트를 실행한 결과가 아니라 신규 구현·회귀 검증에 연결한 목록입니다. 테스트 수는 파라미터화·통합 방식이 달라 직접 비교하지 않습니다.

| 기존 시나리오 | 처리 | 신규 근거 |
|---|---|---|
| `test_01_validation_and_quality_filter` | 유지 | 단위 domain + 통합 parity: 품질 필터, 원본 이름 보존, CSV 검증 로그 |
| `test_02_layout_check_and_sample_reports` | 유지·개선 | 단위 pagination + 통합 parity/jobs + 실제 test:pdf: 샘플, 상태, 원문 보존 |
| `test_03_delivery_checklist_and_status_management` | 유지·개선 | 단위 pagination + 통합 parity/jobs + 실제 test:pdf: 샘플, 상태, 원문 보존 |
| `test_04_version_history_and_admin_memo` | 유지·개선 | 통합 parity/app: 빈·다중 이력, 메모, 재로그인 임시 답변 |
| `test_05_logout_cookie_deletion_and_draft_preservation` | 유지·개선 | 통합 parity/app: 빈·다중 이력, 메모, 재로그인 임시 답변 |
| `test_multiple_choice_validation_requires_at_least_one_option` | 유지 | 단위 domain + 통합 parity: 선택지 유효성·삭제·제외/복원 |
| `test_option_delete_api` | 유지 | 단위 domain + 통합 parity: 선택지 유효성·삭제·제외/복원 |
| `test_answer_exclusion_toggle_api` | 유지 | 단위 domain + 통합 parity: 선택지 유효성·삭제·제외/복원 |
| `test_deterministic_context_builder_method_a` | 유지 | 단위 domain + 통합 parity: 익명 DTO, 집계값, 결정적 정렬 |
| `test_custom_html_template_pdf_generation` | 유지·의도적 제한 | 단위 domain + test:pdf: 제한된 업로드 문법, TS 출력; 임의 템플릿 배치는 관리자 검수 |
| `test_generate_all_reports_for_cycle` | 유지·개선 | 단위 pagination + 통합 parity/jobs + 실제 test:pdf: 샘플, 상태, 원문 보존 |
| `test_strict_anonymity_enforcement` | 유지 | 단위 domain + 통합 parity: 익명 DTO, 집계값, 결정적 정렬 |
| `test_category_scoring_and_auto_charts` | 유지 | 단위 domain + 통합 parity: 익명 DTO, 집계값, 결정적 정렬 |
| `test_choice_question_ratio_charts` | 유지 | 단위 domain + 통합 parity: 익명 DTO, 집계값, 결정적 정렬 |
| `test_question_image_injection` | 유지 | 통합 parity: 실제 PNG 업로드·비로그인 차단·인증 조회·data URL 주입 |
| `test_health_check_endpoint` | 유지 | HTTP health smoke: 메모리 DB + 앱 응답 |
| `test_import_members_from_csv` | 유지 | 단위 domain: BOM·쉼표·줄바꿈·롤백; 통합 parity 및 CSV 별도 회귀 |
| `test_setup_wizard_flow` | 유지 | 통합 app/parity: 최초 관리자, 반복 설정 차단, Slack 정보는 팀원으로 연결 |
| `test_sidebar_links_always_active` | 유지 | 통합 app + UI: 관리자 화면, 빈 회차 및 라이트/다크 상태 |
| `test_validation_view_with_completed_and_draft_cycles` | 유지 | 통합 app + UI: 관리자 화면, 빈 회차 및 라이트/다크 상태 |
| `test_login_with_active_cycle_pin` | 유지 | 단위 domain + 통합 app/parity + UI: 활성 PIN·잠금·쿠키 독립 제한·GET 자동 로그인 금지 |
| `test_login_with_completed_cycle_pin_rejected` | 유지 | 단위 domain + 통합 app/parity + UI: 활성 PIN·잠금·쿠키 독립 제한·GET 자동 로그인 금지 |
| `test_login_with_draft_cycle_pin_rejected` | 유지 | 단위 domain + 통합 app/parity + UI: 활성 PIN·잠금·쿠키 독립 제한·GET 자동 로그인 금지 |
| `test_get_code_param_does_not_autologin` | 유지 | 단위 domain + 통합 app/parity + UI: 활성 PIN·잠금·쿠키 독립 제한·GET 자동 로그인 금지 |
| `test_relogin_with_same_pin_after_logout` | 유지 | 단위 domain + 통합 app/parity + UI: 활성 PIN·잠금·쿠키 독립 제한·GET 자동 로그인 금지 |
| `test_login_locked_after_five_failures` | 유지 | 단위 domain + 통합 app/parity + UI: 활성 PIN·잠금·쿠키 독립 제한·GET 자동 로그인 금지 |
| `test_review_form_editable_for_active_cycle` | 유지 | 단위 domain + 통합 app/parity + 브라우저 임시 저장·제출·마감 잠금 |
| `test_review_form_locked_for_inactive_cycles` | 유지 | 단위 domain + 통합 app/parity + 브라우저 임시 저장·제출·마감 잠금 |
| `test_review_post_rejected_for_closed_cycle` | 유지 | 단위 domain + 통합 app/parity + 브라우저 임시 저장·제출·마감 잠금 |
| `test_save_draft_rejected_for_closed_cycle` | 유지 | 단위 domain + 통합 app/parity + 브라우저 임시 저장·제출·마감 잠금 |
| `test_review_submit_allowed_for_active_cycle` | 유지 | 단위 domain + 통합 app/parity + 브라우저 임시 저장·제출·마감 잠금 |
| `test_dashboard_shows_only_session_cycle_assignments` | 유지 | 단위 domain + 통합 app/parity + 브라우저 임시 저장·제출·마감 잠금 |
| `test_dashboard_redirects_to_login_when_cycle_id_missing` | 유지 | 단위 domain + 통합 app/parity + UI: 활성 PIN·잠금·쿠키 독립 제한·GET 자동 로그인 금지 |
| `test_dashboard_hides_write_link_when_cycle_closed` | 유지 | 단위 domain + 통합 app/parity + 브라우저 임시 저장·제출·마감 잠금 |
| `test_create_cycle_end_before_start_shows_error` | 유지 | 통합 parity + 단위 domain: 날짜·문항·선택지·매칭·상태·마감 검증 |
| `test_create_cycle_valid_dates_succeeds` | 유지 | 통합 parity + 단위 domain: 날짜·문항·선택지·매칭·상태·마감 검증 |
| `test_start_non_draft_cycle_shows_error` | 유지 | 통합 parity + 단위 domain: 날짜·문항·선택지·매칭·상태·마감 검증 |
| `test_start_draft_without_questions_shows_error` | 유지 | 통합 parity + 단위 domain: 날짜·문항·선택지·매칭·상태·마감 검증 |
| `test_start_draft_without_assignments_shows_error` | 유지 | 통합 parity + 단위 domain: 날짜·문항·선택지·매칭·상태·마감 검증 |
| `test_start_draft_with_questions_and_assignments_succeeds` | 유지 | 통합 parity + 단위 domain: 날짜·문항·선택지·매칭·상태·마감 검증 |
| `test_auto_match_active_sends_pin` | 유지 | 통합 parity: 같은 부서와 ACTIVE 신규 PIN, DRAFT 발송 생략 |
| `test_auto_match_draft_does_not_send_pin` | 유지 | 통합 parity: 같은 부서와 ACTIVE 신규 PIN, DRAFT 발송 생략 |
| `test_setup_wizard_slack_user_id_empty` | 유지 | 통합 app/parity: 최초 관리자, 반복 설정 차단, Slack 정보는 팀원으로 연결 |
| `test_korean_csv_import_unique_emails` | 유지 | 단위 domain: BOM·쉼표·줄바꿈·롤백; 통합 parity 및 CSV 별도 회귀 |
| `test_apply_normalization_preserves_original_name` | 유지 | 단위 domain + 통합 parity: 품질 필터, 원본 이름 보존, CSV 검증 로그 |
| `test_non_choice_question_option_rejection` | 유지 | 단위 domain + 통합 parity: 선택지 유효성·삭제·제외/복원 |
| `test_same_department_auto_match` | 유지 | 통합 parity: 같은 부서와 ACTIVE 신규 PIN, DRAFT 발송 생략 |
| `test_unique_pin_code_generation` | 유지 | 단위 domain + 통합 app/parity + UI: 활성 PIN·잠금·쿠키 독립 제한·GET 자동 로그인 금지 |
| `test_pin_validity_persists_during_active` | 유지 | 단위 domain + 통합 app/parity + UI: 활성 PIN·잠금·쿠키 독립 제한·GET 자동 로그인 금지 |
| `test_invalid_rating_value_rejection` | 유지 | 단위 domain: 1~5점·2,000자·100KB·원자적 쓰기 |
| `test_excessive_text_length_rejection` | 유지 | 단위 domain: 1~5점·2,000자·100KB·원자적 쓰기 |
| `test_start_cycle_rejection_without_options` | 유지 | 통합 parity + 단위 domain: 날짜·문항·선택지·매칭·상태·마감 검증 |
| `test_start_cycle_rejection_past_end_at` | 유지 | 통합 parity + 단위 domain: 날짜·문항·선택지·매칭·상태·마감 검증 |
| `test_draft_oversized_payload_rejection` | 유지 | 단위 domain: 1~5점·2,000자·100KB·원자적 쓰기 |
| `test_deterministic_text_answer_sorting` | 유지 | 단위 domain + 통합 parity: 익명 DTO, 집계값, 결정적 정렬 |
| `test_invalid_html_template_syntax_rejection` | 유지·의도적 제한 | 단위 domain + test:pdf: 제한된 업로드 문법, TS 출력; 임의 템플릿 배치는 관리자 검수 |
| `test_cli_publish_only_approved_reports` | 유지·TS 전환 | 통합 parity: TS 운영 명령은 미승인 결과지 발송 금지 |
| `test_filter_response_quality_extended` | 유지 | 단위 domain + 통합 parity: 품질 필터, 원본 이름 보존, CSV 검증 로그 |

의도적 변경: Django DB·세션·암호 호환 제외, Nunjucks 업로드 문법 제한, TS Chromium PDF, 발송 UNKNOWN 수동 확인, 동일 생성물 재생성 이력 보존, 긴 피드백 이어지는 페이지 분할.
운영 환경의 실제 Slack·Docker·최신 Figma 시각 대조는 이 표의 로컬 통과에 포함되지 않습니다.
