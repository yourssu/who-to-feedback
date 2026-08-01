from core.models import ReviewReport, ReviewAnswer, ReviewAssignment


class LayoutCheckService:
    @staticmethod
    def check_layout_overflow(cycle, reviewee):
        """리포트 생성 후 텍스트 넘침, 긴 글 overflow, 키워드 박스 넘침 자동 레이아웃 검수"""
        report, _ = ReviewReport.objects.get_or_create(cycle=cycle, reviewee=reviewee)
        assignments = ReviewAssignment.objects.filter(cycle=cycle, reviewee=reviewee, is_submitted=True)
        answers = ReviewAnswer.objects.filter(assignment__in=assignments, is_excluded_from_report=False)

        issues = []

        # 1. 서술형 300자/500자 이상 긴 글 overflow 검사
        for ans in answers:
            if ans.answer_text and len(ans.answer_text) >= 300:
                issues.append(f"Q{ans.question.order} 서술형 답변이 {len(ans.answer_text)}자로 길어 카드 밖 overflow 주의 필요.")

        # 2. 키워드 선택 태그 8개 이상 넘침 검사
        multi_answers = answers.filter(question__question_type='MULTIPLE_CHOICE')
        for ans in multi_answers:
            if ans.selected_options.count() >= 8:
                issues.append(f"Q{ans.question.order} 선택된 역량 키워드가 {ans.selected_options.count()}개로 키워드 박스 넘침 주의 필요.")

        if issues:
            report.layout_check_passed = False
            report.layout_issue_notes = " | ".join(issues)
        else:
            report.layout_check_passed = True
            report.layout_issue_notes = "자동 레이아웃 검수 통과"

        report.save()
        return report
