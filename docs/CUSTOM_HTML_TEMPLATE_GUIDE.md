# 커스텀 보고서 양식

관리자 리포트 화면에서 `.html` 양식을 업로드하고 사용 여부를 전환할 수 있습니다. 변경하면 기존 보고서의 HTML·PDF와 승인을 무효화하므로 개별 재생성 후 다시 검토합니다. CLOSED 회차와 발송 중·수신 확인 필요 보고서의 변경은 차단합니다.

## 변수와 문법

`reviewee.name`, `reviewee.department`, `cycle.title`, `cycle.version`, `total_feedback_received`, `category_summary`, `questions_data`, `question_pages`, `font_path`를 사용할 수 있습니다. 작성자·매칭 데이터는 제공하지 않습니다.

문항의 순서 번호를 N으로 하여 `q_N_content`, `q_N_category`, `q_N_image_url`, `q_N_avg_rating`, `q_N_rating_percent`, `q_N_text_answers`, `q_N_options_summary`, `q_N_pie_chart_base64`, `q_N_bar_chart_base64`를 제공합니다. 선택지 집계는 `text`, `count`, `percentage`를 포함합니다. 차트·이미지·폰트는 서버 경로가 아닌 data URL입니다.

양식은 변수 치환, 단순 `if/else/endif`, `for/endfor`만 허용합니다. 필터, 함수 호출, include/import 및 프로토타입 접근은 허용하지 않습니다. 사용자 데이터는 HTML escape 처리합니다. 기본 제공 템플릿의 문법과 업로드 가능한 문법은 다릅니다.

```html
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <style>
    @font-face { font-family: Report; src: url('{{ font_path }}'); }
    body { margin: 0; font-family: Report, sans-serif; }
    .slide { box-sizing: border-box; width: 1280px; height: 720px; padding: 60px; break-after: page; }
    .slide:last-child { break-after: auto; }
    p { white-space: pre-wrap; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <section class="slide"><h1>{{ reviewee.name }} 피어리뷰</h1><p>{{ cycle.title }}</p></section>
  {% for q in question_pages %}
  <section class="slide">
    <h2>{{ q.content }}</h2>
    {% for answer in q.text_answers %}<p>{{ answer }}</p>{% endfor %}
    {% for option in q.options_summary %}<p>{{ option.text }}: {{ option.percentage }}%</p>{% endfor %}
  </section>
  {% endfor %}
</body>
</html>
```

## 출력과 검수

현재 PDF 변환기는 1280 × 720px 페이지와 여백 0을 적용합니다. `src/reporting/print-style.ts`가 인쇄 설정을 관리하므로 기존 297mm 안내를 그대로 적용하지 않습니다. 외부 CSS·이미지·폰트 요청과 문서 스크립트는 PDF에서 실행하지 않습니다.

기본 `question_pages`는 긴 피드백과 많은 선택지를 나눕니다. 커스텀 양식의 글꼴 크기·여백·컬럼 수가 다르면 배치가 달라질 수 있으므로 HTML·PDF에서 모든 페이지를 검수합니다. 사전 점검은 시각 검수 완료를 뜻하지 않습니다.

PDF 디자인을 바꿀 때는 이 양식과 인쇄 스타일을 수정하고 페이지 수·한글 원문 보존 검증 및 PDF 렌더링 검수를 수행합니다. 웹 앱의 관리자·리뷰어 화면과 집계 로직은 별도입니다.
