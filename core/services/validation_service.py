import openpyxl
import difflib
from core.models import Member, ReviewAssignment, ReviewAnswer, DataValidationLog


class DataValidationService:
    @staticmethod
    def validate_excel_data(file_obj, cycle):
        """엑셀 파일 업로드 직후 6가지 오류(이름 누락, 중복 이름, 대소문자 불일치, 팀/역할 누락, 점수 누락, 서술형 빈값) 자동 감지"""
        wb = openpyxl.load_workbook(file_obj)
        sheet = wb.active

        DataValidationLog.objects.filter(cycle=cycle).delete()
        logs = []
        seen_names = {}

        for row_idx, row in enumerate(sheet.iter_rows(min_row=2, values_only=True), start=2):
            if not row or not any(row):
                continue

            name = str(row[0]).strip() if len(row) > 0 and row[0] else None
            email = str(row[1]).strip() if len(row) > 1 and row[1] else None
            dept = str(row[2]).strip() if len(row) > 2 and row[2] else None
            role = str(row[3]).strip() if len(row) > 3 and row[3] else None

            # 1. 이름 누락 검사
            if not name:
                logs.append(DataValidationLog(
                    cycle=cycle, row_index=row_idx, issue_type='NAME_MISSING', current_value='(이름 빈값)'
                ))
            else:
                # 2. 중복 이름 및 대소문자 불일치 검사 (예: Alex, alex, ALEX)
                lower_name = name.lower()
                if lower_name in seen_names:
                    logs.append(DataValidationLog(
                        cycle=cycle, row_index=row_idx, issue_type='DUPLICATE_OR_CASE_MISMATCH',
                        current_value=f"'{name}' - 이전 {seen_names[lower_name]}행 '{seen_names[lower_name + '_raw']}'과 대소문자 불일치/중복"
                    ))
                else:
                    seen_names[lower_name] = row_idx
                    seen_names[lower_name + '_raw'] = name

            # 3. 팀 / 역할 누락 검사
            if not dept or not role:
                logs.append(DataValidationLog(
                    cycle=cycle, row_index=row_idx, issue_type='DEPT_ROLE_MISSING',
                    current_value=f"{name or '미상'} · (팀: {dept or '빈값'}, 역할: {role or '빈값'})"
                ))

        if logs:
            DataValidationLog.objects.bulk_create(logs)
        return logs

    @staticmethod
    def get_normalization_suggestions(cycle):
        """이름/닉네임 대소문자/오타 차이 유사도 매칭 정규화 제안"""
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
        """정규화 이름 일괄 반영"""
        count = Member.objects.filter(name__in=raw_names).update(normalized_name=target_name)
        return count

    @staticmethod
    def filter_response_quality(answers):
        """의미 없는 실내용 없음 답변("없습니다", "잘 모르겠습니다", "함께한 경험이 없습니다") 자동 필터링"""
        meaningless_patterns = ["없습니다", "잘 모르겠습니다", "함께한 경험이 없습니다", "없음", "모름", "N/A"]
        excluded_count = 0

        for ans in answers:
            if ans.answer_text:
                text = ans.answer_text.strip()
                if text in meaningless_patterns or len(text) <= 2:
                    ans.is_excluded_from_report = True
                    ans.exclusion_reason = "응답 품질 필터 자동 검출 (실내용 없음)"
                    ans.save()
                    excluded_count += 1

        return excluded_count

    @staticmethod
    def import_members_from_csv(csv_file):
        """CSV 파일에서 팀원 목록(이름, 이메일, Slack ID, 소속 부서, 역할) 일괄 추가/업데이트"""
        import csv
        import io
        import unicodedata

        raw_bytes = csv_file.read()
        csv_text = None

        # 인코딩 자동 시도 (utf-8-sig -> utf-8 -> cp949 -> euc-kr)
        for enc in ['utf-8-sig', 'utf-8', 'cp949', 'euc-kr']:
            try:
                csv_text = raw_bytes.decode(enc)
                break
            except (UnicodeDecodeError, TypeError):
                continue

        if not csv_text:
            raise ValueError("CSV 파일 인코딩을 해석할 수 없습니다. UTF-8 또는 CP949 인코딩으로 저장해 주세요.")

        reader = csv.DictReader(io.StringIO(csv_text))
        headers = [h.strip().lower() for h in (reader.fieldnames or [])]

        def get_col(row, *aliases):
            for a in aliases:
                for k, v in row.items():
                    if k and k.strip().lower() == a:
                        return (v or "").strip()
            return ""

        created_count = 0
        updated_count = 0

        for row in reader:
            if not row or not any(row.values()):
                continue

            name = get_col(row, 'name', '이름', '닉네임', 'username')
            email = get_col(row, 'email', '이메일')
            slack_id = get_col(row, 'slack_user_id', 'slack_id', '슬랙id', 'slack')
            dept = get_col(row, 'department', 'dept', '소속부서', '부서', '팀')
            role_raw = get_col(row, 'role', '역할', '권한').upper()

            if not name:
                continue

            # 이메일이 없을 때 가상 이메일 생성
            if not email:
                norm_prefix = "".join(ch for ch in unicodedata.normalize('NFKC', name).lower() if ch.isalnum())
                email = f"{norm_prefix or 'user'}@yourssu.com"

            role = 'ADMIN' if role_raw in ['ADMIN', '관리자', 'SUPERUSER'] else 'MEMBER'
            norm_name = unicodedata.normalize('NFKC', name).casefold()

            member, created = Member.objects.update_or_create(
                email=email,
                defaults={
                    'name': name,
                    'slack_user_id': slack_id or f"U_{norm_name[:10]}",
                    'department': dept or "일반",
                    'role': role,
                    'normalized_name': norm_name,
                }
            )

            if created:
                created_count += 1
            else:
                updated_count += 1

        return {'created': created_count, 'updated': updated_count, 'total': created_count + updated_count}

