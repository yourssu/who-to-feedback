# 웹·보고서 폰트 자산

`Pretendard-Regular.woff2`는 기존 `Pretendard-Regular.ttf`를 압축한 파일입니다. 서체를 교체하거나 글자를 제거하지 않았습니다. 기존 파일명은 실제 내장 서체 이름과 다를 수 있으므로 그대로 보존했습니다.

- TTF: 15,255,648 bytes
- WOFF2: 3,934,212 bytes (약 74.2% 감소)
- fontTools 4.66.1 / Brotli 1.2.0으로 변환
- 원본과 압축본의 19,810개 glyph 윤곽, 가로 advance, Unicode cmap을 비교해 동일함을 확인

웹사이트와 기본 결과지는 WOFF2를 사용합니다. 차트 윤곽선 생성과 명시적으로 `format('truetype')`를 사용하는 기존 커스텀 양식은 TTF를 사용합니다. 런타임·CI·Docker에서 폰트를 다시 변환하거나 Python을 설치하지 않습니다.

원본을 갱신할 때 개발 환경에서 다음 명령으로 압축본을 다시 생성할 수 있습니다. 별도 임시 Python 가상환경에 `fonttools[woff]==4.66.1`을 설치하고 저장소 루트에서 실행합니다.

```sh
python -m fontTools.ttLib.woff2 compress core/static/fonts/Pretendard-Regular.ttf -o core/static/fonts/Pretendard-Regular.woff2
```

변환은 [fontTools WOFF2 공식 문서](https://fonttools.readthedocs.io/en/latest/ttLib/woff2.html)를 따릅니다. 파일 사용 권한은 원본 폰트의 조건을 따르며 압축은 라이선스를 변경하지 않습니다.
