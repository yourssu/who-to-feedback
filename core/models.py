from django.db import models
from django.utils import timezone
import random


class Member(models.Model):
    ROLE_CHOICES = [
        ('ADMIN', '관리자'),
        ('MEMBER', '일반 사용자'),
    ]

    name = models.CharField(max_length=50, verbose_name="이름")
    email = models.EmailField(unique=True, verbose_name="이메일")
    slack_user_id = models.CharField(max_length=50, verbose_name="Slack User ID")
    department = models.CharField(max_length=100, blank=True, null=True, verbose_name="소속 부서")
    role = models.CharField(max_length=10, choices=ROLE_CHOICES, default='MEMBER', verbose_name="권한 역할")
    normalized_name = models.CharField(max_length=50, blank=True, verbose_name="정규화된 이름")
    created_at = models.DateTimeField(default=timezone.now, verbose_name="생성일시")

    class Meta:
        verbose_name = "팀원"
        verbose_name_plural = "팀원 목록"
        ordering = ['name']

    def __str__(self):
        dept_str = f" ({self.department})" if self.department else ""
        return f"{self.name}{dept_str} - {self.email}"


class ReviewCycle(models.Model):
    STATUS_CHOICES = [
        ('DRAFT', '초안 (DRAFT)'),
        ('ACTIVE', '진행 중 (ACTIVE)'),
        ('COMPLETED', '작성 완료 (COMPLETED)'),
        ('CLOSED', '종료 및 배포 (CLOSED)'),
    ]

    title = models.CharField(max_length=200, verbose_name="피어리뷰 회차명")
    start_at = models.DateTimeField(verbose_name="시작 일시")
    end_at = models.DateTimeField(verbose_name="마감 일시")
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='DRAFT', verbose_name="진행 상태")
    auto_reminder_enabled = models.BooleanField(default=True, verbose_name="자동 리마인더 활성화")
    auto_reminder_time = models.TimeField(default="10:00", verbose_name="자동 리마인더 시각")
    version = models.CharField(max_length=10, default="v1", verbose_name="템플릿/문항 버전")
    created_at = models.DateTimeField(default=timezone.now, verbose_name="생성일시")

    class Meta:
        verbose_name = "피어리뷰 회차"
        verbose_name_plural = "피어리뷰 회차 목록"
        ordering = ['-created_at']

    def __str__(self):
        return f"[{self.get_status_display()}] {self.title}"

    @property
    def total_assignments_count(self):
        return self.assignments.count()

    @property
    def submitted_assignments_count(self):
        return self.assignments.filter(is_submitted=True).count()

    @property
    def completion_rate(self):
        total = self.total_assignments_count
        if total == 0:
            return 0
        return int((self.submitted_assignments_count / total) * 100)

    @property
    def is_all_submitted(self):
        total = self.total_assignments_count
        return total > 0 and self.submitted_assignments_count == total

    @property
    def is_deadline_passed(self):
        return timezone.now() > self.end_at

    @property
    def is_question_locked(self):
        """피어리뷰가 시작(ACTIVE)되거나 완료된 이후에는 질문지 수정 불가"""
        return self.status != 'DRAFT'


class ReviewCycleVersionLog(models.Model):
    cycle = models.ForeignKey(ReviewCycle, on_delete=models.CASCADE, related_name='version_logs', verbose_name="리뷰 회차")
    version = models.CharField(max_length=10, verbose_name="버전")
    changed_summary = models.TextField(verbose_name="변경 이력 내용 (문항/템플릿)")
    created_at = models.DateTimeField(default=timezone.now, verbose_name="기록일시")

    class Meta:
        verbose_name = "회차 버전 변경 이력"
        verbose_name_plural = "회차 버전 변경 이력 목록"
        ordering = ['-created_at']


class ReviewQuestion(models.Model):
    TYPE_CHOICES = [
        ('RATING', '5점 척도 평가'),
        ('TEXT', '서술형 주관식'),
        ('SINGLE_CHOICE', '객관식 단일 선택'),
        ('MULTIPLE_CHOICE', '객관식 다중 선택 (태그)'),
    ]

    SCALE_CHOICES = [
        ('NUMERIC_5', '숫자형 척도 (1점 ~ 5점)'),
        ('TEXT_5', '텍스트 척도 (매우 아님 - 약간 아님 - 보통임 - 약간 그럼 - 매우 그럼)'),
    ]

    cycle = models.ForeignKey(ReviewCycle, on_delete=models.CASCADE, related_name='questions', verbose_name="리뷰 회차")
    order = models.PositiveIntegerField(default=1, verbose_name="순서")
    question_type = models.CharField(max_length=20, choices=TYPE_CHOICES, verbose_name="문항 유형")
    scale_type = models.CharField(max_length=20, choices=SCALE_CHOICES, default='NUMERIC_5', verbose_name="척도 라벨 유형")
    content = models.TextField(verbose_name="문항 내용/질문")

    class Meta:
        verbose_name = "리뷰 문항"
        verbose_name_plural = "리뷰 문항 목록"
        ordering = ['order']

    def __str__(self):
        return f"Q{self.order}. [{self.get_question_type_display()}] {self.content[:30]}"


class QuestionOption(models.Model):
    question = models.ForeignKey(ReviewQuestion, on_delete=models.CASCADE, related_name='options', verbose_name="질문")
    option_text = models.CharField(max_length=200, verbose_name="선택지 내용")
    order = models.PositiveIntegerField(default=1, verbose_name="순서")

    class Meta:
        verbose_name = "객관식 선택지"
        verbose_name_plural = "객관식 선택지 목록"
        ordering = ['order']

    def __str__(self):
        return f"{self.order}. {self.option_text}"


class ReviewAuthCode(models.Model):
    member = models.ForeignKey(Member, on_delete=models.CASCADE, related_name='auth_codes', verbose_name="팀원")
    cycle = models.ForeignKey(ReviewCycle, on_delete=models.CASCADE, related_name='auth_codes', verbose_name="리뷰 회차")
    code = models.CharField(max_length=6, verbose_name="6자리 PIN 코드")
    created_at = models.DateTimeField(default=timezone.now, verbose_name="생성일시")
    is_used = models.BooleanField(default=False, verbose_name="사용 여부")

    class Meta:
        verbose_name = "인증 코드"
        verbose_name_plural = "인증 코드 목록"

    @classmethod
    def generate_code_for(cls, member, cycle):
        code = f"{random.randint(100000, 999999)}"
        auth_code, _ = cls.objects.get_or_create(member=member, cycle=cycle, is_used=False)
        auth_code.code = code
        auth_code.save()
        return auth_code


class ReviewAssignment(models.Model):
    cycle = models.ForeignKey(ReviewCycle, on_delete=models.CASCADE, related_name='assignments', verbose_name="리뷰 회차")
    reviewer = models.ForeignKey(Member, on_delete=models.CASCADE, related_name='given_reviews', verbose_name="리뷰 작성자")
    reviewee = models.ForeignKey(Member, on_delete=models.CASCADE, related_name='received_reviews', verbose_name="리뷰 대상자")
    is_submitted = models.BooleanField(default=False, verbose_name="제출 여부")
    submitted_at = models.DateTimeField(null=True, blank=True, verbose_name="제출일시")
    last_reminded_at = models.DateTimeField(null=True, blank=True, verbose_name="마지막 리마인드 일시")
    draft_data = models.JSONField(null=True, blank=True, verbose_name="임시 저장 답변 데이터")
    draft_saved_at = models.DateTimeField(null=True, blank=True, verbose_name="임시 저장 일시")

    class Meta:
        verbose_name = "리뷰 매칭"
        verbose_name_plural = "리뷰 매칭 목록"
        unique_together = ['cycle', 'reviewer', 'reviewee']

    def __str__(self):
        return f"[{self.cycle.title}] {self.reviewer.name} ➡️ {self.reviewee.name}"


class ReviewAnswer(models.Model):
    assignment = models.ForeignKey(ReviewAssignment, on_delete=models.CASCADE, related_name='answers', verbose_name="리뷰 매칭")
    question = models.ForeignKey(ReviewQuestion, on_delete=models.CASCADE, related_name='answers', verbose_name="질문 문항")
    rating_value = models.IntegerField(null=True, blank=True, verbose_name="척도 점수 (1~5)")
    answer_text = models.TextField(null=True, blank=True, verbose_name="주관식 서술 답변")
    selected_options = models.ManyToManyField(QuestionOption, blank=True, verbose_name="선택된 객관식 옵션")
    is_excluded_from_report = models.BooleanField(default=False, verbose_name="응답 품질 필터로 인한 리포트 제외 여부")
    exclusion_reason = models.CharField(max_length=200, blank=True, verbose_name="제외 사유")

    class Meta:
        verbose_name = "리뷰 답변"
        verbose_name_plural = "리뷰 답변 목록"
        unique_together = ['assignment', 'question']


class ReviewReport(models.Model):
    VALIDATION_STATUS_CHOICES = [
        ('GENERATED', '생성 완료'),
        ('NEEDS_REVIEW', '검토 필요'),
        ('APPROVED', '승인 완료'),
        ('SENT', '발송 완료'),
        ('FAILED', '생성 실패'),
    ]

    cycle = models.ForeignKey(ReviewCycle, on_delete=models.CASCADE, related_name='reports', verbose_name="리뷰 회차")
    reviewee = models.ForeignKey(Member, on_delete=models.CASCADE, related_name='reports', verbose_name="리뷰 대상자")
    pdf_file = models.FileField(upload_to='reports_pdf/', null=True, blank=True, verbose_name="PDF 리포트 파일")
    ppt_file = models.FileField(upload_to='reports_ppt/', null=True, blank=True, verbose_name="PPT 리포트 파일")
    version = models.CharField(max_length=10, default="v1", verbose_name="리포트 템플릿 버전")
    validation_status = models.CharField(max_length=20, choices=VALIDATION_STATUS_CHOICES, default='NEEDS_REVIEW', verbose_name="검수 상태")
    admin_memo = models.TextField(blank=True, verbose_name="관리자 수정 메모/코멘트")
    layout_check_passed = models.BooleanField(default=True, verbose_name="자동 레이아웃 검수 통과 여부")
    layout_issue_notes = models.TextField(blank=True, verbose_name="레이아웃 검수 이슈 노트")
    error_log = models.TextField(blank=True, verbose_name="생성 오류 로그")
    created_at = models.DateTimeField(default=timezone.now, verbose_name="생성일시")
    is_sent = models.BooleanField(default=False, verbose_name="Slack DM 발송 여부")
    sent_at = models.DateTimeField(null=True, blank=True, verbose_name="발송일시")

    class Meta:
        verbose_name = "결과 리포트"
        verbose_name_plural = "결과 리포트 목록"
        unique_together = ['cycle', 'reviewee']

    def __str__(self):
        return f"[{self.cycle.title}] {self.reviewee.name} 리포트"


class DataValidationLog(models.Model):
    cycle = models.ForeignKey(ReviewCycle, on_delete=models.CASCADE, related_name='validation_logs', verbose_name="리뷰 회차")
    row_index = models.IntegerField(verbose_name="엑셀 행 번호")
    issue_type = models.CharField(max_length=50, verbose_name="오류/검증 유형")
    current_value = models.TextField(blank=True, verbose_name="현재 입력 값")
    is_resolved = models.BooleanField(default=False, verbose_name="해결 여부")
    created_at = models.DateTimeField(default=timezone.now, verbose_name="기록일시")

    class Meta:
        verbose_name = "데이터 검증 로그"
        verbose_name_plural = "데이터 검증 로그 목록"


class SlackDeliveryLog(models.Model):
    DELIVERY_TYPE_CHOICES = [
        ('AUTH_CODE', '인증 핀코드 DM'),
        ('REMINDER', '미작성자 독촉 DM'),
        ('REPORT', 'PDF 결과 리포트 DM'),
        ('CUSTOM_MSG', '커스텀 알림 DM'),
        ('TEST_DM', '테스트 DM'),
    ]

    cycle = models.ForeignKey(ReviewCycle, on_delete=models.CASCADE, related_name='delivery_logs', null=True, blank=True, verbose_name="리뷰 회차")
    member = models.ForeignKey(Member, on_delete=models.CASCADE, related_name='delivery_logs', verbose_name="수신 팀원")
    delivery_type = models.CharField(max_length=20, choices=DELIVERY_TYPE_CHOICES, verbose_name="발송 메시지 종류")
    message_content = models.TextField(blank=True, verbose_name="메시지 내용")
    is_success = models.BooleanField(default=False, verbose_name="성공 여부")
    error_message = models.TextField(blank=True, verbose_name="실패 오류 메시지")
    sent_at = models.DateTimeField(default=timezone.now, verbose_name="발송일시")

    class Meta:
        verbose_name = "Slack 발송 로그"
        verbose_name_plural = "Slack 발송 로그 목록"
        ordering = ['-sent_at']

    def __str__(self):
        status_str = "성공" if self.is_success else "실패"
        return f"[{self.get_delivery_type_display()}] {self.member.name} - {status_str}"
