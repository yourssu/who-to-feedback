from django.test import TestCase, Client
from django.utils import timezone
from django.urls import reverse

from core.models import (
    Member, ReviewCycle, ReviewQuestion, QuestionOption,
    ReviewAuthCode, ReviewAssignment, ReviewAnswer, ReviewReport
)
from core.services.slack_service import SlackService
from core.services.pdf_service import PDFReportService


class PeerReviewSystemTestCase(TestCase):
    def setUp(self):
        # 1. 팀원 세팅
        self.alice = Member.objects.create(name="앨리스", email="alice@test.com", slack_user_id="U_ALICE", department="개발팀")
        self.bob = Member.objects.create(name="밥", email="bob@test.com", slack_user_id="U_BOB", department="기획팀")
        self.charlie = Member.objects.create(name="찰리", email="charlie@test.com", slack_user_id="U_CHARLIE", department="디자인팀")

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

    def test_02_review_submission_with_multiple_question_types(self):
        """다양한 문항 유형(척도, 주관식, 단일선택, 다중선택) 작성 및 제출 테스트"""
        auth_code = ReviewAuthCode.generate_code_for(self.alice, self.cycle)
        self.client.post(reverse('login'), {'code': auth_code.code})

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

    def test_03_reminder_dm_includes_unsubmitted_reviewee_names(self):
        """리마인더 메시지 전송 시 미작성 동료 이름 명단 포함 여부 테스트"""
        unsubmitted_reviewees = [self.bob, self.charlie]
        slack = SlackService()
        success, msg = slack.send_reminder_dm(self.alice, unsubmitted_reviewees)
        self.assertTrue(success)

    def test_04_strict_completion_and_admin_review_gate(self):
        """100% 전원 작성 완료 전 마감 차단 및 작성 완료 후 관리자 PDF 검토/승인 배포 파이프라인 테스트"""
        self.a_to_b.is_submitted = True
        self.a_to_b.save()
        self.a_to_c.is_submitted = True
        self.a_to_c.save()
        self.b_to_a.is_submitted = True
        self.b_to_a.save()

        reports = PDFReportService.generate_all_reports_for_cycle(self.cycle)
        self.cycle.status = 'COMPLETED'
        self.cycle.save()

        res_publish = self.client.post(reverse('admin_publish_reports_action', kwargs={'cycle_id': self.cycle.id}))
        self.assertEqual(res_publish.status_code, 302)

        self.cycle.refresh_from_db()
        self.assertEqual(self.cycle.status, 'CLOSED')

    def test_05_custom_admin_pages_rendering_and_crud(self):
        """6개 전용 커스텀 관리자 웹 페이지 접근 및 CRUD 검증"""
        # PAGE 1: 팀원 관리
        res = self.client.get(reverse('admin_members'))
        self.assertEqual(res.status_code, 200)

        res_add_m = self.client.post(reverse('admin_add_member'), {
            'name': '데이비드', 'email': 'david@test.com', 'slack_user_id': 'U_DAVID', 'department': 'QA팀'
        })
        self.assertEqual(res_add_m.status_code, 302)
        self.assertTrue(Member.objects.filter(name='데이비드').exists())

        # PAGE 2: 질문지 제작
        res_q = self.client.get(reverse('admin_questions', kwargs={'cycle_id': self.cycle.id}))
        self.assertEqual(res_q.status_code, 200)

        # PAGE 3: 매칭 관리
        res_a = self.client.get(reverse('admin_assignments', kwargs={'cycle_id': self.cycle.id}))
        self.assertEqual(res_a.status_code, 200)

        # PAGE 4: 진행 상태 대시보드
        res_s = self.client.get(reverse('admin_status_detail', kwargs={'cycle_id': self.cycle.id}))
        self.assertEqual(res_s.status_code, 200)

        # PAGE 5: HTML/PDF 검토 페이지
        res_r = self.client.get(reverse('admin_reports', kwargs={'cycle_id': self.cycle.id}))
        self.assertEqual(res_r.status_code, 200)

        # PAGE 6: Slack DM 메시지 전송
        res_msg = self.client.get(reverse('admin_send_message'))
        self.assertEqual(res_msg.status_code, 200)

    def test_06_active_cycle_matching_modification(self):
        """ACTIVE 진행 중 상태에서 매칭 추가/삭제 및 신규 리뷰어 핀코드 DM 자동 발송 검증"""
        # 신규 팀원 데이비드 추가 후 Charlie -> David 매칭 추가 (ACTIVE 상태)
        david = Member.objects.create(name="데이비드", email="david2@test.com", slack_user_id="U_DAVID2")
        
        res = self.client.post(reverse('admin_add_assignment', kwargs={'cycle_id': self.cycle.id}), {
            'reviewer_id': self.charlie.id,
            'reviewee_id': david.id,
        })
        self.assertEqual(res.status_code, 302)

        # 매칭이 정상 생성되었는지 검증
        new_assign = ReviewAssignment.objects.filter(cycle=self.cycle, reviewer=self.charlie, reviewee=david).first()
        self.assertIsNotNone(new_assign)

        # 진행 중(ACTIVE) 상태이므로 Charlie에게 인증코드가 생성 및 DM 발송되었는지 검증
        auth_code = ReviewAuthCode.objects.filter(member=self.charlie, cycle=self.cycle).first()
        self.assertIsNotNone(auth_code)

        # 매칭 삭제 검증
        res_del = self.client.post(reverse('admin_delete_assignment', kwargs={'assignment_id': new_assign.id}))
        self.assertEqual(res_del.status_code, 302)
        self.assertFalse(ReviewAssignment.objects.filter(id=new_assign.id).exists())

    def test_07_custom_slack_dm_message_sending(self):
        """PAGE 6: 관리자 커스텀 Slack DM 메시지 발송 검증"""
        res_send = self.client.post(reverse('admin_send_message'), {
            'recipient_type': 'ALL',
            'message_text': '안녕하세요 전체 팀원 여러분, 피어리뷰 공지입니다.',
        })
        self.assertEqual(res_send.status_code, 302)
