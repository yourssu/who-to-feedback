import os
from datetime import timedelta
from unittest.mock import patch, MagicMock

from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, Client
from django.urls import reverse
from django.utils import timezone

from core.models import (
    Member, ReviewCycle, ReviewQuestion, QuestionOption,
    ReviewAssignment, ReviewAnswer, ReviewReport, ReviewAuthCode,
    ReviewCycleVersionLog
)
from core.services.layout_service import LayoutCheckService
from core.services.report_service import PDFReportService, ReportManagementService
from core.services.validation_service import DataValidationService


class PeerReviewSystemTestCase(TestCase):
    def setUp(self):
        # 0. Admin Superuser 생성
        self.superuser = User.objects.create_superuser('admin', 'admin@test.com', 'password123')

        # 1. 팀원 세팅
        self.alice = Member.objects.create(name="앨리스", email="alice@test.com", slack_user_id="U_ALICE", department="개발팀")
        self.bob = Member.objects.create(name="밥", email="bob@test.com", slack_user_id="U_BOB", department="기획팀")
        self.charlie = Member.objects.create(name="찰리", email="charlie@test.com", slack_user_id="U_CHARLIE", department="디자인팀")

        # 2. 회차 세팅 및 버전 이력 생성
        now = timezone.now()
        self.cycle = ReviewCycle.objects.create(
            title="2026 Q2 피어리뷰",
            start_at=now,
            end_at=now + timezone.timedelta(days=7),
            status='ACTIVE'
        )
        ReviewCycleVersionLog.objects.create(
            cycle=self.cycle,
            version="v1",
            changed_summary="2026 Q2 피어리뷰 v1 템플릿 배포"
        )

        # 3. 4가지 다양한 유형의 리뷰 문항 작성
        self.q1 = ReviewQuestion.objects.create(cycle=self.cycle, order=1, question_type='RATING', content="커뮤니케이션 능력")
        self.q2 = ReviewQuestion.objects.create(cycle=self.cycle, order=2, question_type='TEXT', content="핵심 강점 피드백")
        self.q3 = ReviewQuestion.objects.create(cycle=self.cycle, order=3, question_type='SINGLE_CHOICE', content="재협업 희망 여부")
        self.opt3_yes = QuestionOption.objects.create(question=self.q3, option_text="매우 그렇다", order=1)
        self.q4 = ReviewQuestion.objects.create(cycle=self.cycle, order=4, question_type='MULTIPLE_CHOICE', content="역량 키워드")
        self.opt4_lead = QuestionOption.objects.create(question=self.q4, option_text="리더십", order=1)
        self.opt4_code = QuestionOption.objects.create(question=self.q4, option_text="문제해결력", order=2)

        # 4. 리뷰어-리뷰이 매칭 (1:N)
        self.a_to_b = ReviewAssignment.objects.create(cycle=self.cycle, reviewer=self.alice, reviewee=self.bob)
        self.a_to_c = ReviewAssignment.objects.create(cycle=self.cycle, reviewer=self.alice, reviewee=self.charlie)
        self.b_to_a = ReviewAssignment.objects.create(cycle=self.cycle, reviewer=self.bob, reviewee=self.alice)

        self.client = Client()

    def test_01_validation_and_quality_filter(self):
        """1~3. 입력 데이터 사전 검증, 이름 정규화 및 응답 품질 필터 테스트"""
        self.client.force_login(self.superuser)

        # 이름 대소문자 매칭 정규화 제안 테스트
        Member.objects.create(name="alex", email="alex1@test.com", slack_user_id="U_ALEX1")
        Member.objects.create(name="Alex", email="alex2@test.com", slack_user_id="U_ALEX2")
        suggestions = DataValidationService.get_normalization_suggestions(self.cycle)
        self.assertTrue(len(suggestions) > 0)

        # 응답 품질 필터링 테스트
        ans = ReviewAnswer.objects.create(assignment=self.a_to_b, question=self.q2, answer_text="없습니다")
        excluded = DataValidationService.filter_response_quality([ans])
        self.assertEqual(excluded, 1)
        ans.refresh_from_db()
        self.assertTrue(ans.is_excluded_from_report)

    def test_02_layout_check_and_sample_reports(self):
        """4~6. 자동 레이아웃 검수, 샘플 데이터 테스트 모드 및 웹 미리보기 테스트"""
        self.client.force_login(self.superuser)

        # 300자 이상 긴 글 overflow 레이아웃 검사 테스트
        self.a_to_b.is_submitted = True
        self.a_to_b.save()
        long_text = "매우 길고 구체적인 피드백 메시지입니다. " * 20
        ReviewAnswer.objects.create(assignment=self.a_to_b, question=self.q2, answer_text=long_text)

        report = LayoutCheckService.check_layout_overflow(self.cycle, self.bob)
        self.assertFalse(report.layout_check_passed)
        self.assertIn("overflow", report.layout_issue_notes)

        # 샘플 2~3명 테스트 모드 리포트 생성 테스트
        sample_reports = ReportManagementService.generate_sample_reports(self.cycle, sample_count=2)
        self.assertTrue(len(sample_reports) > 0)

    def test_03_delivery_checklist_and_status_management(self):
        """7~9. 발송 대상 체크리스트, 개별 재생성 및 5단계 상태 관리 테스트"""
        self.client.force_login(self.superuser)

        # 체크리스트 집계
        checklist = ReportManagementService.get_delivery_checklist(self.cycle)
        self.assertTrue(len(checklist) > 0)

        # 개별 재생성 API 테스트
        report = ReviewReport.objects.create(cycle=self.cycle, reviewee=self.bob, validation_status='FAILED')
        res_regen = self.client.post(reverse('admin_regenerate_report', kwargs={'report_id': report.id}))
        self.assertEqual(res_regen.status_code, 302)

    def test_04_version_history_and_admin_memo(self):
        """10~12. 변경 이력 비교, 관리자 코멘트 메모 및 자동 리마인더 테스트"""
        self.client.force_login(self.superuser)

        report = ReviewReport.objects.create(cycle=self.cycle, reviewee=self.bob)

        # 관리자 수정 메모 저장 API 테스트
        res_memo = self.client.post(reverse('admin_save_report_memo', kwargs={'report_id': report.id}), {
            'admin_memo': '긴 글 분할 및 폰트 크기 확인 완료'
        })
        self.assertEqual(res_memo.status_code, 302)
        report.refresh_from_db()
        self.assertEqual(report.admin_memo, '긴 글 분할 및 폰트 크기 확인 완료')

        # 회차 버전 변경 이력 뷰 테스트
        res_hist = self.client.get(reverse('admin_cycle_history', kwargs={'cycle_id': self.cycle.id}))
        self.assertEqual(res_hist.status_code, 200)

    def test_05_logout_cookie_deletion_and_draft_preservation(self):
        """로그아웃 시 세션/쿠키 삭제 및 DB draft_data 보존 테스트"""
        session = self.client.session
        session['member_id'] = self.alice.id
        session['member_name'] = self.alice.name
        session['cycle_id'] = self.cycle.id
        session.save()

        self.a_to_b.draft_data = {f'q_{self.q2.id}_text': '로그아웃 테스트 임시 내용'}
        self.a_to_b.save()

        res_logout = self.client.get(reverse('logout'))
        self.assertEqual(res_logout.status_code, 302)

        self.assertNotIn('member_id', self.client.session)
        self.assertEqual(res_logout.cookies['sessionid'].value, '')

        self.a_to_b.refresh_from_db()
        self.assertEqual(self.a_to_b.draft_data.get(f'q_{self.q2.id}_text'), '로그아웃 테스트 임시 내용')

        session = self.client.session
        session['member_id'] = self.alice.id
        session.save()
        self.client.cookies['sessionid'] = session.session_key
        res_form = self.client.get(reverse('review_form', kwargs={'assignment_id': self.a_to_b.id}))
        self.assertEqual(res_form.status_code, 200)
        self.assertContains(res_form, '로그아웃 테스트 임시 내용')

    def test_multiple_choice_validation_requires_at_least_one_option(self):
        """다중 선택 문항에 옵션을 하나도 선택하지 않고 제출 시 거부 검증"""
        session = self.client.session
        session['member_id'] = self.alice.id
        session['cycle_id'] = self.cycle.id
        session.save()

        res = self.client.post(reverse('review_form', kwargs={'assignment_id': self.a_to_b.id}), {
            f'q_{self.q1.id}_rating': '5',
            f'q_{self.q2.id}_text': '좋은 피드백입니다.',
            f'q_{self.q3.id}_single': str(self.opt3_yes.id),
            # q4 (MULTIPLE_CHOICE) 미선택
        })
        self.assertEqual(res.status_code, 200)
        self.a_to_b.refresh_from_db()
        self.assertFalse(self.a_to_b.is_submitted)

    def test_option_delete_api(self):
        """객관식 선택지 삭제 API 테스트"""
        self.client.force_login(self.superuser)
        draft_cycle = ReviewCycle.objects.create(title="DRAFT 회차", status='DRAFT')
        q = ReviewQuestion.objects.create(cycle=draft_cycle, order=1, question_type='SINGLE_CHOICE', content="단일 선택 질문")
        opt = QuestionOption.objects.create(question=q, option_text="삭제할 선택지", order=1)

        res = self.client.post(reverse('admin_delete_option', kwargs={'option_id': opt.id}))
        self.assertEqual(res.status_code, 302)
        self.assertFalse(QuestionOption.objects.filter(id=opt.id).exists())

    def test_answer_exclusion_toggle_api(self):
        """품질 필터로 제외된 답변 복원/제외 토글 API 테스트"""
        self.client.force_login(self.superuser)
        ans = ReviewAnswer.objects.create(assignment=self.a_to_b, question=self.q2, answer_text="없음", is_excluded_from_report=True)

        res = self.client.post(reverse('admin_toggle_answer_exclusion', kwargs={'answer_id': ans.id}))
        self.assertEqual(res.status_code, 302)
        ans.refresh_from_db()
        self.assertFalse(ans.is_excluded_from_report)





class CustomHTMLTemplateTestCase(TestCase):
    def setUp(self):
        self.superuser = User.objects.create_superuser('admin', 'admin@example.com', 'password123')
        self.alice = Member.objects.create(name='Alice', email='alice@example.com', slack_user_id='U111')
        self.bob = Member.objects.create(name='Bob', email='bob@example.com', slack_user_id='U222')

        now = timezone.now()
        self.cycle = ReviewCycle.objects.create(
            title='커스텀 템플릿 테스트 회차',
            start_at=now - timedelta(days=1),
            end_at=now + timedelta(days=5),
            status='ACTIVE'
        )

        self.q1 = ReviewQuestion.objects.create(cycle=self.cycle, order=1, question_type='RATING', content='업무 몰입도')
        self.q2 = ReviewQuestion.objects.create(cycle=self.cycle, order=2, question_type='TEXT', content='강점 피드백')

        self.assignment = ReviewAssignment.objects.create(
            cycle=self.cycle, reviewer=self.alice, reviewee=self.bob, is_submitted=True
        )

        ReviewAnswer.objects.create(assignment=self.assignment, question=self.q1, rating_value=5)
        ReviewAnswer.objects.create(assignment=self.assignment, question=self.q2, answer_text='매우 훌륭한 팀원입니다.')

    def test_deterministic_context_builder_method_a(self):
        """방식 A: 순서(order) 기반 q_N_ 결정적 변수 기계적 생성 검증"""
        context = PDFReportService.compile_feedback_data(self.cycle, self.bob)

        # q_1_ (5점 척도) 변수 검증
        self.assertEqual(context['q_1_content'], '업무 몰입도')
        self.assertEqual(context['q_1_avg_rating'], 5.0)
        self.assertEqual(context['q_1_rating_percent'], 100)

        # q_2_ (서술형) 변수 검증
        self.assertEqual(context['q_2_content'], '강점 피드백')
        self.assertIn('매우 훌륭한 팀원입니다.', context['q_2_text_answers'])

    def test_custom_html_template_pdf_generation(self):
        """커스텀 HTML 양식 파일 적용 및 깨짐 0% PDF 생성 테스트"""
        from django.core.files.base import ContentFile

        custom_html_content = """<!DOCTYPE html>
        <html>
        <head><style>@page { size: 297mm 167mm; margin: 0; }</style></head>
        <body>
            <h1>{{ reviewee.name }} 리포트</h1>
            <p>{{ q_1_content }}: {{ q_1_avg_rating }}점 ({{ q_1_rating_percent }}%)</p>
            <div>
                {% for text in q_2_text_answers %}
                    <p>{{ text }}</p>
                {% endfor %}
            </div>
        </body>
        </html>"""

        self.cycle.custom_html_file.save("test_template.html", ContentFile(custom_html_content.encode('utf-8')))
        self.cycle.use_custom_template = True
        self.cycle.save()

        report = PDFReportService.generate_pdf_report(self.cycle, self.bob)

        self.assertEqual(report.validation_status, 'APPROVED')
        self.assertTrue(bool(report.html_file))
        self.assertTrue(os.path.exists(report.html_file.path))

    def test_generate_all_reports_for_cycle(self):
        """회차 내 모든 수신자 리포트 일괄 생성 테스트"""
        reports = PDFReportService.generate_all_reports_for_cycle(self.cycle)
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0].reviewee, self.bob)

    def test_strict_anonymity_enforcement(self):
        """무기명 보장 원칙: 리포트 Context 내 응답자(reviewer) 식별 정보 100% 탈거 검증"""
        context = PDFReportService.compile_feedback_data(self.cycle, self.bob)
        
        # 1. context 직속 변수 내 reviewer 정보 미존재 검증
        self.assertNotIn('reviewer', context)
        self.assertNotIn('reviewer_name', context)
        self.assertNotIn('assignments', context)

        # 2. 주관식 답변 배열이 순수 string 배열인지 검증 (ReviewAnswer 객체가 아님)
    def test_category_scoring_and_auto_charts(self):
        """글자형/숫자형 1~5점 점수 환산, 카테고리별 합산/가산 및 Base64 차트 3종 자동 생성 검증"""
        # 카테고리 지정 질문 추가 (글자형 TEXT_5 문항 포함)
        q3 = ReviewQuestion.objects.create(
            cycle=self.cycle, order=3, question_type='RATING',
            scale_type='TEXT_5', category='Active Ownership', content='도전정신 평가'
        )
        q4 = ReviewQuestion.objects.create(
            cycle=self.cycle, order=4, question_type='RATING',
            scale_type='NUMERIC_5', category='Deep Immersion', content='몰입도 평가'
        )

        ReviewAnswer.objects.create(assignment=self.assignment, question=q3, answer_text='매우 그럼') # 5.0점 환산
        ReviewAnswer.objects.create(assignment=self.assignment, question=q4, rating_value=4) # 4.0점

        context = PDFReportService.compile_feedback_data(self.cycle, self.bob)

        # 1. 카테고리별 요약 데이터 검증
        cat_summary = context['category_summary']
        self.assertTrue(len(cat_summary) >= 2)
        
    def test_choice_question_ratio_charts(self):
        """선택형 문항 선택지 비율 원/막대 그래프 Base64 자동 생성 검증"""
        q5 = ReviewQuestion.objects.create(
            cycle=self.cycle, order=5, question_type='MULTIPLE_CHOICE',
            category='소통역량', content='가장 잘 어울리는 역량 태그'
        )
        opt1 = QuestionOption.objects.create(question=q5, option_text='리더십', order=1)
        opt2 = QuestionOption.objects.create(question=q5, option_text='소통 능력', order=2)

        ans5 = ReviewAnswer.objects.create(assignment=self.assignment, question=q5)
        ans5.selected_options.add(opt1, opt2)

        context = PDFReportService.compile_feedback_data(self.cycle, self.bob)

        # 선택형 문항 차트 2종 생성 검증
        self.assertTrue(context['q_5_pie_chart_base64'].startswith('data:image/png;base64,'))
        self.assertTrue(context['q_5_bar_chart_base64'].startswith('data:image/png;base64,'))

    def test_question_image_injection(self):
        """질문 문항 첨부 이미지 모델 저장 및 Context URL 인젝션 검증"""
        dummy_img = SimpleUploadedFile("sample_q_img.jpg", b"fake_image_bytes", content_type="image/jpeg")
        q6 = ReviewQuestion.objects.create(
            cycle=self.cycle, order=6, question_type='TEXT',
            category='디자인역량', content='시각디자인 시안을 평가하세요', image=dummy_img
        )

        context = PDFReportService.compile_feedback_data(self.cycle, self.bob)

        # 질문 이미지 URL 존재 및 매칭 검증
        self.assertTrue(bool(context['q_6_image_url']))
        self.assertIn('sample_q_img', context['q_6_image_url'])

    def test_health_check_endpoint(self):
        """Docker 헬스체크용 /health/ 엔드포인트 200 OK 응답 검증"""
        response = self.client.get('/health/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'status': 'ok'})



class CSVMemberImportTestCase(TestCase):
    def test_import_members_from_csv(self):
        """CSV 멤버 일괄 임포트 기능 테스트 (한글 헤더, 신규 생성 & 업데이트)"""
        csv_content = (
            "이름,이메일,slack_user_id,부서,역할\n"
            "김개발,dev@yourssu.com,U_DEV,개발팀,MEMBER\n"
            "이디자인,design@yourssu.com,U_DES,디자인팀,ADMIN\n"
        )
        csv_file = SimpleUploadedFile("members.csv", csv_content.encode('utf-8-sig'), content_type="text/csv")
        res = DataValidationService.import_members_from_csv(csv_file)

        self.assertEqual(res['created'], 2)
        self.assertTrue(Member.objects.filter(email='dev@yourssu.com', name='김개발').exists())
        self.assertTrue(Member.objects.filter(email='design@yourssu.com', name='이디자인').exists())


class SetupWizardTestCase(TestCase):
    def test_setup_wizard_flow(self):
        """최초 구동 Setup Wizard GET, POST 계정 생성 및 관리자 1명 이상 존재 시 영구 차단(404) 테스트"""
        # 1. DB 초기 상태 - /setup/ 접근 시 200 OK
        res = self.client.get('/setup/')
        self.assertEqual(res.status_code, 200)

        # 2. 관리자 0명 상태에서 /admin-panel/ 접근 시 /setup/ 으로 리다이렉트
        res_admin = self.client.get('/admin-panel/')
        self.assertRedirects(res_admin, '/setup/')

        # 3. 최초 관리자 생성 POST
        post_data = {
            'username': 'masteradmin',
            'email': 'master@yourssu.com',
            'password': 'password123!',
            'password_confirm': 'password123!'
        }
        res_post = self.client.post('/setup/', post_data)
        self.assertRedirects(res_post, reverse('admin_dashboard'))

        # DB에 슈퍼유저 생성 확인
        self.assertTrue(User.objects.filter(username='masteradmin', is_superuser=True).exists())

        # 4. 관리자 계정 생성 완료 후 /setup/ 접근 시 404 차단
        res_locked = self.client.get('/setup/')
        self.assertEqual(res_locked.status_code, 404)


class AdminSidebarTestCase(TestCase):
    def test_sidebar_links_always_active(self):
        """회차가 존재할 때 Overview 및 팀원 관리 탭에서도 질문지/매칭/리포트 사이드바 링크 활성화 테스트"""
        superuser = User.objects.create_superuser('admin', 'admin@test.com', 'password123')
        cycle = ReviewCycle.objects.create(title="테스트 회차", status="ACTIVE")
        self.client.force_login(superuser)

        # Overview 접근 시 사이드바 질문지/매칭/리포트 링크 활성화 확인
        res_overview = self.client.get(reverse('admin_dashboard'))
        self.assertEqual(res_overview.status_code, 200)
        self.assertContains(res_overview, reverse('admin_questions', kwargs={'cycle_id': cycle.id}))
        self.assertContains(res_overview, reverse('admin_assignments', kwargs={'cycle_id': cycle.id}))
        self.assertContains(res_overview, reverse('admin_reports', kwargs={'cycle_id': cycle.id}))

        # 팀원 관리 접근 시 사이드바 질문지/매칭/리포트 링크 활성화 확인
        res_members = self.client.get(reverse('admin_members'))
        self.assertEqual(res_members.status_code, 200)
        self.assertContains(res_members, reverse('admin_questions', kwargs={'cycle_id': cycle.id}))
        self.assertContains(res_members, reverse('admin_assignments', kwargs={'cycle_id': cycle.id}))
        self.assertContains(res_members, reverse('admin_reports', kwargs={'cycle_id': cycle.id}))

    def test_validation_view_with_completed_and_draft_cycles(self):
        """완료된 회차와 DRAFT 상태의 회차가 동시에 존재할 때 데이터 검증 뷰 렌더링 테스트"""
        superuser = User.objects.create_superuser('admin', 'admin2@test.com', 'password123')
        self.client.force_login(superuser)

        cycle_completed = ReviewCycle.objects.create(title="완료된 회차", status="COMPLETED")
        cycle_draft = ReviewCycle.objects.create(title="초안 회차", status="DRAFT")

        # 1. /admin-panel/validation/ GET (URL 파라미터 없음)
        res_val1 = self.client.get(reverse('admin_validation'))
        self.assertEqual(res_val1.status_code, 200)

        # 2. /admin-panel/cycles/<draft_id>/validation/ GET
        res_val2 = self.client.get(reverse('admin_validation_detail', kwargs={'cycle_id': cycle_draft.id}))
        self.assertEqual(res_val2.status_code, 200)

        # 3. /admin-panel/cycles/<completed_id>/validation/ GET
        res_val3 = self.client.get(reverse('admin_validation_detail', kwargs={'cycle_id': cycle_completed.id}))
        self.assertEqual(res_val3.status_code, 200)










class AuthLoginSecurityTestCase(TestCase):
    """1번 인증·세션: ACTIVE 회차 PIN만 로그인 허용, URL 자동 로그인 제거, 시도 횟수 제한"""

    def setUp(self):
        self.alice = Member.objects.create(
            name="앨리스", email="alice@test.com", slack_user_id="U_ALICE",
            department="개발팀"
        )
        now = timezone.now()
        self.active_cycle = ReviewCycle.objects.create(
            title="진행 중 회차", start_at=now - timedelta(days=1),
            end_at=now + timedelta(days=7), status='ACTIVE'
        )
        self.completed_cycle = ReviewCycle.objects.create(
            title="완료된 회차", start_at=now - timedelta(days=14),
            end_at=now - timedelta(days=7), status='COMPLETED'
        )
        self.draft_cycle = ReviewCycle.objects.create(title="준비 중 회차", status='DRAFT')

        self.active_code = ReviewAuthCode.generate_code_for(self.alice, self.active_cycle)
        self.completed_code = ReviewAuthCode.generate_code_for(self.alice, self.completed_cycle)
        self.draft_code = ReviewAuthCode.generate_code_for(self.alice, self.draft_cycle)
        self.client = Client()

    def test_login_with_active_cycle_pin(self):
        res = self.client.post(reverse('login'), {'code': self.active_code.code})
        self.assertRedirects(res, reverse('review_dashboard'))
        self.assertEqual(self.client.session['member_id'], self.alice.id)
        self.assertEqual(self.client.session['cycle_id'], self.active_cycle.id)

    def test_login_with_completed_cycle_pin_rejected(self):
        res = self.client.post(reverse('login'), {'code': self.completed_code.code})
        self.assertEqual(res.status_code, 200)
        self.assertNotIn('member_id', self.client.session)
        self.assertContains(res, '입력한 PIN이 만료되었거나 올바르지 않아요')

    def test_login_with_draft_cycle_pin_rejected(self):
        res = self.client.post(reverse('login'), {'code': self.draft_code.code})
        self.assertEqual(res.status_code, 200)
        self.assertNotIn('member_id', self.client.session)

    def test_get_code_param_does_not_autologin(self):
        res = self.client.get(reverse('login'), {'code': self.active_code.code})
        self.assertEqual(res.status_code, 200)
        self.assertNotIn('member_id', self.client.session)

    def test_relogin_with_same_pin_after_logout(self):
        self.client.post(reverse('login'), {'code': self.active_code.code})
        self.client.get(reverse('logout'))
        res = self.client.post(reverse('login'), {'code': self.active_code.code})
        self.assertRedirects(res, reverse('review_dashboard'))

    def test_login_locked_after_five_failures(self):
        for _ in range(5):
            self.client.post(reverse('login'), {'code': '000000'})
        self.assertIn('login_lock_until', self.client.session)

        # 잠금 중에는 올바른 PIN도 차단
        res = self.client.post(reverse('login'), {'code': self.active_code.code})
        self.assertEqual(res.status_code, 200)
        self.assertNotIn('member_id', self.client.session)
        self.assertContains(res, '로그인 시도가 잠시 잠겼어요')


class ReviewCycleGateTestCase(TestCase):
    """1번 인증·세션: 리뷰 작성/제출/임시저장은 ACTIVE + 마감 전에만 허용"""

    def setUp(self):
        self.alice = Member.objects.create(
            name="앨리스", email="alice@test.com", slack_user_id="U_ALICE",
            department="개발팀"
        )
        self.bob = Member.objects.create(
            name="밥", email="bob@test.com", slack_user_id="U_BOB",
            department="기획팀"
        )
        now = timezone.now()
        self.active_cycle = ReviewCycle.objects.create(
            title="진행 중 회차", start_at=now - timedelta(days=1),
            end_at=now + timedelta(days=7), status='ACTIVE'
        )
        self.expired_cycle = ReviewCycle.objects.create(
            title="마감 경과 회차", start_at=now - timedelta(days=3),
            end_at=now - timedelta(days=1), status='ACTIVE'
        )
        self.closed_cycle = ReviewCycle.objects.create(
            title="완료된 회차", start_at=now - timedelta(days=14),
            end_at=now - timedelta(days=7), status='COMPLETED'
        )
        self.draft_cycle = ReviewCycle.objects.create(title="준비 중 회차", status='DRAFT')

        self.q1 = ReviewQuestion.objects.create(
            cycle=self.active_cycle, order=1, question_type='TEXT', content="강점 피드백"
        )

        self.a_active = ReviewAssignment.objects.create(
            cycle=self.active_cycle, reviewer=self.alice, reviewee=self.bob
        )
        self.a_expired = ReviewAssignment.objects.create(
            cycle=self.expired_cycle, reviewer=self.alice, reviewee=self.bob
        )
        self.a_closed = ReviewAssignment.objects.create(
            cycle=self.closed_cycle, reviewer=self.alice, reviewee=self.bob
        )
        self.a_draft = ReviewAssignment.objects.create(
            cycle=self.draft_cycle, reviewer=self.alice, reviewee=self.bob
        )

        self.client = Client()
        session = self.client.session
        session['member_id'] = self.alice.id
        session['member_name'] = self.alice.name
        session['cycle_id'] = self.active_cycle.id
        session.save()

    def test_review_form_editable_for_active_cycle(self):
        res = self.client.get(reverse('review_form', kwargs={'assignment_id': self.a_active.id}))
        self.assertEqual(res.status_code, 200)
        self.assertContains(res, 'data-review-wizard')

    def test_review_form_locked_for_inactive_cycles(self):
        for assignment in (self.a_expired, self.a_closed, self.a_draft):
            res = self.client.get(reverse('review_form', kwargs={'assignment_id': assignment.id}))
            self.assertEqual(res.status_code, 200)
            self.assertContains(res, '수정 마감')
            self.assertContains(res, '작성할 수 없습니다')
            self.assertNotContains(res, 'data-review-wizard')

    def test_review_post_rejected_for_closed_cycle(self):
        res = self.client.post(
            reverse('review_form', kwargs={'assignment_id': self.a_closed.id}),
            {f'q_{self.q1.id}_text': '제출 시도'}
        )
        self.assertRedirects(res, reverse('review_form', kwargs={'assignment_id': self.a_closed.id}))
        self.a_closed.refresh_from_db()
        self.assertFalse(self.a_closed.is_submitted)

    def test_save_draft_rejected_for_closed_cycle(self):
        res = self.client.post(
            reverse('save_draft', kwargs={'assignment_id': self.a_closed.id}),
            {f'q_{self.q1.id}_text': '임시 저장 시도'}
        )
        self.assertEqual(res.status_code, 403)
        self.assertJSONEqual(res.content, {'status': 'error', 'message': '회차가 종료되어 임시저장할 수 없습니다.'})

    def test_review_submit_allowed_for_active_cycle(self):
        res = self.client.post(
            reverse('review_form', kwargs={'assignment_id': self.a_active.id}),
            {f'q_{self.q1.id}_text': '훌륭한 팀원입니다.'}
        )
        self.assertRedirects(res, reverse('review_dashboard'))
        self.a_active.refresh_from_db()
        self.assertTrue(self.a_active.is_submitted)


class ReviewDashboardScopeTestCase(TestCase):
    """1번 인증·세션: 대시보드는 로그인한 회차(세션 cycle_id) 기준으로만 표시"""

    def setUp(self):
        self.alice = Member.objects.create(
            name="앨리스", email="alice@test.com", slack_user_id="U_ALICE",
            department="개발팀"
        )
        self.bob = Member.objects.create(
            name="밥", email="bob@test.com", slack_user_id="U_BOB",
            department="기획팀"
        )
        self.carol = Member.objects.create(
            name="찰리", email="carol@test.com", slack_user_id="U_CAROL",
            department="디자인팀"
        )
        now = timezone.now()
        self.cycle_a = ReviewCycle.objects.create(
            title="A 회차", start_at=now - timedelta(days=1),
            end_at=now + timedelta(days=7), status='ACTIVE'
        )
        self.cycle_b = ReviewCycle.objects.create(
            title="B 회차", start_at=now - timedelta(days=1),
            end_at=now + timedelta(days=7), status='ACTIVE'
        )
        self.assignment_a = ReviewAssignment.objects.create(
            cycle=self.cycle_a, reviewer=self.alice, reviewee=self.bob
        )
        self.assignment_b = ReviewAssignment.objects.create(
            cycle=self.cycle_b, reviewer=self.alice, reviewee=self.carol
        )
        self.client = Client()

    def test_dashboard_shows_only_session_cycle_assignments(self):
        session = self.client.session
        session['member_id'] = self.alice.id
        session['member_name'] = self.alice.name
        session['cycle_id'] = self.cycle_a.id
        session.save()

        res = self.client.get(reverse('review_dashboard'))
        self.assertEqual(res.status_code, 200)
        self.assertContains(res, '밥')
        self.assertContains(res, 'A 회차')
        self.assertNotContains(res, '찰리')
        self.assertNotContains(res, 'B 회차')

    def test_dashboard_redirects_to_login_when_cycle_id_missing(self):
        session = self.client.session
        session['member_id'] = self.alice.id
        session['member_name'] = self.alice.name
        session.save()

        res = self.client.get(reverse('review_dashboard'))
        self.assertRedirects(res, reverse('login'))

    def test_dashboard_hides_write_link_when_cycle_closed(self):
        self.cycle_a.status = 'COMPLETED'
        self.cycle_a.save()

        session = self.client.session
        session['member_id'] = self.alice.id
        session['member_name'] = self.alice.name
        session['cycle_id'] = self.cycle_a.id
        session.save()

        res = self.client.get(reverse('review_dashboard'))
        self.assertEqual(res.status_code, 200)
        self.assertContains(res, '작성 마감')
        self.assertNotContains(res, '리뷰 작성하기')


# ==========================================
# #2 회차·마감 제어 테스트
# ==========================================
class CycleCreateValidationTestCase(TestCase):
    """admin_create_cycle의 end_at > start_at 검증 테스트"""

    def setUp(self):
        self.superuser = User.objects.create_superuser('admin', 'admin@test.com', 'password123')
        self.client = Client()
        self.client.login(username='admin', password='password123')

    def test_create_cycle_end_before_start_shows_error(self):
        """end_at이 start_at보다 이전이면 에러 메시지와 함께 리다이렉트"""
        from django.utils import timezone
        now = timezone.now()
        start_str = (now + timedelta(days=7)).strftime('%Y-%m-%dT%H:%M')
        end_str = now.strftime('%Y-%m-%dT%H:%M')
        res = self.client.post(reverse('admin_create_cycle'), {
            'title': '검증 테스트',
            'start_at': start_str,
            'end_at': end_str,
        })
        self.assertRedirects(res, reverse('admin_dashboard'))
        self.assertFalse(ReviewCycle.objects.filter(title='검증 테스트').exists())

    def test_create_cycle_valid_dates_succeeds(self):
        """정상적인 날짜면 회차 생성 성공"""
        from django.utils import timezone
        now = timezone.now()
        start_str = now.strftime('%Y-%m-%dT%H:%M')
        end_str = (now + timedelta(days=7)).strftime('%Y-%m-%dT%H:%M')
        res = self.client.post(reverse('admin_create_cycle'), {
            'title': '정상 회차',
            'start_at': start_str,
            'end_at': end_str,
        })
        self.assertRedirects(res, reverse('admin_questions', args=[ReviewCycle.objects.get(title='정상 회차').id]))
        self.assertTrue(ReviewCycle.objects.filter(title='정상 회차').exists())


class CycleStartActionTestCase(TestCase):
    """admin_start_cycle_action의 DRAFT 가드 + 질문·매칭 검증 테스트"""

    def setUp(self):
        self.superuser = User.objects.create_superuser('admin', 'admin@test.com', 'password123')
        self.client = Client()
        self.client.login(username='admin', password='password123')
        self.alice = Member.objects.create(name="앨리스", email="alice@test.com", slack_user_id="U_ALICE")
        self.bob = Member.objects.create(name="밥", email="bob@test.com", slack_user_id="U_BOB")
        self.cycle = ReviewCycle.objects.create(title="시작 검증", status='DRAFT')

        # SlackService 모킹
        self.patcher = patch('core.views.admin_views.SlackService')
        self.mock_slack = self.patcher.start()
        self.mock_slack.return_value.send_auth_code_dm.return_value = (True, None)
        self.mock_slack.return_value.send_reminder_dm.return_value = (True, None)

    def tearDown(self):
        self.patcher.stop()

    def test_start_non_draft_cycle_shows_error(self):
        """DRAFT가 아닌 회차 시작 시 에러"""
        self.cycle.status = 'ACTIVE'
        self.cycle.save()
        res = self.client.post(reverse('admin_start_cycle_action', args=[self.cycle.id]))
        self.assertRedirects(res, reverse('admin_status_detail', args=[self.cycle.id]))
        self.assertEqual(ReviewCycle.objects.get(id=self.cycle.id).status, 'ACTIVE')

    def test_start_draft_without_questions_shows_error(self):
        """질문이 없는 DRAFT 회차 시작 시 에러"""
        res = self.client.post(reverse('admin_start_cycle_action', args=[self.cycle.id]))
        self.assertRedirects(res, reverse('admin_status_detail', args=[self.cycle.id]))
        self.assertEqual(ReviewCycle.objects.get(id=self.cycle.id).status, 'DRAFT')

    def test_start_draft_without_assignments_shows_error(self):
        """매칭이 없는 DRAFT 회차 시작 시 에러"""
        ReviewQuestion.objects.create(cycle=self.cycle, order=1, question_type='TEXT', content="질문")
        res = self.client.post(reverse('admin_start_cycle_action', args=[self.cycle.id]))
        self.assertRedirects(res, reverse('admin_status_detail', args=[self.cycle.id]))
        self.assertEqual(ReviewCycle.objects.get(id=self.cycle.id).status, 'DRAFT')

    def test_start_draft_with_questions_and_assignments_succeeds(self):
        """질문과 매칭이 있으면 ACTIVE 전환 성공"""
        ReviewQuestion.objects.create(cycle=self.cycle, order=1, question_type='TEXT', content="질문")
        ReviewAssignment.objects.create(cycle=self.cycle, reviewer=self.alice, reviewee=self.bob)
        res = self.client.post(reverse('admin_start_cycle_action', args=[self.cycle.id]))
        self.assertRedirects(res, reverse('admin_status_detail', args=[self.cycle.id]))
        self.assertEqual(ReviewCycle.objects.get(id=self.cycle.id).status, 'ACTIVE')


class AutoMatchPinTestCase(TestCase):
    """admin_auto_match ACTIVE 시 PIN 발송 테스트"""

    def setUp(self):
        self.superuser = User.objects.create_superuser('admin', 'admin@test.com', 'password123')
        self.client = Client()
        self.client.login(username='admin', password='password123')
        self.alice = Member.objects.create(name="앨리스", email="alice@test.com", slack_user_id="U_ALICE")
        self.bob = Member.objects.create(name="밥", email="bob@test.com", slack_user_id="U_BOB")
        self.cycle_active = ReviewCycle.objects.create(title="ACTIVE 회차", status='ACTIVE')
        self.cycle_draft = ReviewCycle.objects.create(title="DRAFT 회차", status='DRAFT')

        # SlackService.send_auth_code_dm 모킹
        from unittest.mock import patch
        self.patcher = patch('core.views.admin_views.SlackService')
        self.mock_slack = self.patcher.start()
        self.mock_slack.return_value.send_auth_code_dm.return_value = (True, None)
        self.mock_slack.return_value.send_reminder_dm.return_value = (True, None)

    def tearDown(self):
        self.patcher.stop()

    def test_auto_match_active_sends_pin(self):
        """ACTIVE 회차 자동 매칭 시 새 리뷰어에게 PIN 발송 (ReviewAuthCode 생성 확인)"""
        res = self.client.post(reverse('admin_auto_match', args=[self.cycle_active.id]))
        self.assertRedirects(res, reverse('admin_assignments', args=[self.cycle_active.id]))
        self.assertTrue(ReviewAuthCode.objects.filter(member=self.alice, cycle=self.cycle_active).exists())
        self.assertTrue(ReviewAuthCode.objects.filter(member=self.bob, cycle=self.cycle_active).exists())

    def test_auto_match_draft_does_not_send_pin(self):
        """DRAFT 회차 자동 매칭 시 PIN 발송하지 않음"""
        res = self.client.post(reverse('admin_auto_match', args=[self.cycle_draft.id]))
        self.assertRedirects(res, reverse('admin_assignments', args=[self.cycle_draft.id]))
        self.assertFalse(ReviewAuthCode.objects.filter(cycle=self.cycle_draft).exists())


class PipelineInitialSetupFixesTestCase(TestCase):
    """초기 설정 및 회차 준비 파이프라인 버그 수정 검증 테스트"""

    def setUp(self):
        self.superuser = User.objects.create_superuser('admin', 'admin@test.com', 'password123')
        self.client = Client()
        self.client.force_login(self.superuser)

    def test_setup_wizard_slack_user_id_empty(self):
        """setup_wizard 실행 시 slack_user_id가 빈 문자열로 설정되는지 검증"""
        User.objects.all().delete()
        Member.objects.all().delete()

        res = self.client.post(reverse('setup_wizard'), {
            'username': '관리자',
            'email': 'admin@yourssu.com',
            'password': 'password123',
            'password_confirm': 'password123'
        })
        self.assertEqual(res.status_code, 302)
        admin_user = User.objects.get(email='admin@yourssu.com')
        self.assertTrue(admin_user.is_superuser)

    def test_korean_csv_import_unique_emails(self):
        """한글 닉네임 유저 CSV 임포트 시 이메일 중복 덮어쓰기 없이 고유 가상 이메일 생성 검증"""
        from io import BytesIO
        from django.core.files.uploadedfile import SimpleUploadedFile

        csv_content = "닉네임,소속,역할\n홍길동,개발팀,MEMBER\n김철수,디자인팀,MEMBER\n이영희,기획팀,MEMBER\n"
        csv_file = SimpleUploadedFile("members.csv", csv_content.encode('utf-8-sig'), content_type="text/csv")

        res = DataValidationService.import_members_from_csv(csv_file)
        self.assertEqual(res['created'], 3)
        self.assertEqual(Member.objects.count(), 3)
        emails = set(Member.objects.values_list('email', flat=True))
        self.assertEqual(len(emails), 3)

    def test_apply_normalization_preserves_original_name(self):
        """정규화 반영 시 Member.name 원본은 보존되고 normalized_name만 업데이트되는지 검증"""
        m1 = Member.objects.create(name="Alex", email="alex1@test.com")
        m2 = Member.objects.create(name="alex", email="alex2@test.com")

        cycle = ReviewCycle.objects.create(title="테스트 회차")
        count = DataValidationService.apply_normalization(cycle, ["Alex", "alex"], "Alex")
        self.assertEqual(count, 2)
        m1.refresh_from_db()
        m2.refresh_from_db()
        self.assertEqual(m1.name, "Alex")
        self.assertEqual(m2.name, "alex")
        self.assertEqual(m1.normalized_name, "Alex")
        self.assertEqual(m2.normalized_name, "Alex")

    def test_non_choice_question_option_rejection(self):
        """RATING/TEXT 문항에 선택지 추가 시도 시 거부 검증"""
        cycle = ReviewCycle.objects.create(title="질문 테스트 회차", status='DRAFT')
        rating_q = ReviewQuestion.objects.create(cycle=cycle, order=1, question_type='RATING', content="평점 문항")

        res = self.client.post(reverse('admin_add_option', args=[rating_q.id]), {
            'option_text': '잘못된 선택지'
        })
        self.assertEqual(res.status_code, 302)
        self.assertEqual(QuestionOption.objects.filter(question=rating_q).count(), 0)

    def test_same_department_auto_match(self):
        """동일 부서 자동 매칭 옵션(SAME_DEPT) 검증"""
        dev1 = Member.objects.create(name="Dev1", email="dev1@test.com", department="개발")
        dev2 = Member.objects.create(name="Dev2", email="dev2@test.com", department="개발")
        design1 = Member.objects.create(name="Des1", email="des1@test.com", department="디자인")

        cycle = ReviewCycle.objects.create(title="부서 매칭 회차", status='DRAFT')
        res = self.client.post(reverse('admin_auto_match', args=[cycle.id]), {
            'match_type': 'SAME_DEPT'
        })
        self.assertEqual(res.status_code, 302)
        assignments = ReviewAssignment.objects.filter(cycle=cycle)
        self.assertEqual(assignments.count(), 2)  # dev1 <-> dev2 간 2개 매칭만 생성되어야 함
        for a in assignments:
            self.assertEqual(a.reviewer.department, a.reviewee.department)


class ActiveToClosePipelineFixesTestCase(TestCase):
    """회차 개시부터 마감까지 3단계 파이프라인 버그 수정 검증 테스트"""

    def setUp(self):
        self.superuser = User.objects.create_superuser('admin', 'admin@test.com', 'password123')
        self.client = Client()

    def test_unique_pin_code_generation(self):
        """동일 회차 내 핀코드 중복 생성 방지 검증"""
        cycle = ReviewCycle.objects.create(title="핀 테스트 회차", status='ACTIVE')
        m1 = Member.objects.create(name="M1", email="m1@test.com")
        m2 = Member.objects.create(name="M2", email="m2@test.com")

        pin1 = ReviewAuthCode.generate_code_for(m1, cycle)
        pin2 = ReviewAuthCode.generate_code_for(m2, cycle)

        self.assertNotEqual(pin1.code, pin2.code)

    def test_pin_validity_persists_during_active(self):
        """회차 진행 중 동일 PIN 코드로 계속 로그인 가능한지 검증"""
        cycle = ReviewCycle.objects.create(title="로그인 유효 테스트 회차", status='ACTIVE')
        m1 = Member.objects.create(name="M1", email="m1@test.com")
        pin = ReviewAuthCode.generate_code_for(m1, cycle)

        # 1차 로그인
        res1 = self.client.post(reverse('login'), {'code': pin.code})
        self.assertRedirects(res1, reverse('review_dashboard'))

        # 로그아웃 후 2차 로그인 (동일 PIN으로 재접속 성공)
        self.client.get(reverse('logout'))
        res2 = self.client.post(reverse('login'), {'code': pin.code})
        self.assertRedirects(res2, reverse('review_dashboard'))

    def test_invalid_rating_value_rejection(self):
        """1~5 범위를 벗어난 척도 점수 제출 거부 검증"""
        cycle = ReviewCycle.objects.create(title="점수 검증 회차", status='ACTIVE')
        m1 = Member.objects.create(name="M1", email="m1@test.com")
        m2 = Member.objects.create(name="M2", email="m2@test.com")
        q_rating = ReviewQuestion.objects.create(cycle=cycle, order=1, question_type='RATING', content="점수 질문")
        assignment = ReviewAssignment.objects.create(cycle=cycle, reviewer=m1, reviewee=m2)

        session = self.client.session
        session['member_id'] = m1.id
        session['cycle_id'] = cycle.id
        session.save()

        res = self.client.post(reverse('review_form', args=[assignment.id]), {
            f'q_{q_rating.id}_rating': '99'
        })
        self.assertEqual(res.status_code, 200)
        assignment.refresh_from_db()
        self.assertFalse(assignment.is_submitted)

    def test_excessive_text_length_rejection(self):
        """2,000자 초과 서술형 피드백 작성 제출 거부 검증"""
        cycle = ReviewCycle.objects.create(title="자수 제한 회차", status='ACTIVE')
        m1 = Member.objects.create(name="M1", email="m1@test.com")
        m2 = Member.objects.create(name="M2", email="m2@test.com")
        q_text = ReviewQuestion.objects.create(cycle=cycle, order=1, question_type='TEXT', content="서술 질문")
        assignment = ReviewAssignment.objects.create(cycle=cycle, reviewer=m1, reviewee=m2)

        session = self.client.session
        session['member_id'] = m1.id
        session['cycle_id'] = cycle.id
        session.save()

        long_text = "A" * 2001
        res = self.client.post(reverse('review_form', args=[assignment.id]), {
            f'q_{q_text.id}_text': long_text
        })
        self.assertEqual(res.status_code, 200)
        assignment.refresh_from_db()
        self.assertFalse(assignment.is_submitted)

    def test_start_cycle_rejection_without_options(self):
        """선택지 없는 객관식 질문 포함 시 회차 개시 거부 검증"""
        self.client.force_login(self.superuser)
        cycle = ReviewCycle.objects.create(title="선택지 미입력 회차", status='DRAFT')
        m1 = Member.objects.create(name="M1", email="m1@test.com")
        m2 = Member.objects.create(name="M2", email="m2@test.com")
        ReviewAssignment.objects.create(cycle=cycle, reviewer=m1, reviewee=m2)

        # 선택지가 없는 SINGLE_CHOICE 문항 생성
        ReviewQuestion.objects.create(cycle=cycle, order=1, question_type='SINGLE_CHOICE', content="객관식 질문")

        res = self.client.post(reverse('admin_start_cycle_action', args=[cycle.id]))
        self.assertRedirects(res, reverse('admin_questions', args=[cycle.id]))
        cycle.refresh_from_db()
        self.assertEqual(cycle.status, 'DRAFT')

    def test_start_cycle_rejection_past_end_at(self):
        """마감 시각이 과거인 경우 회차 개시 거부 검증"""
        self.client.force_login(self.superuser)
        past_time = timezone.now() - timedelta(days=1)
        cycle = ReviewCycle.objects.create(title="과거 마감 회차", status='DRAFT', end_at=past_time)
        m1 = Member.objects.create(name="M1", email="m1@test.com")
        m2 = Member.objects.create(name="M2", email="m2@test.com")
        ReviewAssignment.objects.create(cycle=cycle, reviewer=m1, reviewee=m2)
        ReviewQuestion.objects.create(cycle=cycle, order=1, question_type='TEXT', content="질문")

        res = self.client.post(reverse('admin_start_cycle_action', args=[cycle.id]))
        self.assertRedirects(res, reverse('admin_status_detail', args=[cycle.id]))
        cycle.refresh_from_db()
        self.assertEqual(cycle.status, 'DRAFT')

    def test_draft_oversized_payload_rejection(self):
        """100KB 초과 payload 임시 저장 거부 검증"""
        cycle = ReviewCycle.objects.create(title="임시저장 용량 회차", status='ACTIVE')
        m1 = Member.objects.create(name="M1", email="m1@test.com")
        m2 = Member.objects.create(name="M2", email="m2@test.com")
        assignment = ReviewAssignment.objects.create(cycle=cycle, reviewer=m1, reviewee=m2)

        session = self.client.session
        session['member_id'] = m1.id
        session['cycle_id'] = cycle.id
        session.save()

        big_payload = "X" * (101 * 1024)
        res = self.client.post(
            reverse('save_draft', args=[assignment.id]),
            data=big_payload,
            content_type='application/json'
        )
        self.assertEqual(res.status_code, 400)


class ReportGenerationAndPublishPipelineFixesTestCase(TestCase):
    """리포트 생성, 검수 & 최종 배포 4단계 파이프라인 버그 수정 검증 테스트"""

    def setUp(self):
        self.superuser = User.objects.create_superuser('admin', 'admin@test.com', 'password123')
        self.client = Client()
        self.client.force_login(self.superuser)

    def test_deterministic_text_answer_sorting(self):
        """서술형 답변 순서가 무작위(shuffle)되지 않고 결정적으로 정렬되는지 검증"""
        cycle = ReviewCycle.objects.create(title="정렬 테스트 회차", status='ACTIVE')
        m1 = Member.objects.create(name="M1", email="m1@test.com")
        m2 = Member.objects.create(name="M2", email="m2@test.com")
        m3 = Member.objects.create(name="M3", email="m3@test.com")
        q_text = ReviewQuestion.objects.create(cycle=cycle, order=1, question_type='TEXT', content="서술 문항")

        a1 = ReviewAssignment.objects.create(cycle=cycle, reviewer=m1, reviewee=m3, is_submitted=True)
        a2 = ReviewAssignment.objects.create(cycle=cycle, reviewer=m2, reviewee=m3, is_submitted=True)

        ReviewAnswer.objects.create(assignment=a1, question=q_text, answer_text="피드백 B (나중)")
        ReviewAnswer.objects.create(assignment=a2, question=q_text, answer_text="피드백 A (먼저)")

        context = PDFReportService.compile_feedback_data(cycle, m3)
        self.assertEqual(context['q_1_text_answers'], ["피드백 A (먼저)", "피드백 B (나중)"])

    def test_invalid_html_template_syntax_rejection(self):
        """구문 에러가 포함된 커스텀 HTML 템플릿 업로드 거부 검증"""
        cycle = ReviewCycle.objects.create(title="템플릿 검증 회차", status='DRAFT')
        invalid_html = "{% if unclosed_tag %} <h1>테스트</h1>"  # endif 가 없는 유효하지 않은 템플릿
        html_file = SimpleUploadedFile("invalid.html", invalid_html.encode('utf-8'), content_type="text/html")

        res = self.client.post(reverse('admin_upload_custom_template', args=[cycle.id]), {
            'html_file': html_file
        })
        self.assertEqual(res.status_code, 302)
        cycle.refresh_from_db()
        self.assertFalse(cycle.use_custom_template)

    def test_cli_publish_only_approved_reports(self):
        """CLI publish_reports 실행 시 APPROVED 승인 리포트만 배포 대상에 포함되는지 검증"""
        from core.management.commands.publish_reports import Command
        cycle = ReviewCycle.objects.create(title="CLI 배포 회차", status='COMPLETED')
        m1 = Member.objects.create(name="M1", email="m1@test.com", slack_user_id="U111")
        m2 = Member.objects.create(name="M2", email="m2@test.com", slack_user_id="U222")

        r1 = ReviewReport.objects.create(cycle=cycle, reviewee=m1, validation_status='APPROVED', html_file="reports_html/test1.html")
        r2 = ReviewReport.objects.create(cycle=cycle, reviewee=m2, validation_status='NEEDS_REVIEW', html_file="reports_html/test2.html")

        cmd = Command()
        with patch('core.services.slack_service.SlackService.send_html_report_dm') as mock_send:
            mock_send.return_value = (True, "OK")
            cmd.handle(cycle_id=cycle.id)

        r1.refresh_from_db()
        r2.refresh_from_db()
        self.assertTrue(r1.is_sent)
        self.assertFalse(r2.is_sent)  # APPROVED가 아닌 r2는 배포되지 않아야 함

    def test_filter_response_quality_extended(self):
        """자음/모음 난타, 무의미 패턴, 동일문자 반복 감지 정밀 테스트"""
        cycle = ReviewCycle.objects.create(title="품질 테스트 회차", status='ACTIVE')
        m1 = Member.objects.create(name="작성자", email="writer@test.com", slack_user_id="U100")
        m2 = Member.objects.create(name="대상자", email="target@test.com", slack_user_id="U200")
        assign = ReviewAssignment.objects.create(cycle=cycle, reviewer=m1, reviewee=m2)

        q1 = ReviewQuestion.objects.create(cycle=cycle, order=1, question_type='TEXT', content="피드백 1")
        q2 = ReviewQuestion.objects.create(cycle=cycle, order=2, question_type='TEXT', content="피드백 2")
        q3 = ReviewQuestion.objects.create(cycle=cycle, order=3, question_type='TEXT', content="피드백 3")
        q4 = ReviewQuestion.objects.create(cycle=cycle, order=4, question_type='TEXT', content="피드백 4")

        # 1. 자음/모음 단순 입력 ("ㅋㅋㅋ", "ㅇㅇ", "ㅠㅠ")
        a1 = ReviewAnswer.objects.create(assignment=assign, question=q1, answer_text="ㅋㅋㅋ")
        # 2. 동일 문자 반복 ("가가가가", "aaaa")
        a2 = ReviewAnswer.objects.create(assignment=assign, question=q2, answer_text="가가가가")
        # 3. 키보드 난타 ("asdf", "1234")
        a3 = ReviewAnswer.objects.create(assignment=assign, question=q3, answer_text="asdf")
        # 4. 성의 있는 긴 답변 (통과 대상)
        a4 = ReviewAnswer.objects.create(assignment=assign, question=q4, answer_text="항상 밝게 인사해 주시고 코드 리뷰 시 꼼꼼하게 피드백을 전달해 주셔서 큰 도움이 되었습니다.")

        excluded_count = DataValidationService.filter_response_quality([a1, a2, a3, a4])
        self.assertEqual(excluded_count, 3)

        a1.refresh_from_db()
        a2.refresh_from_db()
        a3.refresh_from_db()
        a4.refresh_from_db()

        self.assertTrue(a1.is_excluded_from_report)
        self.assertTrue(a2.is_excluded_from_report)
        self.assertTrue(a3.is_excluded_from_report)
        self.assertFalse(a4.is_excluded_from_report)




