# Сторонние модели и программы (ИИ-помощник, сервер)

- **Indra OCR** (v37, «Учёба»: печатный текст заданий читается на сервере) — код Apache-2.0,
  https://github.com/datalab-to/indra; веса — изменённая лицензия OpenRAIL-M (Datalab), https://huggingface.co/datalab-to/indra-ocr
  (версия v1.1.0). Веса в репозиторий не кладутся: сервер скачивает их при установке и сверяет по SHA-256.
  Ограничения лицензии весов действуют и на результат распознавания.
- **moli** (v37, поиск: страницы, которые рисуют скрипты) — Apache-2.0 или MIT, https://github.com/lexmount/moli, выпуск
  v1.1.19, проверяется по SHA-256; лицензии лежат рядом с программой на сервере (/opt/aibot/moli/).
- **anydoc** (v37, «Учёба»: старые .doc/.ppt/.xls, .xlsx, OpenDocument, RTF в текст) — MIT, https://github.com/firecrawl/anydoc,
  выпуск 0.2.4 (пакет firecrawl-anydoc), колесо сверяется по SHA-256, из исходников не собирается.
- **Kaggle CLI** (v37, ролики на своём GPU владельца) — Apache-2.0, https://github.com/Kaggle/kaggle-cli, 2.2.5 с
  зависимостями по замку хэшей (только колёса). Модели LTX-Video (Lightricks, LTX-Video Open Weights License) и
  CogVideoX-5B-I2V (THUDM, CogVideoX License) на сервер не ставятся: их скачивает и запускает блокнот на аккаунте Kaggle
  владельца, для семьи.
- **Onest** (v40, шрифт помощника и Winger, дизайн «Северное сияние») — SIL Open Font License 1.1,
  https://github.com/simpals/onest; в помощнике — внутри fonts.css (текст лицензии там же), в Winger — в ресурсах приложения.
- **Caveat** (v40, «✍️ Переписать аккуратно»: рукописный почерк на листе) — SIL Open Font License 1.1,
  https://github.com/googlefonts/caveat; сервер скачивает файл при установке из google/fonts и сверяет по SHA-256.
- **LivePortrait** (v40, живая мимика роликов на Kaggle владельца) — MIT, https://github.com/KwaiVGI/LivePortrait; детектор
  лиц InsightFace — только некоммерческое использование (у нас — семья). На сервер не ставится: работает в блокноте Kaggle.
- **Kandinsky 6.0 Lite** (v40, ролики на Kaggle владельца) — MIT, https://huggingface.co/kandinskylab; на сервер не ставится.

