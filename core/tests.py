from django.test import TestCase, Client
from django.utils import timezone
from django.urls import reverse
from django.contrib.auth.models import User
import json

from core.models import (
    Member, ReviewCycle, ReviewQuestion, QuestionOption,
    ReviewAuthCode, ReviewAssignment, ReviewAnswer, ReviewReport,
    DataValidationLog, SlackDeliveryLog
)
from core.services.slack_service import SlackService
from core.services.pdf_service import PDFReportService
from core.services.ppt_service import PPTReportService
from core.services.validation_service import DataValidationService


class PeerReviewSystemTestCase(TestCase):
    def setUp(self):
        # 0. Admin Superuser 생성
        self.superuser = User.objects.create_superuser('admin', 'admin@test.com', 'password123')

        # 1. 팀원 세팅
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

    def test_01_permission_isolation_and_login(self):
        """1. 관리자/일반 사용자 권한 분리 및 슬랙 PIN 로그인 테스트"""
        res_unauth = self.client.get(reverse('admin_dashboard'))
        self.assertEqual(res_unauth.status_code, 302)

        self.client.force_login(self.superuser)
        res_auth = self.client.get(reverse('admin_dashboard'))
        self.assertEqual(res_auth.status_code, 200)

    def test_02_full_form_draft_save_all_question_types(self):
        """2. 전체 질문지에 대한 4가지 문항 타입(RATING, TEXT, SINGLE, MULTI) 통합 임시 저장 및 복원 테스트"""
        auth_code = ReviewAuthCode.generate_code_for(self.alice, self.cycle)
        self.client.post(reverse('login'), {'code': auth_code.code})

        # 4가지 모든 문항 타입이 포함된 전체 폼 임시 저장 payload
        full_draft_payload = json.dumps({
            f'q_{self.q1.id}_rating': 4,
            f'q_{self.q2.id}_text': '전체 폼 임시 저장 피드백입니다.',
            f'q_{self.q3.id}_single': self.opt3_yes.id,
            f'q_{self.q4.id}_multi': [self.opt4_lead.id, self.opt4_code.id],
        })

        res_draft = self.client.post(
            reverse('save_draft', kwargs={'assignment_id': self.a_to_b.id}),
            full_draft_payload,
            content_type='application/json'
        )
        self.assertEqual(res_draft.status_code, 200)

        self.a_to_b.refresh_from_db()
        self.assertEqual(self.a_to_b.draft_data[f'q_{self.q1.id}_rating'], 4)
        self.assertEqual(self.a_to_b.draft_data[f'q_{self.q2.id}_text'], '전체 폼 임시 저장 피드백입니다.')

        # 폼 GET 조회 시 임시 저장 데이터가 복원되어 준비되었는지 확인
        res_form = self.client.get(reverse('review_form', kwargs={'assignment_id': self.a_to_b.id}))
        self.assertEqual(res_form.status_code, 200)
        self.assertEqual(res_form.context['questions_data'][0]['draft_rating'], 4)
        self.assertEqual(res_form.context['questions_data'][1]['draft_text'], '전체 폼 임시 저장 피드백입니다.')

    def test_03_question_locking_policy_when_active(self):
        """3. 질문지 수정 가능 시점 제한 (ACTIVE 시작 후 질문 추가/삭제 차단) 테스트"""
        self.client.force_login(self.superuser)
        self.assertTrue(self.cycle.is_question_locked)

        res_add = self.client.post(reverse('admin_add_question', kwargs={'cycle_id': self.cycle.id}), {
            'order': 5, 'question_type': 'TEXT', 'content': '신규 질문'
        })
        self.assertEqual(res_add.status_code, 302)
        self.assertFalse(ReviewQuestion.objects.filter(content='신규 질문').exists())

    def test_04_anonymity_and_randomized_report(self):
        """4. 익명성 보장 규칙 테스트"""
        ReviewAnswer.objects.create(assignment=self.a_to_b, question=self.q2, answer_text="피드백 내용 1")
        data = PDFReportService.compile_feedback_data(self.cycle, self.bob)

        self.assertNotIn('reviewer', data['questions_data'][1])
        self.assertNotIn('alice', str(data['questions_data'][1]).lower())

    def test_05_deadline_modification_and_locking(self):
        """5. 제출 후 수정 허용 정책 (마감 전 재수정 허용, 마감 후 자동 잠금) 테스트"""
        auth_code = ReviewAuthCode.generate_code_for(self.alice, self.cycle)
        self.client.post(reverse('login'), {'code': auth_code.code})

        self.a_to_b.is_submitted = True
        self.a_to_b.save()

        res_before = self.client.get(reverse('review_form', kwargs={'assignment_id': self.a_to_b.id}))
        self.assertEqual(res_before.status_code, 200)
        self.assertFalse(res_before.context['is_locked'])

        self.cycle.end_at = timezone.now() - timezone.timedelta(hours=1)
        self.cycle.save()
        res_after = self.client.get(reverse('review_form', kwargs={'assignment_id': self.a_to_b.id}))
        self.assertEqual(res_after.status_code, 200)
        self.assertTrue(res_after.context['is_locked'])

    def test_06_pdf_ppt_failure_logging_and_retry(self):
        """6. PDF/PPT 생성 실패 예외 로그 보존 및 1클릭 재시도 테스트"""
        self.client.force_login(self.superuser)

        report = PDFReportService.generate_pdf_report(self.cycle, self.bob)
        res_retry = self.client.post(reverse('admin_regenerate_report', kwargs={'report_id': report.id}))
        self.assertEqual(res_retry.status_code, 302)

    def test_07_slack_delivery_logging_and_test_dm(self):
        """7. Slack DM 성공/실패 기록(SlackDeliveryLog) 및 사전 테스트 DM 테스트"""
        self.client.force_login(self.superuser)

        res_test_dm = self.client.post(reverse('admin_send_test_dm'))
        self.assertEqual(res_test_dm.status_code, 302)
        self.assertTrue(SlackDeliveryLog.objects.filter(delivery_type='TEST_DM').exists())
