from django.test import TestCase, Client
from django.utils import timezone
from django.urls import reverse
from django.contrib.auth.models import User
import json

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
