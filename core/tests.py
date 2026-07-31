from django.test import TestCase, Client
from django.utils import timezone
from django.urls import reverse
from django.contrib.auth.models import User
import json

from core.models import (
    Member, ReviewCycle, ReviewQuestion, QuestionOption,
    ReviewAuthCode, ReviewAssignment, ReviewAnswer, ReviewReport, DataValidationLog
)
from core.services.slack_service import SlackService
from core.services.pdf_service import PDFReportService
from core.services.ppt_service import PPTReportService
from core.services.validation_service import DataValidationService


class PeerReviewSystemTestCase(TestCase):
    def setUp(self):
        # 0. Admin Superuser 생성
        self.superuser = User.objects.create_superuser('admin', 'admin@test.com', 'password123')

        # 1. 팀원 세팅 (역할 및 정규화 필드 포함)
        self.alice = Member.objects.create(name="앨리스", email="alice@test.com", slack_user_id="U_ALICE", department="개발팀", role='MEMBER')
        self.bob = Member.objects.create(name="밥", email="bob@test.com", slack_user_id="U_BOB", department="기획팀", role='MEMBER')
        self.charlie = Member.objects.create(name="찰리", email="charlie@test.com", slack_user_id="U_CHARLIE", department="디자인팀", role='MEMBER')

        # 2. 회차 세팅
        now = timezone.now()
        self.cycle = ReviewCycle.objects.create(
            title="2026 Q2 피어리뷰",
            start_at=now,
            end_at=now + timezone.timedelta(days=7),
            status='ACTIVE'
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

    def test_01_slack_auth_code_generation_and_login(self):
        """Slack PIN 인증코드 생성 및 로그인 테스트"""
        auth_code = ReviewAuthCode.generate_code_for(self.alice, self.cycle)
        self.assertEqual(len(auth_code.code), 6)

        res_fail = self.client.post(reverse('login'), {'code': '000000'})
        self.assertEqual(self.client.session.get('member_id'), None)

        res_success = self.client.post(reverse('login'), {'code': auth_code.code})
        self.assertEqual(res_success.status_code, 302)
        self.assertEqual(self.client.session['member_id'], self.alice.id)

    def test_02_draft_save_and_review_submission(self):
        """임시 저장 Draft API 및 다양한 문항 제출 테스트"""
        auth_code = ReviewAuthCode.generate_code_for(self.alice, self.cycle)
        self.client.post(reverse('login'), {'code': auth_code.code})

        # 1. Draft 임시 저장 API 테스트
        draft_payload = json.dumps({'q_1_text': '작성 중인 피드백입니다.'})
        res_draft = self.client.post(
            reverse('save_draft', kwargs={'assignment_id': self.a_to_b.id}),
            draft_payload,
            content_type='application/json'
        )
        self.assertEqual(res_draft.status_code, 200)
        self.a_to_b.refresh_from_db()
        self.assertIsNotNone(self.a_to_b.draft_data)

        # 2. 최종 폼 제출 테스트
        form_data = {
            f'q_{self.q1.id}_rating': 5,
            f'q_{self.q2.id}_text': '협업 능력이 뛰어납니다.',
            f'q_{self.q3.id}_single': self.opt3_yes.id,
            f'q_{self.q4.id}_multi': [self.opt4_lead.id, self.opt4_code.id],
        }

        res = self.client.post(reverse('review_form', kwargs={'assignment_id': self.a_to_b.id}), form_data)
        self.assertEqual(res.status_code, 302)

        self.a_to_b.refresh_from_db()
        self.assertTrue(self.a_to_b.is_submitted)

    def test_03_deadline_locking_policy(self):
        """마감 시간 경과 시 제출된 리뷰 수정 잠금(r-submitted-locked) 정책 검증"""
        auth_code = ReviewAuthCode.generate_code_for(self.alice, self.cycle)
        self.client.post(reverse('login'), {'code': auth_code.code})

        self.a_to_b.is_submitted = True
        self.a_to_b.save()

        # 마감 시각을 과거로 변경
        self.cycle.end_at = timezone.now() - timezone.timedelta(hours=1)
        self.cycle.save()

        res_form = self.client.get(reverse('review_form', kwargs={'assignment_id': self.a_to_b.id}))
        self.assertEqual(res_form.status_code, 200)
        self.assertTrue(res_form.context['is_locked'])

    def test_04_ppt_report_generation_and_validation_service(self):
        """python-pptx 기반 PPT 리포트 자동 생성 및 응답 품질 필터링 검증"""
        self.client.force_login(self.superuser)

        # 서술형 피드백 작성
        ans = ReviewAnswer.objects.create(
            assignment=self.a_to_b,
            question=self.q2,
            answer_text="없습니다"
        )

        # 응답 품질 필터 실행
        DataValidationService.filter_response_quality([ans])
        ans.refresh_from_db()
        self.assertTrue(ans.is_excluded_from_report)

        # PPT 리포트 생성
        report = PPTReportService.generate_ppt_report(self.cycle, self.bob)
        self.assertIsNotNone(report.ppt_file)
        self.assertEqual(report.validation_status, 'APPROVED')

    def test_05_custom_admin_pages_rendering_and_validation_page(self):
        """데이터 검증 탭을 포함한 8개 커스텀 관리자 센터 접근 검증"""
        self.client.force_login(self.superuser)

        # 데이터 검증 센터 (a-validation)
        res_val = self.client.get(reverse('admin_validation'))
        self.assertEqual(res_val.status_code, 200)

        # 리포트 검토 센터 (a-reports)
        res_rep = self.client.get(reverse('admin_reports', kwargs={'cycle_id': self.cycle.id}))
        self.assertEqual(res_rep.status_code, 200)

        # Slack DM 전송 센터 (a-messages)
        res_msg = self.client.get(reverse('admin_send_message'))
        self.assertEqual(res_msg.status_code, 200)
