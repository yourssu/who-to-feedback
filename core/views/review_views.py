from django.shortcuts import render, redirect, get_object_or_404
from django.contrib import messages
from django.utils import timezone
from django.http import JsonResponse
import json

from core.models import (
    Member, ReviewCycle, ReviewQuestion, QuestionOption,
    ReviewAssignment, ReviewAnswer, ReviewAuthCode
)


def review_dashboard(request):
    """리뷰어 개인 대시보드 (assigned reviews list)"""
    member_id = request.session.get('member_id')
    if not member_id:
        return redirect('login')

    reviewer = get_object_or_404(Member, id=member_id)
    cycle = ReviewCycle.objects.filter(status__in=['ACTIVE', 'COMPLETED', 'CLOSED']).first()

    if not cycle:
        return render(request, 'review/dashboard.html', {
            'reviewer': reviewer,
            'cycle': None,
            'assignments': [],
            'completion_rate': 0,
        })

    assignments = ReviewAssignment.objects.filter(cycle=cycle, reviewer=reviewer).select_related('reviewee')
    total_count = assignments.count()
    submitted_count = assignments.filter(is_submitted=True).count()
    completion_rate = int((submitted_count / total_count * 100)) if total_count > 0 else 0
    is_all_completed = (total_count > 0 and submitted_count == total_count)

    # 마감 임박 계산
    days_left = (cycle.end_at - timezone.now()).days if cycle.end_at > timezone.now() else 0

    return render(request, 'review/dashboard.html', {
        'reviewer': reviewer,
        'cycle': cycle,
        'assignments': assignments,
        'total_count': total_count,
        'submitted_count': submitted_count,
        'completion_rate': completion_rate,
        'is_all_completed': is_all_completed,
        'days_left': days_left,
        'is_deadline_passed': cycle.is_deadline_passed,
    })


def review_form(request, assignment_id):
    """4가지 문항 타입 동적 작성 폼 및 마감 시간 제어"""
    member_id = request.session.get('member_id')
    if not member_id:
        return redirect('login')

    reviewer = get_object_or_404(Member, id=member_id)
    assignment = get_object_or_404(ReviewAssignment, id=assignment_id, reviewer=reviewer)
    cycle = assignment.cycle

    # 마감 시간 경과 및 이미 제출된 경우 수정 잠금 처리 (r-submitted-locked)
    if cycle.is_deadline_passed and assignment.is_submitted:
        messages.warning(request, "마감 시간이 경과하여 제출된 답변은 더 이상 수정할 수 없습니다.")
        return render(request, 'review/form.html', {
            'assignment': assignment,
            'cycle': cycle,
            'is_locked': True,
            'questions_data': [],
        })

    questions = cycle.questions.all().order_by('order')

    if request.method == 'POST':
        for q in questions:
            ans, _ = ReviewAnswer.objects.get_or_create(assignment=assignment, question=q)

            if q.question_type == 'RATING':
                rating_val = request.POST.get(f'q_{q.id}_rating')
                if rating_val:
                    ans.rating_value = int(rating_val)
                    ans.save()

            elif q.question_type == 'TEXT':
                text_val = request.POST.get(f'q_{q.id}_text', '').strip()
                ans.answer_text = text_val
                ans.save()

            elif q.question_type == 'SINGLE_CHOICE':
                option_id = request.POST.get(f'q_{q.id}_single')
                if option_id:
                    ans.selected_options.clear()
                    opt = QuestionOption.objects.filter(id=option_id).first()
                    if opt:
                        ans.selected_options.add(opt)
                ans.save()

            elif q.question_type == 'MULTIPLE_CHOICE':
                option_ids = request.POST.getlist(f'q_{q.id}_multi')
                ans.selected_options.clear()
                if option_ids:
                    opts = QuestionOption.objects.filter(id__in=option_ids)
                    ans.selected_options.add(*opts)
                ans.save()

        assignment.is_submitted = True
        assignment.submitted_at = timezone.now()
        assignment.save()

        messages.success(request, f"'{assignment.reviewee.name}' 님에 대한 피어리뷰가 성공적으로 제출되었습니다!")
        return redirect('review_dashboard')

    # GET 요청 시 기존 답변 및 척도 라벨 데이터 준비
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
        'cycle': cycle,
        'questions_data': questions_data,
        'draft_data': assignment.draft_data or {},
        'is_editable': not cycle.is_deadline_passed,
        'is_locked': False,
    })


def save_draft(request, assignment_id):
    """작성 중인 폼 임시 저장 API (POST)"""
    if request.method != 'POST':
        return JsonResponse({'status': 'error', 'message': 'Invalid HTTP Method'}, status=405)

    member_id = request.session.get('member_id')
    if not member_id:
        return JsonResponse({'status': 'error', 'message': 'Unauthorized'}, status=401)

    assignment = get_object_or_404(ReviewAssignment, id=assignment_id, reviewer_id=member_id)

    try:
        data = json.loads(request.body) if request.body else request.POST.dict()
        assignment.draft_data = data
        assignment.draft_saved_at = timezone.now()
        assignment.save()
        return JsonResponse({
            'status': 'success',
            'message': '임시 저장되었습니다.',
            'saved_at': assignment.draft_saved_at.strftime('%Y-%m-%d %H:%M:%S')
        })
    except Exception as e:
        return JsonResponse({'status': 'error', 'message': str(e)}, status=400)
