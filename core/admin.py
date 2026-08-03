from django.contrib import admin
from django.shortcuts import redirect
from django.utils import timezone
from django.utils.html import format_html
from django.utils.safestring import mark_safe

from core.models import (
    Member, ReviewCycle, ReviewQuestion, QuestionOption,
    ReviewAuthCode, ReviewAssignment, ReviewAnswer, ReviewReport
)
from core.services.slack_service import SlackService
from core.services.report_service import PDFReportService



@admin.register(Member)
class MemberAdmin(admin.ModelAdmin):
    list_display = ['id', 'name', 'email', 'slack_user_id', 'department']
    search_fields = ['name', 'email', 'slack_user_id', 'department']
    list_filter = ['department']


class QuestionOptionInline(admin.TabularInline):
    model = QuestionOption
    extra = 2


@admin.register(ReviewQuestion)
class ReviewQuestionAdmin(admin.ModelAdmin):
    list_display = ['id', 'cycle', 'order', 'question_type', 'content']
    list_filter = ['cycle', 'question_type']
    inlines = [QuestionOptionInline]


class ReviewQuestionInline(admin.StackedInline):
    model = ReviewQuestion
    extra = 1


@admin.register(ReviewCycle)
class ReviewCycleAdmin(admin.ModelAdmin):
    list_display = ['id', 'title', 'status', 'start_at', 'end_at', 'completion_rate_display', 'admin_actions']
    list_filter = ['status']
    inlines = [ReviewQuestionInline]

    actions = ['start_review_cycle_action', 'generate_reports_action', 'send_reminders_action']

    def completion_rate_display(self, obj):
        return f"{obj.completion_rate}% ({obj.submitted_assignments_count}/{obj.total_assignments_count})"
    completion_rate_display.short_description = "제출 완료율"

    def admin_actions(self, obj):
        if obj.status == 'DRAFT':
            return mark_safe('<span style="color: gray;">피어리뷰 시작 전</span>')
        elif obj.status in ['COMPLETED', 'CLOSED']:
            return format_html(
                '<a class="button" href="/admin-panel/review-cycles/{}/preview/" style="background: #4F46E5; color: white;">🔍 리포트 검토 대시보드</a>',
                obj.id
            )
        else:
            return format_html(
                '<a class="button" href="/admin-panel/review-cycles/{}/preview/" style="background: #6B7280; color: white;">검토 대시보드</a>',
                obj.id
            )
    admin_actions.short_description = "검토 & 관리"

    @admin.action(description="🚀 선택한 피어리뷰 회차 시작 (인증코드 생성 및 Slack DM 일괄 전송)")
    def start_review_cycle_action(self, request, queryset):
        slack = SlackService()
        for cycle in queryset:
            cycle.status = 'ACTIVE'
            cycle.save()

            reviewers = Member.objects.filter(given_reviews__cycle=cycle).distinct()
            sent_count = 0

            for reviewer in reviewers:
                # 인증코드 생성
                auth_code = ReviewAuthCode.generate_code_for(reviewer, cycle)
                # Slack DM 발송
                success, _ = slack.send_auth_code_dm(reviewer, auth_code.code)
                if success:
                    sent_count += 1

            self.message_user(request, f"[{cycle.title}] 회차가 시작되었습니다. 총 {sent_count}명의 리뷰어에게 인증코드 Slack DM이 발송되었습니다.")

    @admin.action(description="⏰ 선택한 회차 미작성자에게 Slack DM 독촉/리마인더 전송")
    def send_reminders_action(self, request, queryset):
        slack = SlackService()
        for cycle in queryset:
            unsubmitted_assignments = cycle.assignments.filter(is_submitted=False)
            # 리뷰어별로 그룹핑
            reviewers = set(a.reviewer for a in unsubmitted_assignments)
            sent_count = 0

            for r in reviewers:
                unsubmitted_reviewees = [a.reviewee for a in unsubmitted_assignments if a.reviewer == r]
                success, _ = slack.send_reminder_dm(r, unsubmitted_reviewees)
                if success:
                    sent_count += 1

            self.message_user(request, f"[{cycle.title}] 회차 미작성자 {sent_count}명에게 독촉 Slack DM(미작성 동료 명단 포함)을 전송했습니다.")

    @admin.action(description="📄 선택한 회차 100%% 제출 검증 및 PDF 리포트 생성")
    def generate_reports_action(self, request, queryset):
        for cycle in queryset:
            if not cycle.is_all_submitted:
                self.message_user(request, f"[{cycle.title}] 회차는 아직 전원 제출되지 않았습니다 (완료율: {cycle.completion_rate}%). 모든 리뷰어가 작성을 마쳐야 합니다.", level='warning')
                continue

            cycle.status = 'COMPLETED'
            cycle.save()
            reports = PDFReportService.generate_all_reports_for_cycle(cycle)
            self.message_user(request, f"[{cycle.title}] 회차에 대해 총 {len(reports)}건의 PDF 리포트가 성공적으로 생성되었습니다! 검토 대시보드에서 확인하세요.")


@admin.register(ReviewAssignment)
class ReviewAssignmentAdmin(admin.ModelAdmin):
    list_display = ['id', 'cycle', 'reviewer', 'reviewee', 'is_submitted', 'submitted_at', 'last_reminded_at']
    list_filter = ['cycle', 'is_submitted']
    search_fields = ['reviewer__name', 'reviewee__name']


@admin.register(ReviewAuthCode)
class ReviewAuthCodeAdmin(admin.ModelAdmin):
    list_display = ['id', 'member', 'cycle', 'code', 'created_at', 'is_used']
    list_filter = ['cycle', 'is_used']


@admin.register(ReviewAnswer)
class ReviewAnswerAdmin(admin.ModelAdmin):
    list_display = ['id', 'assignment', 'question', 'rating_value', 'answer_text_short']

    def answer_text_short(self, obj):
        return obj.answer_text[:30] if obj.answer_text else "-"


@admin.register(ReviewReport)
class ReviewReportAdmin(admin.ModelAdmin):
    list_display = ['id', 'cycle', 'reviewee', 'created_at', 'is_sent', 'sent_at']
    list_filter = ['cycle', 'is_sent']
