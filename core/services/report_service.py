from core.models import Member, ReviewReport, ReviewAssignment
from core.services.pdf_service import PDFReportService
from core.services.ppt_service import PPTReportService


class ReportManagementService:
    @staticmethod
    def generate_sample_reports(cycle, sample_count=3):
        """실제 발송 전에 샘플 2~3명만 선택해 PDF/PPT 미리보기 생성 및 템플릿 테스트 모드 구동"""
        assignments = cycle.assignments.all()
        reviewees = list(set(a.reviewee for a in assignments))[:sample_count]

        reports = []
        for rev in reviewees:
            pdf_rep = PDFReportService.generate_pdf_report(cycle, rev)
            ppt_rep = PPTReportService.generate_ppt_report(cycle, rev)
            reports.append(pdf_rep)

        return reports

    @staticmethod
    def get_delivery_checklist(cycle):
        """Slack 발송 전 이름 / 팀 / Slack ID / PDF 존재 여부 / 승인 여부 5가지 통합 체크리스트 집계"""
        reviewees = Member.objects.filter(received_reviews__cycle=cycle).distinct()
        checklist = []

        for m in reviewees:
            report = ReviewReport.objects.filter(cycle=cycle, reviewee=m).first()

            has_slack_id = bool(m.slack_user_id and m.slack_user_id.startswith('U'))
            has_pdf = bool(report and report.pdf_file and report.pdf_file.name)
            is_approved = bool(report and report.validation_status == 'APPROVED')
            is_ready = has_slack_id and has_pdf and is_approved

            issues = []
            if not has_slack_id:
                issues.append("Slack User ID 누락")
            if not has_pdf:
                issues.append("PDF 리포트 미생성")
            if not is_approved:
                issues.append("관리자 승인 미완료")

            checklist.append({
                'member': m,
                'department': m.department or '부서 미지정',
                'slack_user_id': m.slack_user_id,
                'has_slack_id': has_slack_id,
                'has_pdf': has_pdf,
                'is_approved': is_approved,
                'is_ready': is_ready,
                'issues_summary': ", ".join(issues) if issues else "발송 준비 완료",
            })

        return checklist
