import os
from io import BytesIO
from django.conf import settings
from django.core.files.base import ContentFile
from django.template.loader import render_to_string
from xhtml2pdf import pisa

from core.models import ReviewReport, ReviewAnswer, ReviewAssignment


class PDFReportService:
    @staticmethod
    def compile_feedback_data(cycle, reviewee):
        """
        특정 Reviewee가 특정 회차에서 받은 모든 피드백 데이터를 익명 집계
        """
        assignments = ReviewAssignment.objects.filter(
            cycle=cycle,
            reviewee=reviewee,
            is_submitted=True
        )

        questions_data = []
        questions = cycle.questions.all().order_by('order')

        for q in questions:
            answers = ReviewAnswer.objects.filter(assignment__in=assignments, question=q)
            q_info = {
                'question': q,
                'question_type': q.question_type,
                'content': q.content,
                'order': q.order,
                'answers_count': answers.count(),
            }

            if q.question_type == 'RATING':
                ratings = [a.rating_value for a in answers if a.rating_value is not None]
                if ratings:
                    q_info['avg_rating'] = round(sum(ratings) / len(ratings), 2)
                    q_info['max_rating'] = max(ratings)
                    q_info['min_rating'] = min(ratings)
                    q_info['ratings_list'] = ratings
                else:
                    q_info['avg_rating'] = 0
                    q_info['ratings_list'] = []

            elif q.question_type == 'TEXT':
                text_list = [a.answer_text.strip() for a in answers if a.answer_text and a.answer_text.strip()]
                q_info['text_answers'] = text_list

            elif q.question_type in ('SINGLE_CHOICE', 'MULTIPLE_CHOICE'):
                options_summary = []
                for opt in q.options.all().order_by('order'):
                    count = answers.filter(selected_options=opt).count()
                    options_summary.append({
                        'text': opt.option_text,
                        'count': count,
                    })
                q_info['options_summary'] = options_summary

            questions_data.append(q_info)

        return {
            'cycle': cycle,
            'reviewee': reviewee,
            'total_feedback_received': assignments.count(),
            'questions_data': questions_data,
        }

    @classmethod
    def generate_pdf_for_reviewee(cls, cycle, reviewee):
        """
        HTML 템플릿 렌더링 -> xhtml2pdf 변환 -> ReviewReport 모델 생성 및 파일 저장
        """
        data = cls.compile_feedback_data(cycle, reviewee)
        html_string = render_to_string('reports/peer_review_report.html', data)

        pdf_io = BytesIO()
        pisa_status = pisa.CreatePDF(
            src=html_string,
            dest=pdf_io,
            encoding='utf-8'
        )

        if pisa_status.err:
            raise RuntimeError(f"Error generating PDF report for {reviewee.name}: {pisa_status.err}")

        pdf_bytes = pdf_io.getvalue()
        file_name = f"peer_review_{cycle.id}_{reviewee.id}.pdf"

        # 기존 Report가 있다면 갱신, 없으면 신규 생성
        report, created = ReviewReport.objects.get_or_create(
            cycle=cycle,
            reviewee=reviewee
        )
        report.pdf_file.save(file_name, ContentFile(pdf_bytes), save=True)
        report.save()

        return report

    @classmethod
    def generate_all_reports_for_cycle(cls, cycle):
        """
        회차 내 모든 Reviewee에 대한 PDF 리포트 일괄 생성
        """
        reviewees = cycle.assignments.values_list('reviewee', flat=True).distinct()
        from core.models import Member
        reports = []
        for r_id in reviewees:
            member = Member.objects.get(id=r_id)
            report = cls.generate_pdf_for_reviewee(cycle, member)
            reports.append(report)
        return reports
