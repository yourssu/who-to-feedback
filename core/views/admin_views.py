from django.shortcuts import render, redirect, get_object_or_404
from django.contrib import messages
from django.utils import timezone
from django.db import IntegrityError
from django.contrib.auth.decorators import user_passes_test
from django.http import JsonResponse, HttpResponse
import os

from core.models import (
    Member, ReviewCycle, ReviewQuestion, QuestionOption,
    ReviewAssignment, ReviewAuthCode, ReviewReport, DataValidationLog, SlackDeliveryLog,
    ReviewCycleVersionLog
)
from core.services.slack_service import SlackService
from core.services.pdf_service import PDFReportService
from core.services.ppt_service import PPTReportService
from core.services.validation_service import DataValidationService
from core.services.layout_service import LayoutCheckService
from core.services.report_service import ReportManagementService


def superuser_required(view_func):
    """superuser 계정으로 로그인한 관리자만 커스텀 관리자 페이지에 접근 가능"""
    return user_passes_test(
        lambda u: u.is_authenticated and u.is_superuser,
        login_url='/admin/login/'
    )(view_func)


# ==========================================
# 0. 관리자 메인 대시보드 (a-overview)
# ==========================================
@superuser_required
def admin_dashboard(request):
    cycles = ReviewCycle.objects.all()
    cycles_data = []

    for c in cycles:
        unsubmitted_assignments = c.assignments.filter(is_submitted=False).select_related('reviewer', 'reviewee')
        unsubmitted_map = {}
        for a in unsubmitted_assignments:
            if a.reviewer not in unsubmitted_map:
                unsubmitted_map[a.reviewer] = []
            unsubmitted_map[a.reviewer].append(a.reviewee)

        unsubmitted_info = []
        for reviewer, reviewees in unsubmitted_map.items():
            unsubmitted_info.append({
                'reviewer': reviewer,
                'unsubmitted_reviewees': reviewees,
            })

        completed_reports_count = c.reports.filter(validation_status='APPROVED').count()
        failed_reports_count = c.reports.filter(validation_status='FAILED').count()

        cycles_data.append({
            'cycle': c,
            'unsubmitted_info': unsubmitted_info,
            'unsubmitted_reviewers_count': len(unsubmitted_map),
            'completed_reports_count': completed_reports_count,
            'failed_reports_count': failed_reports_count,
        })

    return render(request, 'admin_custom/dashboard.html', {
        'cycles_data': cycles_data,
        'active_menu': 'dashboard',
    })


@superuser_required
def admin_create_cycle(request):
    if request.method == 'POST':
        title = request.POST.get('title')
        start_at = request.POST.get('start_at')
        end_at = request.POST.get('end_at')

        cycle = ReviewCycle.objects.create(
            title=title,
            start_at=start_at,
            end_at=end_at,
            status='DRAFT'
        )
        ReviewCycleVersionLog.objects.create(
            cycle=cycle,
            version=cycle.version,
            changed_summary=f"신규 피어리뷰 회차 '{cycle.title}' (버전: {cycle.version}) 생성됨."
        )

        messages.success(request, f"신규 피어리뷰 회차 '{cycle.title}'가 성공적으로 생성되었습니다!")
        return redirect('admin_questions', cycle_id=cycle.id)

    return redirect('admin_dashboard')


# ==========================================
# 1. PAGE 1: 팀원 관리 (a-members)
# ==========================================
@superuser_required
def admin_members(request):
    members = Member.objects.all()
    return render(request, 'admin_custom/members.html', {
        'members': members,
        'active_menu': 'members',
    })


@superuser_required
def admin_add_member(request):
    if request.method == 'POST':
        name = request.POST.get('name')
        email = request.POST.get('email')
        slack_user_id = request.POST.get('slack_user_id')
        department = request.POST.get('department', '')
        role = request.POST.get('role', 'MEMBER')

        try:
            member = Member.objects.create(
                name=name,
                email=email,
                slack_user_id=slack_user_id,
                department=department,
                role=role
            )
            messages.success(request, f"팀원 '{member.name}' 님이 성공적으로 추가되었습니다!")
        except IntegrityError:
            messages.error(request, "이미 존재하는 이메일입니다.")

    return redirect('admin_members')


@superuser_required
def admin_delete_member(request, member_id):
    if request.method == 'POST':
        member = get_object_or_404(Member, id=member_id)
        name = member.name
        member.delete()
        messages.info(request, f"팀원 '{name}' 님이 삭제되었습니다.")

    return redirect('admin_members')


# ==========================================
# 2. ⭐ PAGE 2: 데이터 검증 (a-validation)
# ==========================================
@superuser_required
def admin_validation(request, cycle_id=None):
    if cycle_id:
        cycle = get_object_or_404(ReviewCycle, id=cycle_id)
    else:
        cycle = ReviewCycle.objects.first()

    logs = DataValidationLog.objects.filter(cycle=cycle) if cycle else []
    suggestions = DataValidationService.get_normalization_suggestions(cycle) if cycle else []

    return render(request, 'admin_custom/validation.html', {
        'cycle': cycle,
        'logs': logs,
        'suggestions': suggestions,
        'active_menu': 'validation',
    })


@superuser_required
def admin_upload_excel(request, cycle_id):
    if request.method == 'POST' and request.FILES.get('excel_file'):
        cycle = get_object_or_404(ReviewCycle, id=cycle_id)
        excel_file = request.FILES['excel_file']
        logs = DataValidationService.validate_excel_data(excel_file, cycle)
        messages.success(request, f"엑셀 사전 검증 완료! 총 {len(logs)}건의 입력 이슈(이름 누락, 중복/대소문자 불일치, 팀/역할 누락)가 감지되었습니다.")
    return redirect('admin_validation')


@superuser_required
def admin_apply_normalization(request):
    if request.method == 'POST':
        cycle_id = request.POST.get('cycle_id')
        raw_names = request.POST.getlist('raw_names')
        target_name = request.POST.get('target_name')

        if raw_names and target_name:
            cycle = get_object_or_404(ReviewCycle, id=cycle_id)
            count = DataValidationService.apply_normalization(cycle, raw_names, target_name)
            messages.success(request, f"총 {count}명의 이름이 '{target_name}'로 정규화 병합되었습니다!")

    return redirect('admin_validation')


# ==========================================
# 3. PAGE 3: 질문지 제작 (a-questions - 잠금 기능)
# ==========================================
@superuser_required
def admin_questions(request, cycle_id):
    cycle = get_object_or_404(ReviewCycle, id=cycle_id)
    questions = cycle.questions.all().order_by('order')

    return render(request, 'admin_custom/questions.html', {
        'cycle': cycle,
        'questions': questions,
        'active_menu': 'dashboard',
    })


@superuser_required
def admin_add_question(request, cycle_id):
    if request.method == 'POST':
        cycle = get_object_or_404(ReviewCycle, id=cycle_id)

        if cycle.is_question_locked:
            messages.error(request, "피어리뷰가 이미 시작(ACTIVE)되거나 완료된 상태에서는 질문 문항을 추가할 수 없습니다.")
            return redirect('admin_questions', cycle_id=cycle_id)

        order = request.POST.get('order', 1)
        question_type = request.POST.get('question_type')
        scale_type = request.POST.get('scale_type', 'NUMERIC_5')
        content = request.POST.get('content')

        ReviewQuestion.objects.create(
            cycle=cycle,
            order=order,
            question_type=question_type,
            scale_type=scale_type,
            content=content
        )
        messages.success(request, "신규 질문 문항이 추가되었습니다.")

    return redirect('admin_questions', cycle_id=cycle_id)


@superuser_required
def admin_delete_question(request, question_id):
    if request.method == 'POST':
        question = get_object_or_404(ReviewQuestion, id=question_id)
        cycle = question.cycle

        if cycle.is_question_locked:
            messages.error(request, "피어리뷰가 시작(ACTIVE)된 이후에는 질문 문항을 삭제할 수 없습니다.")
            return redirect('admin_questions', cycle_id=cycle.id)

        cycle_id = cycle.id
        question.delete()
        messages.info(request, "질문 문항이 삭제되었습니다.")
        return redirect('admin_questions', cycle_id=cycle_id)

    return redirect('admin_dashboard')


@superuser_required
def admin_add_option(request, question_id):
    if request.method == 'POST':
        question = get_object_or_404(ReviewQuestion, id=question_id)
        cycle = question.cycle

        if cycle.is_question_locked:
            messages.error(request, "피어리뷰가 시작(ACTIVE)된 이후에는 선택지를 추가할 수 없습니다.")
            return redirect('admin_questions', cycle_id=cycle.id)

        option_text = request.POST.get('option_text')
        order = question.options.count() + 1

        QuestionOption.objects.create(
            question=question,
            option_text=option_text,
            order=order
        )
        messages.success(request, f"선택지 '{option_text}' 항목이 추가되었습니다.")
        return redirect('admin_questions', cycle_id=question.cycle.id)

    return redirect('admin_dashboard')


# ==========================================
# 4. PAGE 4: 피어리뷰 매칭 (a-assignments)
# ==========================================
@superuser_required
def admin_assignments(request, cycle_id):
    cycle = get_object_or_404(ReviewCycle, id=cycle_id)
    assignments = cycle.assignments.all().select_related('reviewer', 'reviewee')
    members = Member.objects.all()
    departments = Member.objects.values_list('department', flat=True).distinct()

    return render(request, 'admin_custom/assignments.html', {
        'cycle': cycle,
        'assignments': assignments,
        'members': members,
        'departments': [d for d in departments if d],
        'active_menu': 'dashboard',
    })


@superuser_required
def admin_add_assignment(request, cycle_id):
    if request.method == 'POST':
        cycle = get_object_or_404(ReviewCycle, id=cycle_id)
        reviewer_id = request.POST.get('reviewer_id')
        reviewee_id = request.POST.get('reviewee_id')

        if reviewer_id == reviewee_id:
            messages.error(request, "자기 자신을 리뷰어로 매칭할 수 없습니다.")
            return redirect('admin_assignments', cycle_id=cycle_id)

        reviewer = get_object_or_404(Member, id=reviewer_id)
        reviewee = get_object_or_404(Member, id=reviewee_id)

        try:
            assignment, created = ReviewAssignment.objects.get_or_create(
                cycle=cycle,
                reviewer=reviewer,
                reviewee=reviewee
            )
            if created:
                messages.success(request, f"'{reviewer.name} ➡️ {reviewee.name}' 매칭이 성공적으로 추가되었습니다.")

                if cycle.status == 'ACTIVE':
                    auth_code, _ = ReviewAuthCode.objects.get_or_create(member=reviewer, cycle=cycle, is_used=False)
                    if not auth_code.code:
                        auth_code = ReviewAuthCode.generate_code_for(reviewer, cycle)
                    slack = SlackService()
                    slack.send_auth_code_dm(reviewer, auth_code.code, cycle)
                    messages.info(request, f"진행 중인 회차이므로 '{reviewer.name}' 님에게 인증코드 Slack DM이 자동 발송되었습니다.")
            else:
                messages.warning(request, "이미 존재하는 매칭입니다.")
        except IntegrityError:
            messages.error(request, "매칭 생성 중 오류가 발생했습니다.")

    return redirect('admin_assignments', cycle_id=cycle_id)


@superuser_required
def admin_delete_assignment(request, assignment_id):
    if request.method == 'POST':
        assignment = get_object_or_404(ReviewAssignment, id=assignment_id)
        cycle_id = assignment.cycle.id
        info = f"{assignment.reviewer.name} ➡️ {assignment.reviewee.name}"
        assignment.delete()
        messages.info(request, f"'{info}' 매칭이 삭제되었습니다.")
        return redirect('admin_assignments', cycle_id=cycle_id)

    return redirect('admin_dashboard')


@superuser_required
def admin_auto_match(request, cycle_id):
    if request.method == 'POST':
        cycle = get_object_or_404(ReviewCycle, id=cycle_id)
        members = Member.objects.all()
        created_count = 0

        for r in members:
            for e in members:
                if r != e:
                    _, created = ReviewAssignment.objects.get_or_create(
                        cycle=cycle, reviewer=r, reviewee=e
                    )
                    if created:
                        created_count += 1

        messages.success(request, f"총 {created_count}건의 피어리뷰 매칭이 성공적으로 생성되었습니다!")
        return redirect('admin_assignments', cycle_id=cycle_id)

    return redirect('admin_dashboard')


# ==========================================
# 5. PAGE 5: 피어리뷰 진행 상태 (a-status)
# ==========================================
@superuser_required
def admin_status(request):
    cycles = ReviewCycle.objects.all()
    latest_cycle = cycles.first()
    if latest_cycle:
        return redirect('admin_status_detail', cycle_id=latest_cycle.id)

    return render(request, 'admin_custom/status.html', {
        'cycle': None,
        'reviewer_status': [],
        'active_menu': 'status',
    })


@superuser_required
def admin_status_detail(request, cycle_id):
    cycle = get_object_or_404(ReviewCycle, id=cycle_id)
    reviewers = Member.objects.filter(given_reviews__cycle=cycle).distinct()

    reviewer_status = []
    for r in reviewers:
        assignments = ReviewAssignment.objects.filter(cycle=cycle, reviewer=r)
        done_count = assignments.filter(is_submitted=True).count()
        unsubmitted_reviewees = [a.reviewee for a in assignments if not a.is_submitted]

        reviewer_status.append({
            'reviewer': r,
            'total_count': assignments.count(),
            'done_count': done_count,
            'is_all_done': (assignments.count() > 0 and done_count == assignments.count()),
            'unsubmitted_reviewees': unsubmitted_reviewees,
        })

    return render(request, 'admin_custom/status.html', {
        'cycle': cycle,
        'reviewer_status': reviewer_status,
        'active_menu': 'status',
    })


@superuser_required
def admin_start_cycle_action(request, cycle_id):
    if request.method == 'POST':
        cycle = get_object_or_404(ReviewCycle, id=cycle_id)
        cycle.status = 'ACTIVE'
        cycle.save()

        slack = SlackService()
        reviewers = Member.objects.filter(given_reviews__cycle=cycle).distinct()
        sent_count = 0

        for r in reviewers:
            auth_code = ReviewAuthCode.generate_code_for(r, cycle)
            success, _ = slack.send_auth_code_dm(r, auth_code.code, cycle)
            if success:
                sent_count += 1

        messages.success(request, f"[{cycle.title}] 회차가 시작되었습니다. 총 {sent_count}명의 리뷰어에게 인증코드 Slack DM이 발송되었습니다.")
        return redirect('admin_status_detail', cycle_id=cycle_id)

    return redirect('admin_status')


@superuser_required
def admin_send_reminder_action(request, cycle_id):
    if request.method == 'POST':
        cycle = get_object_or_404(ReviewCycle, id=cycle_id)
        unsubmitted = cycle.assignments.filter(is_submitted=False)

        reviewers = set(a.reviewer for a in unsubmitted)
        slack = SlackService()
        sent_count = 0

        for r in reviewers:
            unsubmitted_reviewees = [a.reviewee for a in unsubmitted if a.reviewer == r]
            success, _ = slack.send_reminder_dm(r, unsubmitted_reviewees, cycle)
            if success:
                sent_count += 1
                cycle.assignments.filter(reviewer=r, is_submitted=False).update(last_reminded_at=timezone.now())

        messages.success(request, f"미작성자 {sent_count}명에게 독촉 Slack DM (미작성 동료 목록 포함)을 전송했습니다.")
        return redirect('admin_status_detail', cycle_id=cycle_id)

    return redirect('admin_status')


@superuser_required
def admin_generate_reports_action(request, cycle_id):
    if request.method == 'POST':
        cycle = get_object_or_404(ReviewCycle, id=cycle_id)

        if not cycle.is_all_submitted:
            messages.warning(request, f"아직 전원 제출되지 않았습니다 (완료율: {cycle.completion_rate}%). 모든 리뷰어가 작성을 마쳐야 합니다.")
            return redirect('admin_status_detail', cycle_id=cycle_id)

        cycle.status = 'COMPLETED'
        cycle.save()
        pdf_reports = PDFReportService.generate_all_reports_for_cycle(cycle)

        reviewees = set(a.reviewee for a in cycle.assignments.all())
        for rev in reviewees:
            PPTReportService.generate_ppt_report(cycle, rev)
            LayoutCheckService.check_layout_overflow(cycle, rev)

        messages.success(request, f"총 {len(pdf_reports)}건의 PDF/PPT 리포트 및 자동 레이아웃 검수가 완료되었습니다!")
        return redirect('admin_reports', cycle_id=cycle_id)

    return redirect('admin_status')


# ==========================================
# 6. ⭐ PAGE 6: 리포트 검토 & PPT/버전 관리 (a-reports)
# ==========================================
@superuser_required
def admin_reports(request, cycle_id):
    cycle = get_object_or_404(ReviewCycle, id=cycle_id)

    if cycle.is_all_submitted and not cycle.reports.exists():
        PDFReportService.generate_all_reports_for_cycle(cycle)
        reviewees = set(a.reviewee for a in cycle.assignments.all())
        for rev in reviewees:
            PPTReportService.generate_ppt_report(cycle, rev)
            LayoutCheckService.check_layout_overflow(cycle, rev)
        if cycle.status == 'ACTIVE':
            cycle.status = 'COMPLETED'
            cycle.save()

    reports = cycle.reports.all().select_related('reviewee')
    reports_data = []

    for r in reports:
        preview_data = PDFReportService.compile_feedback_data(cycle, r.reviewee)
        reports_data.append({
            'report_id': r.id,
            'reviewee': r.reviewee,
            'pdf_file': r.pdf_file,
            'ppt_file': r.ppt_file,
            'is_sent': r.is_sent,
            'validation_status': r.get_validation_status_display(),
            'admin_memo': r.admin_memo,
            'layout_check_passed': r.layout_check_passed,
            'layout_issue_notes': r.layout_issue_notes,
            'version': r.version,
            'error_log': r.error_log,
            'created_at': r.created_at,
            'preview_data': preview_data,
        })

    return render(request, 'admin_custom/reports.html', {
        'cycle': cycle,
        'reports': reports_data,
        'active_menu': 'dashboard',
    })


@superuser_required
def admin_save_report_memo(request, report_id):
    """리포트 검토 코멘트/수정 메모 저장 API"""
    if request.method == 'POST':
        report = get_object_or_404(ReviewReport, id=report_id)
        memo = request.POST.get('admin_memo', '').strip()
        report.admin_memo = memo
        report.save()
        messages.success(request, f"'{report.reviewee.name}' 님 리포트에 관리자 메모가 저장되었습니다.")
        return redirect('admin_reports', cycle_id=report.cycle.id)

    return redirect('admin_dashboard')


@superuser_required
def admin_generate_sample_reports(request, cycle_id):
    """실제 발송 전 샘플 2~3명 리포트 테스트 모드 전용 생성"""
    if request.method == 'POST':
        cycle = get_object_or_404(ReviewCycle, id=cycle_id)
        reports = ReportManagementService.generate_sample_reports(cycle, sample_count=3)
        messages.success(request, f"샘플 {len(reports)}명에 대한 테스트 리포트(PDF/PPT)가 성공적으로 생성되었습니다!")
        return redirect('admin_reports', cycle_id=cycle_id)

    return redirect('admin_dashboard')


@superuser_required
def admin_run_layout_check(request, cycle_id):
    """자동 레이아웃 검수 일괄 실행"""
    if request.method == 'POST':
        cycle = get_object_or_404(ReviewCycle, id=cycle_id)
        reviewees = set(a.reviewee for a in cycle.assignments.all())

        passed_count = 0
        for rev in reviewees:
            rep = LayoutCheckService.check_layout_overflow(cycle, rev)
            if rep.layout_check_passed:
                passed_count += 1

        messages.success(request, f"자동 레이아웃 검수 완료! (총 {len(reviewees)}명 중 {passed_count}명 통과)")
        return redirect('admin_reports', cycle_id=cycle_id)

    return redirect('admin_dashboard')


@superuser_required
def admin_regenerate_report(request, report_id):
    """1클릭 개별 리포트(PDF/PPT) 재시도 및 재생성"""
    if request.method == 'POST':
        report = get_object_or_404(ReviewReport, id=report_id)
        PDFReportService.generate_pdf_report(report.cycle, report.reviewee)
        PPTReportService.generate_ppt_report(report.cycle, report.reviewee)
        LayoutCheckService.check_layout_overflow(report.cycle, report.reviewee)
        messages.success(request, f"'{report.reviewee.name}' 님의 리포트(PDF/PPT)가 재생성 되었습니다.")
        return redirect('admin_reports', cycle_id=report.cycle.id)

    return redirect('admin_dashboard')


@superuser_required
def admin_publish_reports_action(request, cycle_id):
    if request.method == 'POST':
        cycle = get_object_or_404(ReviewCycle, id=cycle_id)
        reports = cycle.reports.all()

        slack = SlackService()
        sent_count = 0

        for r in reports:
            if r.pdf_file and r.pdf_file.name and not r.is_sent:
                success, _ = slack.send_pdf_report_dm(
                    member=r.reviewee,
                    pdf_file_path=r.pdf_file.path,
                    cycle_title=cycle.title,
                    cycle=cycle
                )
                if success:
                    r.is_sent = True
                    r.sent_at = timezone.now()
                    r.save()
                    sent_count += 1

        cycle.status = 'CLOSED'
        cycle.save()

        messages.success(request, f"총 {sent_count}명의 피어리뷰 대상자에게 Slack DM으로 PDF 리포트 발송이 최종 배포되었습니다!")
        return redirect('admin_reports', cycle_id=cycle_id)

    return redirect('admin_dashboard')


# ==========================================
# 7. PAGE 7: Slack DM 전송, 발송 체크리스트 & 테스트 DM (a-messages)
# ==========================================
@superuser_required
def admin_send_message(request):
    members = Member.objects.all()
    failed_logs = SlackDeliveryLog.objects.filter(is_success=False)

    if request.method == 'POST':
        recipient_type = request.POST.get('recipient_type')
        message_text = request.POST.get('message_text', '').strip()
        slack = SlackService()
        sent_count = 0

        if recipient_type == 'ALL':
            target_members = members
        else:
            member_id = request.POST.get('member_id')
            target_members = Member.objects.filter(id=member_id)

        for m in target_members:
            success, _ = slack.send_custom_dm(m, message_text)
            if success:
                sent_count += 1

        messages.success(request, f"총 {sent_count}명의 팀원에게 Slack DM 메시지를 전송했습니다!")
        return redirect('admin_send_message')

    return render(request, 'admin_custom/send_message.html', {
        'members': members,
        'failed_logs': failed_logs,
        'active_menu': 'messages',
    })


@superuser_required
def admin_delivery_checklist(request, cycle_id):
    """발송 전 이름 / 팀 / Slack ID / PDF 존재 여부 / 승인 여부 체크리스트"""
    cycle = get_object_or_404(ReviewCycle, id=cycle_id)
    checklist = ReportManagementService.get_delivery_checklist(cycle)

    return render(request, 'admin_custom/reports.html', {
        'cycle': cycle,
        'checklist': checklist,
        'active_menu': 'dashboard',
    })


@superuser_required
def admin_cycle_history(request, cycle_id):
    """문항 및 템플릿 버전(v1 -> v2) 변경 이력 비교 조회"""
    cycle = get_object_or_404(ReviewCycle, id=cycle_id)
    version_logs = cycle.version_logs.all()

    return render(request, 'admin_custom/dashboard.html', {
        'cycle': cycle,
        'version_logs': version_logs,
        'active_menu': 'dashboard',
    })


@superuser_required
def admin_retry_failed_messages(request):
    """실패했던 Slack DM 건 1클릭 전원 재발송"""
    if request.method == 'POST':
        failed_logs = SlackDeliveryLog.objects.filter(is_success=False)
        slack = SlackService()
        retried_count = 0

        for log in failed_logs:
            success, _ = slack.send_failed_reminders_retry(log.member, log.message_content, log.cycle)
            if success:
                log.is_success = True
                log.save()
                retried_count += 1

        messages.success(request, f"실패했던 {retried_count}건의 Slack DM에 대해 재발송을 완료했습니다!")
    return redirect('admin_send_message')


@superuser_required
def admin_send_test_dm(request):
    """전체 발송 전 관리자 본인에게 테스트 DM 전송"""
    if request.method == 'POST':
        slack = SlackService()
        admin_member = Member.objects.filter(email=request.user.email).first()
        if not admin_member:
            admin_member = Member.objects.filter(role='ADMIN').first() or Member.objects.first()

        if admin_member:
            success, _ = slack.send_test_dm(admin_member)
            if success:
                messages.success(request, f"관리자 '{admin_member.name}' 님의 Slack DM으로 테스트 메시지가 발송되었습니다!")
            else:
                messages.error(request, "테스트 DM 발송에 실패했습니다.")

    return redirect('admin_send_message')
