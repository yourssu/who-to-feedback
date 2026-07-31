from django.shortcuts import render, redirect, get_object_or_404
from django.contrib import messages
from django.utils import timezone
from django.db import IntegrityError

from core.models import (
    Member, ReviewCycle, ReviewQuestion, QuestionOption,
    ReviewAssignment, ReviewAuthCode, ReviewReport
)
from core.services.slack_service import SlackService
from core.services.pdf_service import PDFReportService


# ==========================================
# 0. 관리자 메인 대시보드
# ==========================================
def admin_dashboard(request):
    cycles = ReviewCycle.objects.all()
    return render(request, 'admin_custom/dashboard.html', {
        'cycles': cycles,
        'active_menu': 'dashboard',
    })


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
        messages.success(request, f"신규 피어리뷰 회차 '{cycle.title}'가 성공적으로 생성되었습니다!")
        return redirect('admin_questions', cycle_id=cycle.id)

    return redirect('admin_dashboard')


# ==========================================
# 1. PAGE 1: 팀원 관리
# ==========================================
def admin_members(request):
    members = Member.objects.all()
    return render(request, 'admin_custom/members.html', {
        'members': members,
        'active_menu': 'members',
    })


def admin_add_member(request):
    if request.method == 'POST':
        name = request.POST.get('name')
        email = request.POST.get('email')
        slack_user_id = request.POST.get('slack_user_id')
        department = request.POST.get('department', '')

        try:
            member = Member.objects.create(
                name=name,
                email=email,
                slack_user_id=slack_user_id,
                department=department
            )
            messages.success(request, f"팀원 '{member.name}' 님이 성공적으로 추가되었습니다!")
        except IntegrityError:
            messages.error(request, "이미 존재하는 이메일입니다.")

    return redirect('admin_members')


def admin_delete_member(request, member_id):
    if request.method == 'POST':
        member = get_object_or_404(Member, id=member_id)
        name = member.name
        member.delete()
        messages.info(request, f"팀원 '{name}' 님이 삭제되었습니다.")

    return redirect('admin_members')


# ==========================================
# 2. PAGE 2: 질문지 제작 페이지
# ==========================================
def admin_questions(request, cycle_id):
    cycle = get_object_or_404(ReviewCycle, id=cycle_id)
    questions = cycle.questions.all().order_by('order')

    return render(request, 'admin_custom/questions.html', {
        'cycle': cycle,
        'questions': questions,
        'active_menu': 'dashboard',
    })


def admin_add_question(request, cycle_id):
    if request.method == 'POST':
        cycle = get_object_or_404(ReviewCycle, id=cycle_id)
        order = request.POST.get('order', 1)
        question_type = request.POST.get('question_type')
        content = request.POST.get('content')

        ReviewQuestion.objects.create(
            cycle=cycle,
            order=order,
            question_type=question_type,
            content=content
        )
        messages.success(request, "신규 질문 문항이 추가되었습니다.")

    return redirect('admin_questions', cycle_id=cycle_id)


def admin_delete_question(request, question_id):
    if request.method == 'POST':
        question = get_object_or_404(ReviewQuestion, id=question_id)
        cycle_id = question.cycle.id
        question.delete()
        messages.info(request, "질문 문항이 삭제되었습니다.")
        return redirect('admin_questions', cycle_id=cycle_id)

    return redirect('admin_dashboard')


def admin_add_option(request, question_id):
    if request.method == 'POST':
        question = get_object_or_404(ReviewQuestion, id=question_id)
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
# 3. PAGE 3: 피어리뷰 매칭 페이지 (ACTIVE 진행 중 수정 지원)
# ==========================================
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


def admin_add_assignment(request, cycle_id):
    """
    매칭 추가
    - ACTIVE 진행 중인 상태에서 신규 리뷰어 매칭이 추가되면 인증코드 Slack DM 자동 전송
    """
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

                # 진행 중(ACTIVE) 상태라면 새로 추가된 리뷰어에게 인증코드 Slack DM 자동 전송
                if cycle.status == 'ACTIVE':
                    auth_code, _ = ReviewAuthCode.objects.get_or_create(member=reviewer, cycle=cycle, is_used=False)
                    if not auth_code.code:
                        auth_code = ReviewAuthCode.generate_code_for(reviewer, cycle)
                    slack = SlackService()
                    slack.send_auth_code_dm(reviewer, auth_code.code)
                    messages.info(request, f"진행 중인 회차이므로 '{reviewer.name}' 님에게 인증코드 Slack DM이 자동 발송되었습니다.")
            else:
                messages.warning(request, "이미 존재하는 매칭입니다.")
        except IntegrityError:
            messages.error(request, "매칭 생성 중 오류가 발생했습니다.")

    return redirect('admin_assignments', cycle_id=cycle_id)


def admin_delete_assignment(request, assignment_id):
    if request.method == 'POST':
        assignment = get_object_or_404(ReviewAssignment, id=assignment_id)
        cycle_id = assignment.cycle.id
        info = f"{assignment.reviewer.name} ➡️ {assignment.reviewee.name}"
        assignment.delete()
        messages.info(request, f"'{info}' 매칭이 삭제되었습니다.")
        return redirect('admin_assignments', cycle_id=cycle_id)

    return redirect('admin_dashboard')


def admin_auto_match(request, cycle_id):
    """팀 전체 360도 매칭 일괄 생성"""
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

        messages.success(request, f"총 {created_count}건의 360도 피어리뷰 매칭이 성공적으로 생성되었습니다!")
        return redirect('admin_assignments', cycle_id=cycle_id)

    return redirect('admin_dashboard')


# ==========================================
# 4. PAGE 4: 피어리뷰 진행 상태 대시보드
# ==========================================
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
            success, _ = slack.send_auth_code_dm(r, auth_code.code)
            if success:
                sent_count += 1

        messages.success(request, f"[{cycle.title}] 회차가 시작되었습니다. 총 {sent_count}명의 리뷰어에게 인증코드 Slack DM이 발송되었습니다.")
        return redirect('admin_status_detail', cycle_id=cycle_id)

    return redirect('admin_status')


def admin_send_reminder_action(request, cycle_id):
    if request.method == 'POST':
        cycle = get_object_or_404(ReviewCycle, id=cycle_id)
        unsubmitted = cycle.assignments.filter(is_submitted=False)

        reviewers = set(a.reviewer for a in unsubmitted)
        slack = SlackService()
        sent_count = 0

        for r in reviewers:
            unsubmitted_reviewees = [a.reviewee for a in unsubmitted if a.reviewer == r]
            success, _ = slack.send_reminder_dm(r, unsubmitted_reviewees)
            if success:
                sent_count += 1
                cycle.assignments.filter(reviewer=r, is_submitted=False).update(last_reminded_at=timezone.now())

        messages.success(request, f"미작성자 {sent_count}명에게 독촉 Slack DM (미작성 동료 목록 포함)을 전송했습니다.")
        return redirect('admin_status_detail', cycle_id=cycle_id)

    return redirect('admin_status')


def admin_generate_reports_action(request, cycle_id):
    if request.method == 'POST':
        cycle = get_object_or_404(ReviewCycle, id=cycle_id)

        if not cycle.is_all_submitted:
            messages.warning(request, f"아직 전원 제출되지 않았습니다 (완료율: {cycle.completion_rate}%). 모든 리뷰어가 작성을 마쳐야 합니다.")
            return redirect('admin_status_detail', cycle_id=cycle_id)

        cycle.status = 'COMPLETED'
        cycle.save()
        reports = PDFReportService.generate_all_reports_for_cycle(cycle)
        messages.success(request, f"총 {len(reports)}건의 PDF 리포트가 성공적으로 생성되었습니다! 검토 대시보드에서 확인해 주세요.")
        return redirect('admin_reports', cycle_id=cycle_id)

    return redirect('admin_status')


# ==========================================
# 5. PAGE 5: HTML & PDF 결과 검토 페이지
# ==========================================
def admin_reports(request, cycle_id):
    cycle = get_object_or_404(ReviewCycle, id=cycle_id)

    if cycle.is_all_submitted and not cycle.reports.exists():
        PDFReportService.generate_all_reports_for_cycle(cycle)
        if cycle.status == 'ACTIVE':
            cycle.status = 'COMPLETED'
            cycle.save()

    reports = cycle.reports.all().select_related('reviewee')
    reports_data = []

    for r in reports:
        preview_data = PDFReportService.compile_feedback_data(cycle, r.reviewee)
        reports_data.append({
            'reviewee': r.reviewee,
            'pdf_file': r.pdf_file,
            'is_sent': r.is_sent,
            'created_at': r.created_at,
            'preview_data': preview_data,
        })

    return render(request, 'admin_custom/reports.html', {
        'cycle': cycle,
        'reports': reports_data,
        'active_menu': 'dashboard',
    })


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
                    cycle_title=cycle.title
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
# 6. PAGE 6: 관리자 커스텀 Slack DM 메시지 전송
# ==========================================
def admin_send_message(request):
    members = Member.objects.all()

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
            if slack.mock_mode:
                print(f"[MOCK SLACK CUSTOM MESSAGE -> {m.name} ({m.slack_user_id})]: {message_text}")
                sent_count += 1
            else:
                try:
                    slack.client.chat_postMessage(channel=m.slack_user_id, text=message_text)
                    sent_count += 1
                except Exception as e:
                    pass

        messages.success(request, f"총 {sent_count}명의 팀원에게 Slack DM 메시지를 성공적으로 전송했습니다!")
        return redirect('admin_send_message')

    return render(request, 'admin_custom/send_message.html', {
        'members': members,
        'active_menu': 'messages',
    })
