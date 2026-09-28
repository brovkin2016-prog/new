"""Embeddings-микросервис для семантической кластеризации.

Отдаёт векторы фраз (sentence-transformers). Вызывается backend'ом по HTTP.
Изолирует тяжёлые ML-зависимости от Node-приложения.
"""
import os
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

MODEL_NAME = os.getenv("MODEL_NAME", "paraphrase-multilingual-MiniLM-L12-v2")

app = FastAPI(title="pf embeddings", version="0.1.0")
model: SentenceTransformer | None = None


class EmbedRequest(BaseModel):
    texts: list[str]


class EmbedResponse(BaseModel):
    vectors: list[list[float]]
    model: str


@app.on_event("startup")
def load_model() -> None:
    global model
    model = SentenceTransformer(MODEL_NAME)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model": MODEL_NAME, "loaded": model is not None}


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest) -> EmbedResponse:
    assert model is not None, "model not loaded"
    if not req.texts:
        return EmbedResponse(vectors=[], model=MODEL_NAME)
    vectors = model.encode(req.texts, normalize_embeddings=True).tolist()
    return EmbedResponse(vectors=vectors, model=MODEL_NAME)
