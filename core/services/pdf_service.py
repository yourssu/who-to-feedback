import os
import io
import math
import base64
import random
import gc

try:
    import logging
    logging.getLogger('matplotlib.font_manager').disabled = True
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import matplotlib.font_manager as fm
    import numpy as np

    font_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'static', 'fonts', 'Pretendard-Regular.ttf')
    if os.path.exists(font_path):
        fm.fontManager.addfont(font_path)
        font_prop = fm.FontProperties(fname=font_path)
        plt.rcParams['font.family'] = font_prop.get_name()
    else:
        plt.rcParams['font.family'] = 'NanumGothic'

    plt.rcParams['axes.unicode_minus'] = False
    HAS_MATPLOTLIB = True
except ImportError:
    HAS_MATPLOTLIB = False



from django.conf import settings
from django.template import Template, Context
from django.template.loader import render_to_string
from core.models import Member, ReviewReport, ReviewAnswer, ReviewAssignment, ReviewQuestion


class PDFReportService:
    TEXT_SCORE_MAP = {
        "매우 아님": 1.0, "매우아님": 1.0, "1점": 1.0, "1": 1.0,
        "약간 아님": 2.0, "약간아님": 2.0, "2점": 2.0, "2": 2.0,
        "보통임": 3.0, "보통": 3.0, "3점": 3.0, "3": 3.0,
        "약간 그럼": 4.0, "약간그럼": 4.0, "4점": 4.0, "4": 4.0,
        "매우 그럼": 5.0, "매우그럼": 5.0, "5점": 5.0, "5": 5.0,
    }

    @staticmethod
    def extract_score_from_answer(answer):
        """숫자형(NUMERIC_5) 및 글자형(TEXT_5) 답변을 1~5점 점수로 환산"""
        if answer.rating_value is not None and 1 <= answer.rating_value <= 5:
            return float(answer.rating_value)

        text_val = (answer.answer_text or "").strip()
        if text_val in PDFReportService.TEXT_SCORE_MAP:
            return PDFReportService.TEXT_SCORE_MAP[text_val]

        return None

    @staticmethod
    def generate_radar_chart_base64(labels, values):
        """방사형(Radar) 차트 Base64 이미지 자동 생성"""
        if not HAS_MATPLOTLIB or not labels or len(labels) < 3:
            return ""
        try:
            num_vars = len(labels)
            angles = np.linspace(0, 2 * np.pi, num_vars, endpoint=False).tolist()
            values_closed = values + values[:1]
            angles_closed = angles + angles[:1]

            fig, ax = plt.subplots(figsize=(4.5, 4.5), subplot_kw=dict(polar=True))
            ax.fill(angles_closed, values_closed, color='#8b7ce8', alpha=0.25)
            ax.plot(angles_closed, values_closed, color='#2b2d6e', linewidth=2.5)
            ax.set_yticklabels([])
            ax.set_xticks(angles)
            ax.set_xticklabels(labels, fontsize=9, fontweight='bold', color='#23244d')
            ax.set_ylim(0, 5)

            buf = io.BytesIO()
            plt.savefig(buf, format='png', bbox_inches='tight', transparent=True)
            plt.close(fig)
            buf.seek(0)
            return f"data:image/png;base64,{base64.b64encode(buf.read()).decode('utf-8')}"
        except Exception:
            return ""

    @staticmethod
    def generate_pie_chart_base64(labels, values):
        """원그래프(Pie/Donut Chart) Base64 이미지 자동 생성"""
        if not HAS_MATPLOTLIB or not labels or not values or sum(values) == 0:
            return ""
        try:
            fig, ax = plt.subplots(figsize=(4.5, 4.5))
            colors = ['#2B2D6E', '#8B7CE8', '#FFD14D', '#4F46E5', '#10B981', '#F59E0B']
            wedges, texts, autotexts = ax.pie(
                values, labels=labels, autopct='%1.1f%%',
                startangle=90, colors=colors[:len(labels)],
                wedgeprops=dict(width=0.4, edgecolor='w', linewidth=2)
            )
            plt.setp(autotexts, size=9, weight="bold", color="white")
            plt.setp(texts, size=9, weight="bold", color="#23244d")

            buf = io.BytesIO()
            plt.savefig(buf, format='png', bbox_inches='tight', transparent=True)
            plt.close(fig)
            buf.seek(0)
            return f"data:image/png;base64,{base64.b64encode(buf.read()).decode('utf-8')}"
        except Exception:
            return ""

    @staticmethod
    def generate_bar_chart_base64(labels, values):
        """막대그래프(Bar Chart) Base64 이미지 자동 생성"""
        if not HAS_MATPLOTLIB or not labels or not values:
            return ""
        try:
            fig, ax = plt.subplots(figsize=(5.5, 3.5))
            bars = ax.bar(labels, values, color='#8B7CE8', width=0.5, edgecolor='#2B2D6E', linewidth=1.2)
            ax.set_ylim(0, 5.5)
            ax.spines['top'].set_visible(False)
            ax.spines['right'].set_visible(False)
            ax.spines['left'].set_color('#E3E0F5')
            ax.spines['bottom'].set_color('#E3E0F5')

            for bar in bars:
                height = bar.get_height()
                ax.annotate(f'{height:.1f}',
                            xy=(bar.get_x() + bar.get_width() / 2, height),
                            xytext=(0, 3),
                            textcoords="offset points",
                            ha='center', va='bottom', fontsize=9, fontweight='bold', color='#2B2D6E')

            buf = io.BytesIO()
            plt.savefig(buf, format='png', bbox_inches='tight', transparent=True)
            plt.close(fig)
            buf.seek(0)
            return f"data:image/png;base64,{base64.b64encode(buf.read()).decode('utf-8')}"
        except Exception:
            return ""

    @staticmethod
    def generate_options_pie_chart_base64(options_summary):
        """선택형 문항 선택지 비율 원그래프(Pie Chart) Base64 이미지 생성"""
        if not HAS_MATPLOTLIB or not options_summary:
            return ""
        labels = [opt['text'] for opt in options_summary if opt['count'] > 0]
        counts = [opt['count'] for opt in options_summary if opt['count'] > 0]
        if not labels or sum(counts) == 0:
            return ""
        try:
            fig, ax = plt.subplots(figsize=(4.5, 4.5))
            colors = ['#4F46E5', '#8B7CE8', '#10B981', '#F59E0B', '#EF4444', '#6366F1', '#EC4899']
            wedges, texts, autotexts = ax.pie(
                counts, labels=labels, autopct='%1.1f%%',
                startangle=90, colors=colors[:len(labels)],
                wedgeprops=dict(width=0.4, edgecolor='w', linewidth=2)
            )
            plt.setp(autotexts, size=9, weight="bold", color="white")
            plt.setp(texts, size=9, weight="bold", color="#23244d")

            buf = io.BytesIO()
            plt.savefig(buf, format='png', bbox_inches='tight', transparent=True)
            plt.close(fig)
            buf.seek(0)
            return f"data:image/png;base64,{base64.b64encode(buf.read()).decode('utf-8')}"
        except Exception:
            return ""

    @staticmethod
    def generate_options_bar_chart_base64(options_summary):
        """선택형 문항 선택지 비율 막대그래프(Bar Chart) Base64 이미지 생성"""
        if not HAS_MATPLOTLIB or not options_summary:
            return ""
        labels = [opt['text'] for opt in options_summary]
        counts = [opt['count'] for opt in options_summary]
        pcts = [opt['percentage'] for opt in options_summary]
        if not labels:
            return ""
        try:
            fig, ax = plt.subplots(figsize=(5.5, 3.5))
            bars = ax.bar(labels, pcts, color='#4F46E5', width=0.5, edgecolor='#2B2D6E', linewidth=1.2)
            max_pct = max(pcts) if pcts else 100
            ax.set_ylim(0, max(100, max_pct + 15))
            ax.spines['top'].set_visible(False)
            ax.spines['right'].set_visible(False)
            ax.spines['left'].set_color('#E3E0F5')
            ax.spines['bottom'].set_color('#E3E0F5')

            for i, bar in enumerate(bars):
                pct = pcts[i]
                cnt = counts[i]
                ax.annotate(f'{pct}% ({cnt}명)',
                            xy=(bar.get_x() + bar.get_width() / 2, pct),
                            xytext=(0, 3),
                            textcoords="offset points",
                            ha='center', va='bottom', fontsize=9, fontweight='bold', color='#2B2D6E')

            buf = io.BytesIO()
            plt.savefig(buf, format='png', bbox_inches='tight', transparent=True)
            plt.close(fig)
            buf.seek(0)
            return f"data:image/png;base64,{base64.b64encode(buf.read()).decode('utf-8')}"
        except Exception:
            return ""

    @staticmethod
    def compile_feedback_data(cycle, reviewee):
        """순서(order) 및 관리자 카테고리 기반 결정적 Context & 자동 차트 객체 생성"""
        assignments = ReviewAssignment.objects.filter(cycle=cycle, reviewee=reviewee, is_submitted=True)
        questions = cycle.questions.all().order_by('order')

        font_path_raw = os.path.join(settings.BASE_DIR, 'core', 'static', 'fonts', 'Pretendard-Regular.ttf')
        font_path = f"file://{font_path_raw}" if not font_path_raw.startswith('file://') else font_path_raw
        total_feedback_cnt = assignments.count()

        context = {
            'cycle': cycle,
            'reviewee': reviewee,
            'total_reviewer_count': total_feedback_cnt,
            'total_feedback_received': total_feedback_cnt,
            'font_path': font_path,
            'questions': list(questions),
            'questions_data': [],
        }

        questions_data = []
        category_scores_map = {}

        # 1. 질문 순서(order 및 idx) 대응 q_N_ 치환 변수 및 1~5점 점수 환산
        for idx, q in enumerate(questions, start=1):
            answers = ReviewAnswer.objects.filter(assignment__in=assignments, question=q, is_excluded_from_report=False)
            keys = [f'q_{idx}_', f'q_{q.order}_']

            q_image_file_uri = f"file://{q.image.path}" if q.image and os.path.exists(q.image.path) else ""
            q_image_url = q_image_file_uri or (q.image.url if q.image else "")
            q_image_path = q.image.path if q.image and os.path.exists(q.image.path) else ""

            for k in set(keys):
                context[f'{k}content'] = q.content
                context[f'{k}type'] = q.question_type
                context[f'{k}category'] = q.category or "기본 역량"
                context[f'{k}image_url'] = q_image_url
                context[f'{k}image_path'] = q_image_path

            q_data = {
                'order': q.order,
                'content': q.content,
                'category': q.category or "기본 역량",
                'image_url': q_image_url,
                'image_path': q_image_path,
                'question_type': q.question_type,
                'avg_rating': 0,
                'avg_rating_label': '0.0점',
                'rating_percent': 0,
                'min_rating': 0,
                'max_rating': 0,
                'text_answers': [],
                'options_summary': [],
                'pie_chart_base64': '',
                'bar_chart_base64': '',
            }

            if q.question_type == 'RATING':
                scores = []
                for a in answers:
                    sc = PDFReportService.extract_score_from_answer(a)
                    if sc is not None:
                        scores.append(sc)

                if scores:
                    avg_val = round(sum(scores) / len(scores), 2)
                    pct_val = int((avg_val / 5.0) * 100)
                    for k in set(keys):
                        context[f'{k}avg_rating'] = avg_val
                        context[f'{k}rating_percent'] = pct_val

                    q_data['avg_rating'] = avg_val
                    q_data['avg_rating_label'] = f"{avg_val:.1f}점 / 5.0점"
                    q_data['rating_percent'] = pct_val
                    q_data['min_rating'] = round(min(scores), 1)
                    q_data['max_rating'] = round(max(scores), 1)

                    cat_name = q.category.strip() if q.category and q.category.strip() else "기본 역량"
                    category_scores_map.setdefault(cat_name, []).extend(scores)
                else:
                    for k in set(keys):
                        context[f'{k}avg_rating'] = 0
                        context[f'{k}rating_percent'] = 0

            elif q.question_type == 'TEXT':
                text_list = [a.answer_text.strip() for a in answers if a.answer_text and a.answer_text.strip()]
                random.shuffle(text_list)
                for k in set(keys):
                    context[f'{k}text_answers'] = text_list
                q_data['text_answers'] = text_list

            elif q.question_type in ['SINGLE_CHOICE', 'MULTIPLE_CHOICE']:
                options_summary = []
                for opt in q.options.all().order_by('order'):
                    count = answers.filter(selected_options=opt).count()
                    pct = int((count / total_feedback_cnt * 100)) if total_feedback_cnt > 0 else 0
                    options_summary.append({
                        'text': opt.option_text,
                        'count': count,
                        'percentage': pct
                    })
                for k in set(keys):
                    context[f'{k}options_summary'] = options_summary
                q_data['options_summary'] = options_summary

                # 선택형 문항 전용 원/막대 그래프 Base64 이미지 주입
                pie_b64 = PDFReportService.generate_options_pie_chart_base64(options_summary)
                bar_b64 = PDFReportService.generate_options_bar_chart_base64(options_summary)

                for k in set(keys):
                    context[f'{k}pie_chart_base64'] = pie_b64
                    context[f'{k}bar_chart_base64'] = bar_b64

                q_data['pie_chart_base64'] = pie_b64
                q_data['bar_chart_base64'] = bar_b64

            questions_data.append(q_data)

        # 2. 관리자 카테고리별 평균 점수 & N-각형 방사형 차트 좌표 연산
        category_summary = []
        cat_names = []
        cat_scores = []
        radar_pts = []

        if category_scores_map:
            num_cats = len(category_scores_map)
            for i, (cat_name, scores_list) in enumerate(category_scores_map.items()):
                avg_sc = round(sum(scores_list) / len(scores_list), 2) if scores_list else 0.0
                pct_sc = int((avg_sc / 5.0) * 100)
                category_summary.append({
                    'name': cat_name,
                    'avg': avg_sc,
                    'pct': pct_sc,
                    'count': len(scores_list)
                })
                cat_names.append(cat_name)
                cat_scores.append(avg_sc)

                angle_deg = (360.0 / num_cats) * i if num_cats > 0 else 0
                radius = (avg_sc / 5.0) * 220
                angle_rad = math.radians(angle_deg - 90)
                x = 250 + radius * math.cos(angle_rad)
                y = 250 + radius * math.sin(angle_rad)
                radar_pts.append(f"{x:.1f},{y:.1f}")

        context['questions_data'] = questions_data
        context['category_summary'] = category_summary
        context['radar_points'] = " ".join(radar_pts)

        # 3. 전체 카테고리 기반 Base64 차트 이미지 주입
        context['radar_chart_base64'] = PDFReportService.generate_radar_chart_base64(cat_names, cat_scores)
        context['pie_chart_base64'] = PDFReportService.generate_pie_chart_base64(cat_names, cat_scores)
        context['bar_chart_base64'] = PDFReportService.generate_bar_chart_base64(cat_names, cat_scores)

        return context

    @staticmethod
    def generate_pdf_report(cycle, reviewee):
        """커스텀/기본 HTML 양식 적용 및 한글/차트 깨짐 0% PDF 동적 렌더링"""
        report, _ = ReviewReport.objects.get_or_create(cycle=cycle, reviewee=reviewee)
        try:
            context = PDFReportService.compile_feedback_data(cycle, reviewee)
            font_path = context['font_path']

            if cycle.use_custom_template and cycle.custom_html_file and os.path.exists(cycle.custom_html_file.path):
                with open(cycle.custom_html_file.path, 'r', encoding='utf-8') as f:
                    template_src = f.read()
                template = Template(template_src)
                html_content = template.render(Context(context))
            else:
                html_content = render_to_string('reports/peer_review_report.html', context)

            font_style_injection = f"""
            <style>
                @font-face {{
                    font-family: 'KoreanPDF';
                    src: url('{font_path}');
                }}
                html, body, div, p, span, h1, h2, h3, h4, h5, h6, table, td, th, li, a, strong, small, article, section {{
                    font-family: 'KoreanPDF', sans-serif !important;
                }}
            </style>
            """
            
            if '</head>' in html_content:
                html_content = html_content.replace('</head>', f'{font_style_injection}</head>')
            else:
                html_content = font_style_injection + html_content

            output_dir = os.path.join(settings.MEDIA_ROOT, 'reports_pdf')
            os.makedirs(output_dir, exist_ok=True)
            filename = f"peer_review_{cycle.id}_{reviewee.id}.pdf"
            full_path = os.path.join(output_dir, filename)

            # Playwright + Pillow 기반 100% 픽셀 일치 PNG 캡처 (6K UHD 6144x3456 초고해상도) ➔ 16:9 와이드 PDF 병합 파이프라인
            from playwright.sync_api import sync_playwright
            from PIL import Image

            with sync_playwright() as p:
                browser = p.chromium.launch(
                    headless=True,
                    args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
                )
                try:
                    page = browser.new_page(
                        viewport={"width": 3840, "height": 2160},
                        device_scale_factor=1
                    )
                    page.set_content(html_content, wait_until="domcontentloaded", timeout=15000)

                    slide_elements = page.query_selector_all('.slide')
                    png_images = []

                    if slide_elements:
                        for idx, slide_el in enumerate(slide_elements):
                            png_bytes = slide_el.screenshot(type="png")
                            img = Image.open(io.BytesIO(png_bytes)).convert('RGB')
                            png_images.append(img)
                    else:
                        png_bytes = page.screenshot(type="png", full_page=True)
                        img = Image.open(io.BytesIO(png_bytes)).convert('RGB')
                        png_images.append(img)
                finally:
                    browser.close()

                if png_images:
                    png_images[0].save(full_path, save_all=True, append_images=png_images[1:], resolution=600.0)
                else:
                    raise RuntimeError("Playwright에서 캡처된 슬라이드 이미지가 없습니다.")

            gc.collect()

            report.pdf_file.name = f"reports_pdf/{filename}"
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
    def generate_all_pdf_reports(cycle):
        """회차 내 모든 피드백 수신 대상자에 대한 PDF 일괄 생성"""
        reviewees = Member.objects.filter(received_reviews__cycle=cycle).distinct()
        reports = []
        for reviewee in reviewees:
            rep = PDFReportService.generate_pdf_report(cycle, reviewee)
            reports.append(rep)
        return reports

    @staticmethod
    def generate_all_reports_for_cycle(cycle):
        """회차 내 모든 피드백 수신 대상자에 대한 PDF 일괄 생성 (호환용)"""
        return PDFReportService.generate_all_pdf_reports(cycle)
