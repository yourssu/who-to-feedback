import difflib
import re

from core.models import Member


class DataValidationService:

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
        """정규화 이름 반영 (원본 name은 보존하고 normalized_name만 업데이트)"""
        count = Member.objects.filter(name__in=raw_names).update(normalized_name=target_name)
        return count

    @staticmethod
    def filter_response_quality(answers):
        """의미 없는 답변, 2자 이하 답변 및 자음/모음 난타, 무의미 패턴 감지 자동 필터링"""
        meaningless_patterns = [
            "없습니다", "잘 모르겠습니다", "함께한 경험이 없습니다",
            "없음", "모름", "N/A", "na", "n/a", "test", "테스트", "없어", "몰라"
        ]
        excluded_count = 0

        for ans in answers:
            if ans.answer_text:
                text = ans.answer_text.strip()
                is_meaningless = False
                reason = "응답 품질 필터 자동 검출 (실내용 없음)"

                # 1. 기존 비의미 패턴 또는 2자 이하
                if text.lower() in [p.lower() for p in meaningless_patterns] or len(text) <= 2:
                    is_meaningless = True

                # 2. 자음/모음으로만 구성된 난타 (예: "ㅋㅋㅋ", "ㅎㅎㅎ", "ㅠㅠ", "ㅇㅇ", "ㄱㄱ")
                elif re.search(r'^[ㄱ-ㅎㅏ-ㅣ\s]+$', text):
                    is_meaningless = True
                    reason = "응답 품질 필터 자동 검출 (자음/모음 단순 입력)"

                # 3. 동일 문자의 3회 이상 연속 반복 (예: "가가가가", "aaaaa", ".....")
                elif re.search(r'^(.)\1{2,}$', text):
                    is_meaningless = True
                    reason = "응답 품질 필터 자동 검출 (동일 문자 반복)"

                # 4. 키보드 난타/무의미 알파벳 및 숫자 패턴 (예: "asdf", "qwerty", "1234", "123")
                elif re.search(r'^(asdf|qwerty|zxcv|1234|123|12345|qwer)$', text, re.IGNORECASE):
                    is_meaningless = True
                    reason = "응답 품질 필터 자동 검출 (키보드 난타/무의미 패턴)"

                if is_meaningless:
                    ans.is_excluded_from_report = True
                    ans.exclusion_reason = reason
                    ans.save()
                    excluded_count += 1

        return excluded_count

    @staticmethod
    def import_members_from_csv(csv_file):
        """CSV 파일에서 팀원 목록(이름, 이메일, Slack ID, 소속 부서) 일괄 추가/업데이트"""
        import csv
        import hashlib
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

        def get_col(row, *aliases):
            for a in aliases:
                for k, v in row.items():
                    if k and k.strip().lower() == a:
                        return (v or "").strip()
            return ""

        created_count = 0
        updated_count = 0

        for row_idx, row in enumerate(reader, start=1):
            if not row or not any(row.values()):
                continue

            name = get_col(row, '닉네임', '닉네임(발음)', 'nickname', '이름', 'name')
            if not name:
                continue

            email = get_col(row, 'email', '이메일')
            slack_id = get_col(row, 'slack_user_id', 'slack_id', 'slack')
            dept = get_col(row, '부서', '팀', 'team', 'department', '역할', 'role')

            # 이메일이 없을 때 고유한 가상 이메일 생성 (한글/비영문 이름 중복 유실 방지)
            if not email:
                norm_prefix = "".join(ch for ch in unicodedata.normalize('NFKC', name).lower() if ch.isalnum())
                if not norm_prefix:
                    name_hash = hashlib.md5(name.encode('utf-8')).hexdigest()[:6]
                    norm_prefix = f"user_{row_idx}_{name_hash}"
                else:
                    norm_prefix = f"{norm_prefix}_{row_idx}"
                email = f"{norm_prefix}@yourssu.com"

            # slack_user_id가 올바른 형식(U/W/D + 8~14자리 알파벳/숫자)이 아니면 빈값으로 두어 SlackService 자동 룩업에 맡김
            valid_id_regex = re.compile(r'^[UWD][A-Z0-9]{8,14}$')
            final_slack_id = slack_id if valid_id_regex.match(slack_id) else ""

            norm_name = unicodedata.normalize('NFKC', name).casefold()

            member, created = Member.objects.update_or_create(
                email=email,
                defaults={
                    'name': name,
                    'slack_user_id': final_slack_id,
                    'department': dept or "일반",
                    'normalized_name': norm_name,
                }
            )

            if created:
                created_count += 1
            else:
                updated_count += 1

        return {'created': created_count, 'updated': updated_count, 'total': created_count + updated_count}

