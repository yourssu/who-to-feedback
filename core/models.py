import random
import string
from django.db import models
from django.utils import timezone


class Member(models.Model):
    name = models.CharField(max_length=50, verbose_name="이름")
    email = models.EmailField(unique=True, verbose_name="이메일")
    slack_user_id = models.CharField(max_length=50, verbose_name="Slack Member ID", help_text="e.g. U12345678")
    department = models.CharField(max_length=50, blank=True, verbose_name="소속 부서")

    class Meta:
        verbose_name = "팀원"
        verbose_name_plural = "팀원 목록"
        ordering = ['name']

    def __str__(self):
        return f"{self.name} ({self.department or '무소속'})"


class ReviewCycle(models.Model):
    STATUS_CHOICES = [
        ('DRAFT', '초안'),
        ('ACTIVE', '진행 중'),
        ('COMPLETED', '작성 완료 (검토 대기)'),
        ('CLOSED', '배포 및 마감 완료'),
    ]

    title = models.CharField(max_length=100, verbose_name="회차 제목")
    start_at = models.DateTimeField(verbose_name="시작 일시")
    end_at = models.DateTimeField(verbose_name="마감 일시")
    status = models.CharField(max_length=15, choices=STATUS_CHOICES, default='DRAFT', verbose_name="상태")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "리뷰 회차"
        verbose_name_plural = "리뷰 회차 목록"
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.title} [{self.get_status_display()}]"

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
        ordering = ['cycle', 'order']

    def __str__(self):
        return f"[{self.get_question_type_display()}] Q{self.order}. {self.content[:30]}"


class QuestionOption(models.Model):
    question = models.ForeignKey(ReviewQuestion, on_delete=models.CASCADE, related_name='options', verbose_name="문항")
    option_text = models.CharField(max_length=200, verbose_name="선택지 내용")
    order = models.PositiveIntegerField(default=1, verbose_name="순서")

    class Meta:
        verbose_name = "객관식 선택지"
        verbose_name_plural = "객관식 선택지 목록"
        ordering = ['order']

    def __str__(self):
        return self.option_text


class ReviewAuthCode(models.Model):
    member = models.ForeignKey(Member, on_delete=models.CASCADE, verbose_name="팀원")
    cycle = models.ForeignKey(ReviewCycle, on_delete=models.CASCADE, verbose_name="리뷰 회차")
    code = models.CharField(max_length=6, verbose_name="인증 핀코드")
    created_at = models.DateTimeField(auto_now_add=True)
    is_used = models.BooleanField(default=False, verbose_name="사용 여부")

    class Meta:
        verbose_name = "로그인 인증코드"
        verbose_name_plural = "로그인 인증코드 목록"
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.member.name} - Code: {self.code}"

    @classmethod
    def generate_code_for(cls, member, cycle):
        # 6자리 난수 번호 생성
        code = ''.join(random.choices(string.digits, k=6))
        return cls.objects.create(member=member, cycle=cycle, code=code)


class ReviewAssignment(models.Model):
    cycle = models.ForeignKey(ReviewCycle, on_delete=models.CASCADE, related_name='assignments', verbose_name="리뷰 회차")
    reviewer = models.ForeignKey(Member, on_delete=models.CASCADE, related_name='given_reviews', verbose_name="리뷰 작성자 (Reviewer)")
    reviewee = models.ForeignKey(Member, on_delete=models.CASCADE, related_name='received_reviews', verbose_name="리뷰 대상자 (Reviewee)")
    is_submitted = models.BooleanField(default=False, verbose_name="제출 완료 여부")
    submitted_at = models.DateTimeField(null=True, blank=True, verbose_name="제출 일시")
    last_reminded_at = models.DateTimeField(null=True, blank=True, verbose_name="마지막 Slack 리마인드 일시")

    class Meta:
        verbose_name = "리뷰 매칭"
        verbose_name_plural = "리뷰 매칭 목록"
        unique_together = ('cycle', 'reviewer', 'reviewee')
        ordering = ['cycle', 'reviewer', 'reviewee']

    def __str__(self):
        status_str = "제출완료" if self.is_submitted else "미제출"
        return f"[{status_str}] {self.reviewer.name} -> {self.reviewee.name}"


class ReviewAnswer(models.Model):
    assignment = models.ForeignKey(ReviewAssignment, on_delete=models.CASCADE, related_name='answers', verbose_name="리뷰 매칭")
    question = models.ForeignKey(ReviewQuestion, on_delete=models.CASCADE, verbose_name="문항")
    rating_value = models.IntegerField(null=True, blank=True, verbose_name="점수 (1~5)")
    answer_text = models.TextField(blank=True, verbose_name="주관식 답변")
    selected_options = models.ManyToManyField(QuestionOption, blank=True, verbose_name="선택한 객관식 옵션")

    class Meta:
        verbose_name = "리뷰 답변"
        verbose_name_plural = "리뷰 답변 목록"
        unique_together = ('assignment', 'question')

    def __str__(self):
        return f"Answer for Q{self.question.order} by {self.assignment.reviewer.name}"


class ReviewReport(models.Model):
    cycle = models.ForeignKey(ReviewCycle, on_delete=models.CASCADE, related_name='reports', verbose_name="리뷰 회차")
    reviewee = models.ForeignKey(Member, on_delete=models.CASCADE, related_name='generated_reports', verbose_name="피어리뷰 대상자")
    pdf_file = models.FileField(upload_to='reports_pdf/', verbose_name="PDF 리포트 파일")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="생성 일시")
    is_sent = models.BooleanField(default=False, verbose_name="Slack DM 전송 완료 여부")
    sent_at = models.DateTimeField(null=True, blank=True, verbose_name="Slack DM 전송 일시")

    class Meta:
        verbose_name = "피어리뷰 결과 리포트"
        verbose_name_plural = "피어리뷰 결과 리포트 목록"
        unique_together = ('cycle', 'reviewee')
        ordering = ['-created_at']

    def __str__(self):
        sent_str = "발송완료" if self.is_sent else "검토대기"
        return f"[{sent_str}] {self.reviewee.name} - {self.cycle.title} 리포트"
