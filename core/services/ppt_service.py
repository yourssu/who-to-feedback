import os
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from django.conf import settings
from django.core.files.base import ContentFile
from core.models import ReviewReport, ReviewAnswer, ReviewAssignment, ReviewQuestion
from core.services.pdf_service import PDFReportService


class PPTReportService:
    @staticmethod
    def generate_ppt_report(cycle, reviewee):
        """python-pptx 기반 피어리뷰 PPT 리포트 자동 생성"""
        prs = Presentation()
        prs.slide_width = Inches(10)
        prs.slide_height = Inches(5.625)

        # Slide 1: 표지
        blank_slide_layout = prs.slide_layouts[6]
        slide1 = prs.slides.add_slide(blank_slide_layout)

        tb1 = slide1.shapes.add_textbox(Inches(1), Inches(1.5), Inches(8), Inches(2))
        tf1 = tb1.text_frame
        p1 = tf1.paragraphs[0]
        p1.text = f"🎉 {cycle.title}"
        p1.font.size = Pt(28)
        p1.font.bold = True
        p1.font.color.rgb = RGBColor(79, 70, 229) # #4F46E5

        p2 = tf1.add_paragraph()
        p2.text = f"{reviewee.name}님 피어리뷰 피드백 리포트"
        p2.font.size = Pt(20)
        p2.font.color.rgb = RGBColor(31, 41, 55)

        # Slide 2: 문항별 피드백 요약
        slide2 = prs.slides.add_slide(blank_slide_layout)
        tb2 = slide2.shapes.add_textbox(Inches(0.8), Inches(0.8), Inches(8.4), Inches(4.2))
        tf2 = tb2.text_frame

        p_head = tf2.paragraphs[0]
        p_head.text = "📌 문항별 상세 익명 피드백 요약"
        p_head.font.size = Pt(20)
        p_head.font.bold = True

        data = PDFReportService.compile_feedback_data(cycle, reviewee)
        for q_info in data['questions_data'][:4]:
            p_q = tf2.add_paragraph()
            p_q.text = f"\n• Q{q_info['order']}. {q_info['content']}"
            p_q.font.size = Pt(14)
            p_q.font.bold = True

            if q_info['question_type'] == 'RATING':
                p_a = tf2.add_paragraph()
                p_a.text = f"   👉 {q_info.get('avg_rating_label', '응답 없음')}"
                p_a.font.size = Pt(12)
            elif q_info['question_type'] == 'TEXT':
                for txt in q_info['text_answers'][:2]:
                    p_a = tf2.add_paragraph()
                    p_a.text = f"   💬 \"{txt}\""
                    p_a.font.size = Pt(11)

        # PPT 파일 저장
        output_dir = os.path.join(settings.MEDIA_ROOT, 'reports_ppt')
        os.makedirs(output_dir, exist_ok=True)
        filename = f"peer_review_{cycle.id}_{reviewee.id}.pptx"
        full_path = os.path.join(output_dir, filename)
        prs.save(full_path)

        # ReviewReport DB 갱신
        report, _ = ReviewReport.objects.get_or_create(cycle=cycle, reviewee=reviewee)
        rel_path = f"reports_ppt/{filename}"
        report.ppt_file.name = rel_path
        report.validation_status = 'APPROVED'
        report.save()

        return report
