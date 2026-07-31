from django.shortcuts import render, redirect, get_object_or_404
from django.contrib import messages
from django.utils import timezone
from core.models import Member, ReviewCycle, ReviewAssignment, ReviewAnswer, QuestionOption
from core.services.pdf_service import PDFReportService


def login_required_custom(view_func):
    def wrapper(request, *args, **kwargs):
        if not request.session.get('member_id'):
            messages.warning(request, "로그인이 필요합니다. Slack DM으로 전송된 인증번호를 입력해 주세요.")
            return redirect('login')
        return view_func(request, *args, **kwargs)
    return wrapper


@login_required_custom
def review_dashboard(request):
    member_id = request.session['member_id']
    member = get_object_or_404(Member, id=member_id)

    # 최근 활성 또는 진행 중/작성 완료된 회차 가져오기
    cycle_id = request.session.get('cycle_id')
    if cycle_id:
        cycle = ReviewCycle.objects.filter(id=cycle_id).first()
    else:
        cycle = ReviewCycle.objects.filter(status__in=['ACTIVE', 'COMPLETED']).first()

    if not cycle:
        return render(request, 'review/dashboard.html', {
            'cycle': None,
            'assignments': [],
            'is_completed': False,
        })

    assignments = ReviewAssignment.objects.filter(cycle=cycle, reviewer=member)
    assignments_data = []
    submitted_count = 0

    for a in assignments:
        if a.is_submitted:
            submitted_count += 1
        assignments_data.append({
            'assignment': a,
        })

    is_completed = (len(assignments) > 0 and submitted_count == len(assignments))

    return render(request, 'review/dashboard.html', {
        'cycle': cycle,
        'assignments': assignments_data,
        'completed_count': submitted_count,
        'is_completed': is_completed,
    })


@login_required_custom
def review_form(request, assignment_id):
    member_id = request.session['member_id']
    member = get_object_or_404(Member, id=member_id)

    assignment = get_object_or_404(ReviewAssignment, id=assignment_id, reviewer=member)
    cycle = assignment.cycle
    questions = cycle.questions.all().order_by('order')

    if request.method == 'POST':
        for q in questions:
            answer, _ = ReviewAnswer.objects.get_or_create(assignment=assignment, question=q)

            if q.question_type == 'RATING':
                rating_val = request.POST.get(f'q_{q.id}_rating')
                if rating_val:
                    answer.rating_value = int(rating_val)

            elif q.question_type == 'TEXT':
                text_val = request.POST.get(f'q_{q.id}_text', '')
                answer.answer_text = text_val

            elif q.question_type == 'SINGLE_CHOICE':
                opt_id = request.POST.get(f'q_{q.id}_single')
                if opt_id:
                    answer.selected_options.clear()
                    opt = QuestionOption.objects.filter(id=opt_id).first()
                    if opt:
                        answer.selected_options.add(opt)

            elif q.question_type == 'MULTIPLE_CHOICE':
                opt_ids = request.POST.getlist(f'q_{q.id}_multi')
                answer.selected_options.clear()
                opts = QuestionOption.objects.filter(id__in=opt_ids)
                answer.selected_options.add(*opts)

            answer.save()

        # 제출 완료 상태 갱신
        assignment.is_submitted = True
        assignment.submitted_at = timezone.now()
        assignment.save()

        messages.success(request, f"{assignment.reviewee.name} 님에 대한 피어리뷰가 성공적으로 제출되었습니다!")

        # 회차 내 모든 리뷰어의 제출이 100% 완료되었는지 확인
        if cycle.is_all_submitted and cycle.status == 'ACTIVE':
            cycle.status = 'COMPLETED'
            cycle.save()
            # 관리자 검토용 PDF 리포트 일괄 자동 생성
            try:
                PDFReportService.generate_all_reports_for_cycle(cycle)
                messages.info(request, "🎉 전원 피어리뷰 제출이 완료되었습니다! 관리자 검토를 위해 PDF 리포트 생성이 완료되었습니다.")
            except Exception as e:
                messages.warning(request, f"리포트 PDF 생성 중 오류 발생: {e}")

        return redirect('review_dashboard')

    # GET 요청 시 기존 답변 데이터 렌더링 준비
    questions_data = []
    text_5_labels = {1: "매우 아님", 2: "약간 아님", 3: "보통임", 4: "약간 그럼", 5: "매우 그럼"}
    numeric_5_labels = {1: "1점", 2: "2점", 3: "3점", 4: "4점", 5: "5점"}

    for q in questions:
        existing_ans = ReviewAnswer.objects.filter(assignment=assignment, question=q).first()
        existing_selected_ids = []
        if existing_ans:
            existing_selected_ids = list(existing_ans.selected_options.values_list('id', flat=True))

        scale_options = []
        if q.question_type == 'RATING':
            labels_dict = text_5_labels if q.scale_type == 'TEXT_5' else numeric_5_labels
            for val in range(1, 6):
                scale_options.append({
                    'val': val,
                    'label': labels_dict[val]
                })

        questions_data.append({
            'question': q,
            'options': q.options.all().order_by('order'),
            'scale_options': scale_options,
            'existing_answer': existing_ans,
            'existing_selected': existing_selected_ids,
        })

    return render(request, 'review/form.html', {
        'assignment': assignment,
        'questions_data': questions_data,
        'rating_range': range(1, 6),
    })
