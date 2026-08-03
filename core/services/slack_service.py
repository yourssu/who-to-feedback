import os
import re
import logging
from django.conf import settings
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError
from core.models import SlackDeliveryLog, Member, ReviewCycle

logger = logging.getLogger(__name__)

# 올바른 Slack User ID / DM Channel ID 정규식 (대문자 U, W, D로 시작하는 8~14자리 알파벳/숫자)
VALID_SLACK_ID_REGEX = re.compile(r'^[UWD][A-Z0-9]{8,14}$')


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

    def get_real_slack_user_id(self, member):
        """Slack ID 정규화: slack_user_id가 username이나 가짜 텍스트인 경우 이메일/유저네임으로 실제 Slack User ID(U08...) 자동 획득"""
        target_id = (member.slack_user_id or "").strip()

        # 이미 올바른 형식의 실제 Slack ID (예: U08ABC12345, D08XYZ67890)인 경우 그대로 사용
        if VALID_SLACK_ID_REGEX.match(target_id):
            return target_id

        if self.mock_mode or not self.client:
            return target_id

        real_id = None

        # 1. 이메일 기반 lookupByEmail 시도 (users:read.email 권한 필요)
        if member.email and '@' in member.email:
            try:
                res = self.client.users_lookupByEmail(email=member.email)
                if res.get('ok') and 'user' in res and 'id' in res['user']:
                    real_id = res['user']['id']
            except Exception as e:
                logger.warning(f"Slack lookupByEmail failed for {member.email}: {e}")

        # 2. lookupByEmail 실패 시 (missing_scope 등), users:read 스코프 기반 users.list 전체 스캔 매칭 (이메일 & 유저네임)
        if not real_id:
            raw_username = target_id.lstrip('@').lower()
            member_name_clean = member.name.strip().lower()
            member_email_clean = (member.email or "").strip().lower()

            try:
                users_res = self.client.users_list()
                if users_res.get('ok') and 'members' in users_res:
                    for u in users_res['members']:
                        if u.get('deleted') or u.get('is_bot'):
                            continue
                        u_email = u.get('profile', {}).get('email', '').lower()
                        u_name = u.get('name', '').lower()
                        u_disp = u.get('profile', {}).get('display_name', '').lower()
                        u_real = u.get('profile', {}).get('real_name', '').lower()

                        match_candidates = [u_name, u_disp, u_real]

                        # 1순위: 이메일 매칭, 2순위: 닉네임/유저네임/이름 매칭
                        if member_email_clean and u_email == member_email_clean:
                            real_id = u['id']
                            break
                        if (raw_username and raw_username in match_candidates) or (member_name_clean and member_name_clean in match_candidates):
                            real_id = u['id']
                            break
            except Exception as e:
                logger.warning(f"Slack users_list scan match failed for target '{target_id}': {e}")

        # 실제 Slack ID를 새로 찾은 경우 DB에 갱신 저장하여 향후 API 재호출 최소화
        if real_id and VALID_SLACK_ID_REGEX.match(real_id):
            member.slack_user_id = real_id
            member.save(update_fields=['slack_user_id'])
            return real_id

        return target_id

    def get_or_create_dm_channel(self, member):
        """Slack User ID를 받아 봇과 사용자 간의 1:1 DM 채널 ID(D...)를 생성/오픈하여 반환"""
        if self.mock_mode or not self.client:
            return member.slack_user_id

        user_id = self.get_real_slack_user_id(member)
        if not user_id:
            return member.slack_user_id

        # 이미 D로 시작하는 Direct Message 채널 ID인 경우 그대로 사용
        if user_id.startswith('D') and len(user_id) >= 8:
            return user_id

        # conversations_open API를 이용해 1:1 DM 채널 ID(D...) 생성
        try:
            res = self.client.conversations_open(users=[user_id])
            if res.get('ok') and 'channel' in res and 'id' in res['channel']:
                return res['channel']['id']
        except SlackApiError as e:
            logger.warning(f"conversations_open failed for user {user_id}: {e.response['error']}")
        except Exception as e:
            logger.warning(f"conversations_open failed for user {user_id}: {e}")

        return user_id

    def send_auth_code_dm(self, member, code, cycle=None):
        """6자리 PIN 인증 코드 Slack DM 전송"""
        site_url = getattr(settings, 'SITE_URL', 'http://127.0.0.1:8000').rstrip('/')
        login_url = f"{site_url}/login"
        message_text = (
            f"🔑 **[피어리뷰 로그인 6자리 PIN 코드]**\n"
            f"안녕하세요 {member.name}님!\n"
            f"이번 피어리뷰 세션 참가를 위한 인증 핀코드는 **[{code}]** 입니다.\n\n"
            f"아래 링크에서 핀코드를 입력하여 로그인해 주세요.\n"
            f"<{login_url}|피어리뷰 작성 웹사이트 바로가기>"
        )

        print(f"\n===========================================================")
        print(f"🔑 [AUTH PIN CODE LOG] Member: {member.name} ({member.email})")
        print(f"🔑 [AUTH PIN CODE]: {code}")
        print(f"===========================================================\n")

        if self.mock_mode:
            self.log_delivery(member, 'AUTH_CODE', message_text, True, "Mock DM Sent", cycle)
            return True, "Mock DM sent successfully"

        target_channel = self.get_or_create_dm_channel(member)

        try:
            self.client.chat_postMessage(channel=target_channel, text=message_text)
            self.log_delivery(member, 'AUTH_CODE', message_text, True, "", cycle)
            return True, "Slack DM sent successfully"
        except SlackApiError as e:
            err = e.response['error']
            self.log_delivery(member, 'AUTH_CODE', message_text, False, err, cycle)
            return False, err

    def send_reminder_dm(self, reviewer, unsubmitted_reviewees, cycle=None):
        """미작성 동료 명단이 명시된 독촉 Slack DM 전송"""
        reviewee_names = ", ".join([r.name for r in unsubmitted_reviewees])
        site_url = getattr(settings, 'SITE_URL', 'http://127.0.0.1:8000').rstrip('/')
        login_url = f"{site_url}/login"

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

        target_channel = self.get_or_create_dm_channel(reviewer)

        try:
            self.client.chat_postMessage(channel=target_channel, text=message_text)
            self.log_delivery(reviewer, 'REMINDER', message_text, True, "", cycle)
            return True, "Reminder DM sent successfully"
        except SlackApiError as e:
            err = e.response['error']
            self.log_delivery(reviewer, 'REMINDER', message_text, False, err, cycle)
            return False, err

    def send_failed_reminders_retry(self, member, message_text, cycle=None):
        """실패했던 DM 건에 대한 1클릭 재발송 처리"""
        if self.mock_mode:
            self.log_delivery(member, 'REMINDER', message_text, True, "Mock Retry Sent", cycle)
            return True, "Mock Retry DM sent"

        target_channel = self.get_or_create_dm_channel(member)

        try:
            self.client.chat_postMessage(channel=target_channel, text=message_text)
            self.log_delivery(member, 'REMINDER', message_text, True, "", cycle)
            return True, "Retry DM sent"
        except SlackApiError as e:
            err = e.response['error']
            self.log_delivery(member, 'REMINDER', message_text, False, err, cycle)
            return False, err

    def send_custom_dm(self, member, text, cycle=None):
        """특정 개별 메시지 DM 발송"""
        if self.mock_mode:
            self.log_delivery(member, 'CUSTOM_MSG', text, True, "Mock Custom DM Sent", cycle)
            return True, "Mock Custom DM Sent"

        target_channel = self.get_or_create_dm_channel(member)

        try:
            self.client.chat_postMessage(channel=target_channel, text=text)
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

        target_channel = self.get_or_create_dm_channel(member)

        try:
            response = self.client.files_upload_v2(
                channel=target_channel,
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

        target_channel = self.get_or_create_dm_channel(admin_member)

        try:
            if sample_pdf_path and os.path.exists(sample_pdf_path):
                self.client.files_upload_v2(
                    channel=target_channel,
                    file=sample_pdf_path,
                    title="[테스트] 샘플 피어리뷰 리포트.pdf",
                    initial_comment=test_text
                )
            else:
                self.client.chat_postMessage(channel=target_channel, text=test_text)

            self.log_delivery(admin_member, 'TEST_DM', test_text, True)
            return True, "Test DM Sent"
        except SlackApiError as e:
            err = e.response['error']
            self.log_delivery(admin_member, 'TEST_DM', test_text, False, err)
            return False, err
