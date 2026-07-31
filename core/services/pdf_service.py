import os
import random
from django.template.loader import render_to_string
from django.conf import settings
from django.core.files.base import ContentFile
from xhtml2pdf import pisa

from core.models import ReviewReport, ReviewAnswer, ReviewAssignment, ReviewQuestion


class PDFReportService:
    @staticmethod
    def compile_feedback_data(cycle, reviewee):
        """Reviewee별 피드백 익명 집계 데이터 생성 (익명성 보장 - 작성자 정보 완전 제거)"""
        assignments = ReviewAssignment.objects.filter(cycle=cycle, reviewee=reviewee, is_submitted=True)
        questions = cycle.questions.all().order_by('order')

        questions_data = []
        text_5_map = {1: "매우 아님", 2: "약간 아님", 3: "보통임", 4: "약간 그럼", 5: "매우 그럼"}

        for q in questions:
            answers = ReviewAnswer.objects.filter(
                assignment__in=assignments,
                question=q,
                is_excluded_from_report=False # 응답 품질 필터로 정제된 답변만 집계
            )
            q_info = {
                'id': q.id,
                'order': q.order,
                'question_type': q.question_type,
                'content': q.content,
            }

            if q.question_type == 'RATING':
                ratings = [a.rating_value for a in answers if a.rating_value is not None]
                if ratings:
                    avg_val = round(sum(ratings) / len(ratings), 2)
                    q_info['avg_rating'] = avg_val
                    q_info['max_rating'] = max(ratings)
                    q_info['min_rating'] = min(ratings)
                    q_info['ratings_list'] = ratings

                    if q.scale_type == 'TEXT_5':
                        closest_val = int(round(avg_val))
                        closest_val = max(1, min(5, closest_val))
                        q_info['avg_rating_label'] = f"{text_5_map[closest_val]} ({avg_val}점)"
                    else:
                        q_info['avg_rating_label'] = f"평균 {avg_val}점 / 5.0점"
                else:
                    q_info['avg_rating'] = 0
                    q_info['avg_rating_label'] = "응답 없음"
                    q_info['ratings_list'] = []

            elif q.question_type == 'TEXT':
                # 익명성 보장: 작성자 정보를 배제하고 무작위 순서(random.shuffle)로 정렬
                text_list = [a.answer_text for a in answers if a.answer_text]
                random.shuffle(text_list)
                q_info['text_answers'] = text_list

            elif q.question_type in ['SINGLE_CHOICE', 'MULTIPLE_CHOICE']:
                options_summary = []
                for opt in q.options.all().order_by('order'):
                    count = answers.filter(selected_options=opt).count()
                    options_summary.append({
                        'text': opt.option_text,
                        'count': count
                    })
                q_info['options_summary'] = options_summary

            questions_data.append(q_info)

        return {
            'cycle': cycle,
            'reviewee': reviewee,
            'total_reviewer_count': assignments.count(),
            'questions_data': questions_data,
        }

    @staticmethod
    def generate_pdf_report(cycle, reviewee):
        """피드백 집계 후 xhtml2pdf로 PDF 생성 및 ReviewReport 객체 저장 (예외 처리 로그 보존)"""
        report, _ = ReviewReport.objects.get_or_create(cycle=cycle, reviewee=reviewee)

        try:
            context = PDFReportService.compile_feedback_data(cycle, reviewee)
            html_content = render_to_string('reports/peer_review_report.html', context)

            output_dir = os.path.join(settings.MEDIA_ROOT, 'reports_pdf')
            os.makedirs(output_dir, exist_ok=True)

            filename = f"peer_review_{cycle.id}_{reviewee.id}.pdf"
            full_path = os.path.join(output_dir, filename)

            with open(full_path, 'wb') as pdf_file:
                pisa_status = pisa.CreatePDF(html_content, dest=pdf_file)

            if pisa_status.err:
                report.validation_status = 'FAILED'
                report.error_log = f"pisa PDF generation error code: {pisa_status.err}"
                report.save()
                return report

            rel_path = f"reports_pdf/{filename}"
            report.pdf_file.name = rel_path
            report.validation_status = 'APPROVED'
            report.error_log = ""
            report.save()
            return report

        except Exception as e:
            report.validation_status = 'FAILED'
            report.error_log = str(e)
            report.save()
            return report

    @staticmethod
    def generate_all_reports_for_cycle(cycle):
        """회차 내 모든 Reviewee 대상 PDF 리포트 생성"""
        reviewees = set(a.reviewee for a in cycle.assignments.all())
        reports = []
        for r in reviewees:
            rep = PDFReportService.generate_pdf_report(cycle, r)
            reports.append(rep)
        return reports
