FROM python:3.11-slim
WORKDIR /app
ENV HF_HOME=/app/.cache
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .
# Прогрев модели в образ (опц.): раскомментируйте для оффлайн-старта
# RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('paraphrase-multilingual-MiniLM-L12-v2')"
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
