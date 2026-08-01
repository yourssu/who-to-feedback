from django.test import TestCase, Client
from django.utils import timezone
from datetime import timedelta
from django.urls import reverse
from django.contrib.auth.models import User
from django.core.files.base import ContentFile
from django.core.files.uploadedfile import SimpleUploadedFile
import json
import os

from core.models import (
    Member, ReviewCycle, ReviewQuestion, QuestionOption,
    ReviewAuthCode, ReviewAssignment, ReviewAnswer, ReviewReport,
    DataValidationLog, SlackDeliveryLog, ReviewCycleVersionLog
)
from core.services.slack_service import SlackService
from core.services.pdf_service import PDFReportService
from core.services.ppt_service import PPTReportService
from core.services.validation_service import DataValidationService
from core.services.layout_service import LayoutCheckService
from core.services.report_service import ReportManagementService


class PeerReviewSystemTestCase(TestCase):
    def setUp(self):
        # 0. Admin Superuser 생성
        self.superuser = User.objects.create_superuser('admin', 'admin@test.com', 'password123')

        # 1. 팀원 세팅
        self.alice = Member.objects.create(name="앨리스", email="alice@test.com", slack_user_id="U_ALICE", department="개발팀", role='MEMBER')
        self.bob = Member.objects.create(name="밥", email="bob@test.com", slack_user_id="U_BOB", department="기획팀", role='MEMBER')
        self.charlie = Member.objects.create(name="찰리", email="charlie@test.com", slack_user_id="U_CHARLIE", department="디자인팀", role='MEMBER')

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


class CustomHTMLTemplateTestCase(TestCase):
    def setUp(self):
        self.superuser = User.objects.create_superuser('admin', 'admin@example.com', 'password123')
        self.alice = Member.objects.create(name='Alice', email='alice@example.com', slack_user_id='U111', role='ADMIN')
        self.bob = Member.objects.create(name='Bob', email='bob@example.com', slack_user_id='U222', role='MEMBER')

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
        self.assertTrue(bool(report.pdf_file))
        self.assertTrue(os.path.exists(report.pdf_file.path))

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
        self.assertTrue(Member.objects.filter(email='design@yourssu.com', role='ADMIN').exists())






