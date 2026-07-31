import openpyxl
import difflib
from core.models import Member, ReviewAssignment, ReviewAnswer, DataValidationLog


class DataValidationService:
    @staticmethod
    def validate_excel_data(file_obj, cycle):
        """엑셀 파일 업로드 후 필수값 오류 검출 및 로그 기록"""
        wb = openpyxl.load_workbook(file_obj)
        sheet = wb.active

        # 기존 검증 로그 초기화
        DataValidationLog.objects.filter(cycle=cycle).delete()
        logs = []

        # 헤더 제외한 2행부터 검사
        for row_idx, row in enumerate(sheet.iter_rows(min_row=2, values_only=True), start=2):
            if not row or not any(row):
                continue

            name = row[0] if len(row) > 0 else None
            email = row[1] if len(row) > 1 else None
            dept = row[2] if len(row) > 2 else None
            role = row[3] if len(row) > 3 else None

            # 1. 이름 누락 검사
            if not name or not str(name).strip():
                logs.append(DataValidationLog(
                    cycle=cycle,
                    row_index=row_idx,
                    issue_type='NAME_MISSING',
                    current_value='(빈값)'
                ))

            # 2. 팀/역할 누락 검사
            if not dept or not str(dept).strip():
                logs.append(DataValidationLog(
                    cycle=cycle,
                    row_index=row_idx,
                    issue_type='DEPT_MISSING',
                    current_value=f"{name or '미상'} · (부서/역할 빈값)"
                ))

        if logs:
            DataValidationLog.objects.bulk_create(logs)
        return logs

    @staticmethod
    def get_normalization_suggestions(cycle):
        """이름/닉네임 유사도 매칭 (Alex / alex / ALEX -> Alex) 정규화 제안"""
        members = Member.objects.all()
        names = [m.name for m in members if m.name]
        suggestions = []

        visited = set()
        for i, name1 in enumerate(names):
            if name1 in visited:
                continue
            group = [name1]
            for j, name2 in enumerate(names):
                if i != j and name2 not in visited:
                    # 영문 대소문자 무시 비교 또는 문자열 유사도 80% 이상
                    ratio = difflib.SequenceMatcher(None, name1.lower(), name2.lower()).ratio()
                    if ratio >= 0.8:
                        group.append(name2)
                        visited.add(name2)

            if len(group) > 1:
                visited.add(name1)
                target_name = max(group, key=len).capitalize()
                suggestions.append({
                    'raw_names': group,
                    'suggested_name': target_name,
                    'similarity': 95,
                })

        return suggestions

    @staticmethod
    def apply_normalization(cycle, raw_names, target_name):
        """정규화 이름 적용"""
        count = Member.objects.filter(name__in=raw_names).update(normalized_name=target_name)
        return count

    @staticmethod
    def filter_response_quality(answers):
        """실내용 없음 패턴("없습니다", "잘 모르겠습니다", "함께한 경험이 없습니다") 자동 필터링"""
        meaningless_patterns = ["없습니다", "잘 모르겠습니다", "함께한 경험이 없습니다", "없음", "모름", "N/A"]
        excluded_count = 0

        for ans in answers:
            if ans.answer_text:
                text = ans.answer_text.strip()
                if text in meaningless_patterns or len(text) <= 2:
                    ans.is_excluded_from_report = True
                    ans.exclusion_reason = "실내용 없음 패턴 자동 검출"
                    ans.save()
                    excluded_count += 1

        return excluded_count
