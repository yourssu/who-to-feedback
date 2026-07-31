import logging
from django.conf import settings
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

logger = logging.getLogger(__name__)


class SlackService:
    def __init__(self):
        self.bot_token = settings.SLACK_BOT_TOKEN
        self.mock_mode = settings.MOCK_SLACK_MODE or not self.bot_token
        if not self.mock_mode:
            self.client = WebClient(token=self.bot_token)
        else:
            self.client = None

    def send_auth_code_dm(self, member, code, login_url="http://127.0.0.1:8000/login"):
        """피어리뷰 시작 시 6자리 개인 인증번호 Slack DM 전송"""
        message_text = (
            f"👋 안녕하세요 {member.name}님!\n"
            f"피어리뷰가 시작되었습니다.\n\n"
            f"🔑 **인증번호 (PIN Code)**: `{code}`\n"
            f"🔗 아래 링크 접속 후 인증번호를 입력하여 피어리뷰를 작성해 주세요:\n"
            f"<{login_url}|피어리뷰 작성 웹사이트 바로가기>"
        )

        # 서버 로그/콘솔에 6자리 PIN 코드 명확하게 출력 (테스트 용도)
        print(f"\n===========================================================")
        print(f"🔑 [AUTH PIN CODE LOG] Member: {member.name} ({member.email})")
        print(f"🔑 [AUTH PIN CODE]: {code}")
        print(f"🔑 [Slack User ID]: {member.slack_user_id}")
        print(f"===========================================================\n")
        logger.info(f"AUTH PIN CODE for {member.name} ({member.email}): {code}")

        if self.mock_mode:
            return True, "Mock DM sent successfully"

        try:
            response = self.client.chat_postMessage(
                channel=member.slack_user_id,
                text=message_text,
            )
            return True, response['ts']
        except SlackApiError as e:
            logger.error(f"Failed to send Slack DM to {member.name}: {e.response['error']}")
            return False, e.response['error']

    def send_reminder_dm(self, reviewer, unsubmitted_reviewees, login_url="http://127.0.0.1:8000/login"):
        """
        미작성자 대상 독촉 Slack DM 전송
        - 아직 작성되지 않은 Reviewee(동료) 명단을 포함함
        """
        reviewee_names = ", ".join([r.name for r in unsubmitted_reviewees])
        message_text = (
            f"⏰ **[피어리뷰 작성 마감 임박 알림]**\n"
            f"안녕하세요 {reviewer.name}님!\n"
            f"피어리뷰 마감 시각이 임박했습니다. 작성을 마쳐주세요.\n\n"
            f"📌 **아직 피어리뷰를 작성하지 않은 동료 목록**: **{reviewee_names}**\n\n"
            f"🔗 <{login_url}|피어리뷰 작성 페이지 바로가기>"
        )

        if self.mock_mode:
            logger.info(f"[MOCK SLACK REMINDER -> {reviewer.name} ({reviewer.slack_user_id})]:\n{message_text}")
            print(f"\n================ [MOCK SLACK REMINDER DM] ================")
            print(f"To: {reviewer.name} (Slack ID: {reviewer.slack_user_id})")
            print(f"Unsubmitted Reviewees: {reviewee_names}")
            print(f"Message:\n{message_text}")
            print(f"===========================================================\n")
            return True, "Mock Reminder DM sent"

        try:
            response = self.client.chat_postMessage(
                channel=reviewer.slack_user_id,
                text=message_text,
            )
            return True, response['ts']
        except SlackApiError as e:
            logger.error(f"Failed to send reminder DM to {reviewer.name}: {e.response['error']}")
            return False, e.response['error']

    def send_failed_reminders_retry(self, member, text):
        """실패한 독촉 알림에 대한 재시도 알림"""
        print(f"\n================ [SLACK FAILED REMINDERS RETRY] ================")
        print(f"To: {member.name} ({member.slack_user_id})")
        print(f"Text: {text}")
        print(f"===================================================\n")

        if self.mock_mode:
            return True, "Mock Retry DM Sent"

        try:
            self.client.chat_postMessage(channel=member.slack_user_id, text=text)
            return True, "Retry DM Sent"
        except Exception as e:
            return False, str(e)

    def send_pdf_report_dm(self, member, pdf_file_path, cycle_title):
        """
        검토 완료된 피어리뷰 결과 PDF 리포트를 Reviewee Slack DM으로 업로드 및 전송
        """
        initial_comment = (
            f"🎉 **[{cycle_title}] 피어리뷰 결과 리포트 도착**\n"
            f"안녕하세요 {member.name}님!\n"
            f"이번 피어리뷰 세션이 마감되어 동료들의 피드백 결과를 정리한 PDF 리포트 파일이 전달되었습니다.\n"
            f"첨부된 PDF 파일을 확인해 주세요!"
        )

        if self.mock_mode:
            logger.info(f"[MOCK SLACK PDF DM -> {member.name} ({member.slack_user_id})]: Path={pdf_file_path}")
            print(f"\n================ [MOCK SLACK PDF REPORT DM] ================")
            print(f"To: {member.name} (Slack ID: {member.slack_user_id})")
            print(f"File Path: {pdf_file_path}")
            print(f"Comment: {initial_comment}")
            print(f"===========================================================\n")
            return True, "Mock PDF DM sent"

        try:
            # files.upload_v2 API 사용
            response = self.client.files_upload_v2(
                channel=member.slack_user_id,
                file=pdf_file_path,
                filename=f"피어리뷰_리포트_{member.name}.pdf",
                initial_comment=initial_comment
            )
            return True, response.get("file", {}).get("id", "uploaded")
        except SlackApiError as e:
            logger.error(f"Failed to upload PDF report to {member.name}: {e.response['error']}")
            return False, e.response['error']
