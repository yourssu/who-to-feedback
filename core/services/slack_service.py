import os
import logging
from django.conf import settings
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError
from core.models import SlackDeliveryLog, Member, ReviewCycle

logger = logging.getLogger(__name__)


class SlackService:
    def __init__(self):
        self.bot_token = settings.SLACK_BOT_TOKEN
        self.mock_mode = settings.MOCK_SLACK_MODE

        if not self.bot_token or self.bot_token == "xoxb-your-slack-bot-token-here":
            self.mock_mode = True

        if not self.mock_mode:
            self.client = WebClient(token=self.bot_token)
        else:
            self.client = None

    def log_delivery(self, member, delivery_type, content, is_success, error_msg="", cycle=None):
        """Slack DM 발송 성공/실패 기록 전수 저장"""
        return SlackDeliveryLog.objects.create(
            cycle=cycle,
            member=member,
            delivery_type=delivery_type,
            message_content=content,
            is_success=is_success,
            error_message=error_msg
        )

    def send_auth_code_dm(self, member, code, cycle=None):
        """6자리 PIN 인증 코드 Slack DM 전송"""
        login_url = "http://127.0.0.1:8000/login"
        message_text = (
            f"🔑 **[피어리뷰 로그인 6자리 PIN 코드]**\n"
            f"안녕하세요 {member.name}님!\n"
            f"이번 피어리뷰 세션 참가를 위한 인증 핀코드는 **[{code}]** 입니다.\n\n"
            f" 아래 링크에서 핀코드를 입력하여 로그인해 주세요.\n"
            f"<{login_url}|피어리뷰 작성 웹사이트 바로가기>"
        )

        print(f"\n===========================================================")
        print(f"🔑 [AUTH PIN CODE LOG] Member: {member.name} ({member.email})")
        print(f"🔑 [AUTH PIN CODE]: {code}")
        print(f"===========================================================\n")

        if self.mock_mode:
            self.log_delivery(member, 'AUTH_CODE', message_text, True, "Mock DM Sent", cycle)
            return True, "Mock DM sent successfully"

        try:
            self.client.chat_postMessage(channel=member.slack_user_id, text=message_text)
            self.log_delivery(member, 'AUTH_CODE', message_text, True, "", cycle)
            return True, "Slack DM sent successfully"
        except SlackApiError as e:
            err = e.response['error']
            self.log_delivery(member, 'AUTH_CODE', message_text, False, err, cycle)
            return False, err

    def send_reminder_dm(self, reviewer, unsubmitted_reviewees, cycle=None):
        """미작성 동료 명단이 명시된 독촉 Slack DM 전송"""
        reviewee_names = ", ".join([r.name for r in unsubmitted_reviewees])
        login_url = "http://127.0.0.1:8000/login"

        message_text = (
            f"⏰ **[피어리뷰 작성 마감 임박 알림]**\n"
            f"안녕하세요 {reviewer.name}님!\n"
            f"피어리뷰 마감 시각이 임박했습니다. 작성을 마쳐주세요.\n\n"
            f"📌 **아직 피어리뷰를 작성하지 않은 동료 목록**: **{reviewee_names}**\n\n"
            f"🔗 <{login_url}|피어리뷰 작성 페이지 바로가기>"
        )

        if self.mock_mode:
            print(f"\n================ [MOCK SLACK REMINDER DM] ================")
            print(f"To: {reviewer.name} ({reviewer.slack_user_id})\nMessage:\n{message_text}")
            print(f"===========================================================\n")
            self.log_delivery(reviewer, 'REMINDER', message_text, True, "Mock Reminder Sent", cycle)
            return True, "Mock Reminder DM sent"

        try:
            self.client.chat_postMessage(channel=reviewer.slack_user_id, text=message_text)
            self.log_delivery(reviewer, 'REMINDER', message_text, True, "", cycle)
            return True, "Reminder DM sent successfully"
        except SlackApiError as e:
            err = e.response['error']
            self.log_delivery(reviewer, 'REMINDER', message_text, False, err, cycle)
            return False, err

    def send_failed_reminders_retry(self, member, message_text, cycle=None):
        """실패했던 DM 건에 대한 1클릭 재발송 처리"""
        print(f"\n================ [SLACK FAILED DM RETRY] ================")
        print(f"To: {member.name} ({member.slack_user_id})\nMessage:\n{message_text}")
        print(f"========================================================\n")

        if self.mock_mode:
            self.log_delivery(member, 'REMINDER', message_text, True, "Mock Retry Sent", cycle)
            return True, "Mock Retry DM sent"

        try:
            self.client.chat_postMessage(channel=member.slack_user_id, text=message_text)
            self.log_delivery(member, 'REMINDER', message_text, True, "", cycle)
            return True, "Retry DM sent"
        except SlackApiError as e:
            err = e.response['error']
            self.log_delivery(member, 'REMINDER', message_text, False, err, cycle)
            return False, err

    def send_custom_dm(self, member, text, cycle=None):
        """특정 개별 메시지 DM 발송"""
        print(f"\n================ [SLACK CUSTOM DM] ================")
        print(f"To: {member.name} ({member.slack_user_id})\nText: {text}")
        print(f"===================================================\n")

        if self.mock_mode:
            self.log_delivery(member, 'CUSTOM_MSG', text, True, "Mock Custom DM Sent", cycle)
            return True, "Mock Custom DM Sent"

        try:
            self.client.chat_postMessage(channel=member.slack_user_id, text=text)
            self.log_delivery(member, 'CUSTOM_MSG', text, True, "", cycle)
            return True, "Custom DM Sent"
        except SlackApiError as e:
            err = e.response['error']
            self.log_delivery(member, 'CUSTOM_MSG', text, False, err, cycle)
            return False, err

    def send_pdf_report_dm(self, member, pdf_file_path, cycle_title, cycle=None):
        """피어리뷰 결과 PDF 리포트 파일 업로드 및 Slack DM 발송"""
        comment_text = (
            f"🎉 **[{cycle_title}] 피어리뷰 결과 리포트 도착**\n"
            f"안녕하세요 {member.name}님!\n"
            f"이번 피어리뷰 세션이 마감되어 동료들의 피드백 결과를 정리한 PDF 리포트 파일이 전달되었습니다.\n"
            f"첨부된 PDF 파일을 확인해 주세요!"
        )

        if self.mock_mode:
            print(f"\n================ [MOCK SLACK PDF REPORT DM] ================")
            print(f"To: {member.name} ({member.slack_user_id})\nFile Path: {pdf_file_path}")
            print(f"===========================================================\n")
            self.log_delivery(member, 'REPORT', comment_text, True, "Mock PDF Sent", cycle)
            return True, "Mock PDF Report DM sent"

        try:
            response = self.client.files_upload_v2(
                channel=member.slack_user_id,
                file=pdf_file_path,
                title=f"{cycle_title} 피어리뷰 리포트_{member.name}.pdf",
                initial_comment=comment_text
            )
            self.log_delivery(member, 'REPORT', comment_text, True, "", cycle)
            return True, "PDF Report DM uploaded"
        except SlackApiError as e:
            err = e.response['error']
            self.log_delivery(member, 'REPORT', comment_text, False, err, cycle)
            return False, err

    def send_test_dm(self, admin_member, sample_pdf_path=None):
        """전체 발송 전 관리자 본인에게 보내는 사전 테스트 DM"""
        test_text = (
            f"🧪 **[발송 전 사전 테스트 DM]**\n"
            f"안녕하세요 관리자 {admin_member.name}님!\n"
            f"본 메시지는 피어리뷰 전체 일괄 발송 전 양식 및 PDF 파일 정상 동작 여부를 확인하기 위한 테스트 DM입니다."
        )

        if self.mock_mode:
            print(f"\n================ [SLACK TEST DM] ================")
            print(f"To Admin: {admin_member.name} ({admin_member.slack_user_id})")
            print(f"Content:\n{test_text}")
            print(f"=================================================\n")
            self.log_delivery(admin_member, 'TEST_DM', test_text, True, "Mock Test DM Sent")
            return True, "Mock Test DM Sent"

        try:
            if sample_pdf_path and os.path.exists(sample_pdf_path):
                self.client.files_upload_v2(
                    channel=admin_member.slack_user_id,
                    file=sample_pdf_path,
                    title="[테스트] 샘플 피어리뷰 리포트.pdf",
                    initial_comment=test_text
                )
            else:
                self.client.chat_postMessage(channel=admin_member.slack_user_id, text=test_text)

            self.log_delivery(admin_member, 'TEST_DM', test_text, True)
            return True, "Test DM Sent"
        except SlackApiError as e:
            err = e.response['error']
            self.log_delivery(admin_member, 'TEST_DM', test_text, False, err)
            return False, err
