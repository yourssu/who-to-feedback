# 커스텀 HTML 리포트 템플릿 제작 및 변수 가이드 (Custom HTML Template Guide)

본 문서는 디자이너나 피어리뷰 관리자가 **PeerFlow 시스템에 커스텀 HTML 양식 파일(.html)**을 업로드하여 멤버별 결과지 PDF를 자동으로 동적 생성할 때 사용하는 **치환 변수, 질문 첨부 이미지, 동적 차트 이미지 및 CSS 표준 가이드**입니다.

---

## 1. 16:9 PPT 와이드 PDF 규격 및 CSS 필수 규칙

PDF 변환 시 한글 글꼴 깨짐이나 레이아웃 넘어감 없이 **100% 깔끔하게 출력**되도록 아래 표준 스타일을 HTML 문서 상단 `<style>` 태그에 포함시켜 주십시오.

```html
<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <title>PEER REVIEW REPORT</title>
    <style>
        /* 1. 한글 글꼴 시스템 로컬 경로 자동 주입 */
        @font-face {
            font-family: 'Pretendard';
            src: url('{{ font_path }}') format('truetype');
        }
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            font-family: 'Pretendard', sans-serif;
        }

        /* 2. 16:9 Widescreen PPT 슬라이드 규격 (297mm x 167mm) */
        @page {
            size: 297mm 167mm;
            margin: 0;
        }
        .slide {
            width: 297mm;
            height: 167mm;
            padding: 15mm 20mm;
            page-break-after: always;
            overflow: hidden;
            position: relative;
            background: #ffffff;
        }
    </style>
</head>
```

---

## 2. 자동 그래프 이미지 및 관리자 카테고리 변수

백엔드가 척도형/선택형 문항 데이터를 분석하여 **JS 미구동 환경(xhtml2pdf)에서도 100% 안 깨지고 출력되는 Base64 그래프 이미지**와 데이터 배열을 자동 생성해 줍니다.

### 2.1 카테고리별 동적 차트 Base64 이미지 변수 (전체 요약용)

| 변수명 | 그래프 종류 | 사용 예시 |
|---|---|---|
| `{{ radar_chart_base64 }}` | **카테고리 방사형 레이더 차트** | `<img src="{{ radar_chart_base64 }}" style="width:380px;">` |
| `{{ pie_chart_base64 }}` | **카테고리 원그래프 (Donut/Pie Chart)** | `<img src="{{ pie_chart_base64 }}" style="width:380px;">` |
| `{{ bar_chart_base64 }}` | **카테고리 막대그래프 (Bar Chart)** | `<img src="{{ bar_chart_base64 }}" style="width:420px;">` |

---

### 2.2 선택형 문항 선택지 비율 그래프 Base64 이미지 변수 (N = 질문 순서 번호)

| 변수명 | 그래프 종류 | 사용 예시 |
|---|---|---|
| `{{ q_N_pie_chart_base64 }}` | **선택지 선택 비율 원그래프** | `<img src="{{ q_3_pie_chart_base64 }}" style="width:350px;">` |
| `{{ q_N_bar_chart_base64 }}` | **선택지 선택 비율 막대그래프** | `<img src="{{ q_3_bar_chart_base64 }}" style="width:400px;">` |

---

## 3. 질문 순서(`q_N_`)별 치환 변수 및 질문 첨부 이미지 (N = 질문 순서 번호)

### 3.1 질문 내용 및 첨부 이미지 변수

| 변수명 | 설명 | 출력 예시 |
|---|---|---|
| `{{ q_N_content }}` | N번 질문 내용/문구 | `스스로 문제를 발견하는가` |
| `{{ q_N_category }}` | N번 질문 관리자 카테고리 | `Active Ownership` |
| `{{ q_N_image_url }}` | **N번 질문 첨부 이미지 URL** | `/media/question_images/sample.jpg` |

**💡 질문 첨부 이미지 사용 HTML 예시:**
```html
<div class="question-header">
    <h2>Q{{ q_1_order }}. {{ q_1_content }}</h2>
    {% if q_1_image_url %}
        <div class="question-img-box">
            <img src="{{ q_1_image_url }}" alt="질문 첨부 이미지" style="max-width:100%; max-height:250px; border-radius:6px; margin:10px 0;">
        </div>
    {% endif %}
</div>
```

---

### 3.2 5점 척도 문항 (`RATING` 타입 - 숫자형/글자형 1~5점 통합 점수화)

| 변수명 | 설명 | 출력 예시 |
|---|---|---|
| `{{ q_1_avg_rating }}` | 1번 질문 5점 만점 평균 점수 | `4.6` |
| `{{ q_1_rating_percent }}` | 1번 질문 백분율 점수 (0~100) | `92` |

---

### 3.3 서술형 주관식 문항 (`TEXT` 타입 - 답변에는 이미지 포함 안 됨)

| 변수명 | 설명 | 데이터 유형 |
|---|---|---|
| `{{ q_2_text_answers }}` | 2번 서술형 무기명 피드백 목록 | 배열 (Array) |

---

### 3.4 객관식 선택 문항 (`SINGLE_CHOICE`, `MULTIPLE_CHOICE` 타입)

| 변수명 | 설명 | 데이터 구조 |
|---|---|---|
| `{{ q_3_options_summary }}` | 선택지별 응답 수 및 비율 목록 | 배열 (객체: `text`, `count`, `percentage`) |
| `{{ q_3_pie_chart_base64 }}` | 3번 선택지 비율 원그래프 이미지 | Base64 스트링 |
| `{{ q_3_bar_chart_base64 }}` | 3번 선택지 비율 막대그래프 이미지 | Base64 스트링 |

---

## 4. 커스텀 HTML 양식 업로드 및 적용 방법

1. PeerFlow 관리자 센터 ➔ **[결과 검토 & 리포트 관리]** (`/admin-panel/cycles/<cycle_id>/reports/`) 페이지 이동
2. **[커스텀 HTML 양식 업로드]** 영역에서 준비한 `.html` 파일을 선택 후 `[양식 업로드 및 적용]` 클릭
3. 업로드 완료 즉시 질문 첨부 이미지, 척도/선택형 동적 그래프(원그래프, 막대그래프, 방사형 그래프)가 주입되어 16:9 와이드 PDF로 자동 생성됩니다.
