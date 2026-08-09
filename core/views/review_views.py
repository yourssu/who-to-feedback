import json
import time

from django.contrib import messages
from django.db import OperationalError
from django.http import JsonResponse
from django.shortcuts import render, redirect, get_object_or_404
from django.utils import timezone

from core.models import (
    Member, ReviewCycle, QuestionOption,
    ReviewAssignment, ReviewAnswer
)


def run_with_db_retry(func, max_retries=3, delay=0.2):
    """SQLite 동시성 락(OperationalError: database is locked) 발생 시 최대 3회 재시도"""
    for i in range(max_retries):
        try:
            return func()
        except OperationalError as e:
            if "locked" in str(e).lower() and i < max_retries - 1:
                time.sleep(delay * (i + 1))
                continue
            raise


def _is_review_editable(cycle):
    """ACTIVE 상태 + 마감 전에만 리뷰 작성/제출/임시저장 허용 (마감 게이트)"""
    return cycle.status == 'ACTIVE' and not cycle.is_deadline_passed


def review_dashboard(request):
    """리뷰어 개인 대시보드 (세션에 저장된 로그인 회차의 assigned reviews list)"""
    member_id = request.session.get('member_id')
    if not member_id:
        return redirect('login')

    reviewer = get_object_or_404(Member, id=member_id)

    # PIN이 발급된 회차(세션 cycle_id) 기준으로만 대시보드를 구성한다.
    cycle_id = request.session.get('cycle_id')
    cycle = None
    if cycle_id:
        cycle = ReviewCycle.objects.filter(
            id=cycle_id, status__in=['ACTIVE', 'COMPLETED', 'CLOSED']
        ).first()

    if not cycle:
        # 세션의 회차가 없거나 유효하지 않으면 재인증 유도
        return redirect('login')

    raw_assignments = ReviewAssignment.objects.filter(cycle=cycle, reviewer=reviewer).select_related('reviewee')
    total_count = raw_assignments.count()
    completed_count = raw_assignments.filter(is_submitted=True).count()
    completion_rate = int((completed_count / total_count * 100)) if total_count > 0 else 0
    is_completed = (total_count > 0 and completed_count == total_count)

    days_left = (cycle.end_at - timezone.now()).days if (cycle.end_at and cycle.end_at > timezone.now()) else 0
    can_write = _is_review_editable(cycle)

    # 템플릿 (dashboard.html) 호환용: item.id, item.reviewee, item.is_submitted 및 item.assignment 모두 지원
    assignments = []
    for a in raw_assignments:
        setattr(a, 'assignment', a)
        assignments.append(a)

    unsubmitted_assignments = [a for a in assignments if not a.is_submitted]
    first_unsubmitted_id = unsubmitted_assignments[0].id if unsubmitted_assignments else (assignments[0].id if assignments else None)

    return render(request, 'review/dashboard.html', {
        'reviewer': reviewer,
        'cycle': cycle,
        'assignments': assignments,
        'first_unsubmitted_id': first_unsubmitted_id,
        'total_count': total_count,
        'completed_count': completed_count,
        'submitted_count': completed_count,
        'completion_rate': completion_rate,
        'is_completed': is_completed,
        'is_all_completed': is_completed,
        'days_left': days_left,
        'can_write': can_write,
        'is_deadline_passed': cycle.is_deadline_passed,
    })


def review_form(request, assignment_id):
    """4가지 문항 타입 동적 작성 폼, 임시 저장 복원 및 마감 시간 제어"""
    member_id = request.session.get('member_id')
    session_cycle_id = request.session.get('cycle_id')
    if not member_id:
        return redirect('login')

    reviewer = get_object_or_404(Member, id=member_id)
    assignment = get_object_or_404(ReviewAssignment, id=assignment_id, reviewer=reviewer)
    cycle = assignment.cycle

    # 본인 매칭에 접근 시 세션의 cycle_id를 동기화
    if session_cycle_id != cycle.id:
        request.session['cycle_id'] = cycle.id

    # ACTIVE + 마감 전 + 제출 전 상태일 때만 작성/수정/임시저장 허용
    is_editable = _is_review_editable(cycle) and not assignment.is_submitted

    lock_title = "제출한 리뷰가 잠겼어요" if assignment.is_submitted else "회차가 종료되었어요"
    lock_message = (
        "이미 제출을 완료한 피어리뷰입니다. 제출된 답변은 읽기 전용으로 확인만 가능합니다." if assignment.is_submitted
        else "회차가 종료되어 리뷰를 작성할 수 없습니다."
    )

    if not is_editable and request.method == "POST":
        messages.warning(request, lock_message)
        return redirect("review_form", assignment_id=assignment_id)

    questions = cycle.questions.all().order_by("order")

    if request.method == "POST":
        has_error = False
        error_message = ""

        # Validate required fields and constraints
        for q in questions:
            if q.question_type == "RATING":
                rating_val = request.POST.get(f"q_{q.id}_rating")
                if not rating_val:
                    has_error = True
                    error_message = "모든 평점 문항에 답변해 주세요."
                    break
                try:
                    rating_num = int(rating_val)
                    if not (1 <= rating_num <= 5):
                        has_error = True
                        error_message = "평점은 1점에서 5점 사이의 점수여야 합니다."
                        break
                except ValueError:
                    has_error = True
                    error_message = "올바른 평점 점수를 선택해 주세요."
                    break

            elif q.question_type == "SINGLE_CHOICE":
                option_id = request.POST.get(f"q_{q.id}_single")
                if not option_id:
                    has_error = True
                    error_message = "모든 단일 선택 문항에 답변해 주세요."
                    break
                if not QuestionOption.objects.filter(id=option_id, question=q).exists():
                    has_error = True
                    error_message = "유효하지 않은 선택지 항목입니다."
                    break

            elif q.question_type == "MULTIPLE_CHOICE":
                option_ids = request.POST.getlist(f"q_{q.id}_multi")
                if not option_ids:
                    has_error = True
                    error_message = f"Q{q.order} 다중 선택 문항에 최소 1개 이상 항목을 선택해 주세요."
                    break
                if not QuestionOption.objects.filter(id__in=option_ids, question=q).exists():
                    has_error = True
                    error_message = "유효하지 않은 선택지 항목입니다."
                    break

            elif q.question_type == "TEXT":
                text_val = request.POST.get(f"q_{q.id}_text", "").strip()
                if not text_val:
                    has_error = True
                    error_message = "모든 텍스트 문항에 답변해 주세요."
                    break
                if len(text_val) > 2000:
                    has_error = True
                    error_message = f"Q{q.order} 서술형 피드백은 최대 2,000자까지 작성할 수 있습니다 (현재: {len(text_val)}자)."
                    break

        if has_error:
            messages.error(request, error_message)
            # Re-render form with existing data
            questions_data = []
            text_5_labels = {1: "매우 아님", 2: "약간 아님", 3: "보통임", 4: "약간 그럼", 5: "매우 그럼"}
            numeric_5_labels = {1: "1점", 2: "2점", 3: "3점", 4: "4점", 5: "5점"}
            for q in questions:
                item = {"question": q, "scale_options": [], "options": q.options.all(), "draft_rating": None, "draft_text": "", "draft_single": None, "draft_multi": []}
                if q.question_type == "RATING":
                    labels = numeric_5_labels if q.scale_type == "NUMERIC_5" else text_5_labels
                    item["scale_options"] = [{"val": i, "label": labels[i]} for i in range(1, 6)]
                # Restore POST data
                if q.question_type == "RATING":
                    rating_val = request.POST.get(f"q_{q.id}_rating")
                    if rating_val:
                        item["draft_rating"] = int(rating_val)
                elif q.question_type == "TEXT":
                    item["draft_text"] = request.POST.get(f"q_{q.id}_text", "")
                elif q.question_type == "SINGLE_CHOICE":
                    single_val = request.POST.get(f"q_{q.id}_single")
                    if single_val:
                        item["draft_single"] = int(single_val)
                elif q.question_type == "MULTIPLE_CHOICE":
                    multi_vals = request.POST.getlist(f"q_{q.id}_multi")
                    item["draft_multi"] = [int(v) for v in multi_vals]
                questions_data.append(item)
            return render(request, "review/form.html", {
                "assignment": assignment,
                "cycle": cycle,
                "questions_data": questions_data,
                "is_editable": is_editable,
                "is_locked": not is_editable,
                "lock_title": lock_title if not is_editable else "",
                "lock_message": lock_message if not is_editable else "",
            })

        # Save answers with DB Lock retry
        def _save_answers():
            for q in questions:
                ans, _ = ReviewAnswer.objects.get_or_create(assignment=assignment, question=q)

                if q.question_type == "RATING":
                    rating_val = request.POST.get(f"q_{q.id}_rating")
                    if rating_val:
                        ans.rating_value = int(rating_val)
                        ans.save()

                elif q.question_type == "TEXT":
                    text_val = request.POST.get(f"q_{q.id}_text", "").strip()
                    ans.answer_text = text_val
                    ans.save()

                elif q.question_type == "SINGLE_CHOICE":
                    option_id = request.POST.get(f"q_{q.id}_single")
                    if option_id:
                        ans.selected_options.clear()
                        opt = QuestionOption.objects.filter(id=option_id, question=q).first()
                        if opt:
                            ans.selected_options.add(opt)
                    ans.save()

                elif q.question_type == "MULTIPLE_CHOICE":
                    option_ids = request.POST.getlist(f"q_{q.id}_multi")
                    ans.selected_options.clear()
                    if option_ids:
                        opts = QuestionOption.objects.filter(id__in=option_ids, question=q)
                        ans.selected_options.add(*opts)
                    ans.save()

            assignment.is_submitted = True
            assignment.submitted_at = timezone.now()
            assignment.save()

        try:
            run_with_db_retry(_save_answers)
        except OperationalError:
            messages.error(request, "서버 연결이 혼잡합니다. 잠시 후 다시 제출해 주세요.")
            return redirect("review_form", assignment_id=assignment_id)

        messages.success(request, f"'{assignment.reviewee.name}' 님에 대한 피어리뷰가 성공적으로 제출되었습니다!")
        return redirect("review_dashboard")

    # GET 요청 시 제출 완료건은 DB 저장 답변을 1순위 복원, 미제출건만 draft_data 복원 적용
    questions_data = []
    text_5_labels = {1: "매우 아님", 2: "약간 아님", 3: "보통임", 4: "약간 그럼", 5: "매우 그럼"}
    numeric_5_labels = {1: "1점", 2: "2점", 3: "3점", 4: "4점", 5: "5점"}
    draft = assignment.draft_data or {}

    for q in questions:
        existing_ans = ReviewAnswer.objects.filter(assignment=assignment, question=q).first()
        existing_selected_ids = []

        if existing_ans:
            existing_selected_ids = list(existing_ans.selected_options.values_list('id', flat=True))

        # 이미 제출된 경우 draft_data를 무시하고 DB 저장값 적용
        if assignment.is_submitted:
            draft_rating = existing_ans.rating_value if existing_ans else None
            draft_text = existing_ans.answer_text if existing_ans else ''
            draft_single = existing_selected_ids[0] if (existing_selected_ids and q.question_type == 'SINGLE_CHOICE') else None
            draft_multi = existing_selected_ids if q.question_type == 'MULTIPLE_CHOICE' else []
        else:
            draft_rating = draft.get(f'q_{q.id}_rating') or (existing_ans.rating_value if existing_ans else None)
            draft_text = draft.get(f'q_{q.id}_text') if f'q_{q.id}_text' in draft else (existing_ans.answer_text if existing_ans else '')

            draft_single = draft.get(f'q_{q.id}_single')
            if draft_single:
                draft_single = int(draft_single)
            elif existing_selected_ids and q.question_type == 'SINGLE_CHOICE':
                draft_single = existing_selected_ids[0]

            draft_multi = draft.get(f'q_{q.id}_multi')
            if draft_multi and isinstance(draft_multi, list):
                draft_multi = [int(x) for x in draft_multi]
            elif existing_selected_ids and q.question_type == 'MULTIPLE_CHOICE':
                draft_multi = existing_selected_ids

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
            'draft_rating': int(draft_rating) if draft_rating else None,
            'draft_text': draft_text,
            'draft_single': draft_single,
            'draft_multi': draft_multi or [],
        })

    return render(request, 'review/form.html', {
        'assignment': assignment,
        'cycle': cycle,
        'questions_data': questions_data,
        'draft_data': draft,
        'is_editable': is_editable,
        'is_locked': not is_editable,
        'lock_title': "제출한 리뷰가 잠겼어요" if assignment.is_submitted else "회차가 종료되었어요",
        'lock_message': "이미 제출을 완료한 피어리뷰입니다. 제출된 답변은 읽기 전용으로 확인만 가능합니다." if assignment.is_submitted else "마감 시간이 경과하였거나 회차가 종료되어 리뷰를 작성할 수 없습니다.",
    })


def save_draft(request, assignment_id):
    """전체 질문지에 대한 4가지 문항 타입(RATING, TEXT, SINGLE, MULTI) 통합 임시 저장 API (POST)"""
    if request.method != 'POST':
        return JsonResponse({'status': 'error', 'message': 'Invalid HTTP Method'}, status=405)

    member_id = request.session.get('member_id')
    if not member_id:
        return JsonResponse({'status': 'error', 'message': 'Unauthorized'}, status=401)

    assignment = get_object_or_404(ReviewAssignment, id=assignment_id, reviewer_id=member_id)

    # ACTIVE + 마감 전 + 미제출 상태일 때만 임시저장 허용
    if assignment.is_submitted:
        return JsonResponse({'status': 'error', 'message': '이미 제출 완료된 리뷰는 임시저장할 수 없습니다.'}, status=403)
    if not _is_review_editable(assignment.cycle):
        return JsonResponse({'status': 'error', 'message': '회차가 종료되어 임시저장할 수 없습니다.'}, status=403)

    # 임시 저장 대용량 Payload 방어 (최대 100KB)
    if len(request.body) > 100 * 1024:
        return JsonResponse({'status': 'error', 'message': '임시 저장 데이터 용량이 초과되었습니다 (최대 100KB).'}, status=400)

    try:
        # 전체 폼 데이터 파싱 (JSON 또는 FormData 지원)
        if request.content_type == 'application/json':
            payload = json.loads(request.body) if request.body else {}
        else:
            payload = {}
            for key in request.POST:
                values = request.POST.getlist(key)
                if len(values) > 1:
                    payload[key] = values
                else:
                    payload[key] = values[0]

        def _save_draft_action():
            assignment.draft_data = payload
            assignment.draft_saved_at = timezone.now()
            assignment.save()

        run_with_db_retry(_save_draft_action)

        return JsonResponse({
            'status': 'success',
            'message': '전체 질문지의 모든 답변이 성공적으로 임시 저장되었습니다.',
            'saved_at': assignment.draft_saved_at.strftime('%Y-%m-%d %H:%M:%S'),
            'saved_fields_count': len(payload)
        })
    except Exception as e:
        return JsonResponse({'status': 'error', 'message': str(e)}, status=400)
