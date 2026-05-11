"""users service for Microservice Migration Battle.

EC2 上の docker compose / Lambda + API Gateway / ECS Fargate / AWS App Runner の
いずれにも乗せられるよう、依存は FastAPI + uvicorn のみに絞っている。

`/score` は高速経路、`/score?legacy=true` は意図的に遅い経路 (= 競技者が修正対象)。
プラットフォームは環境変数 TC_PLATFORM で切り替える (ec2 / lambda / ecs / apprunner)。
"""

from __future__ import annotations

import os
import random
import time
from typing import Any

from fastapi import FastAPI

SERVICE_NAME = "users"
VERSION = "1.0.0"

app = FastAPI(title=f"TenkaCloud Battle — {SERVICE_NAME}")


def _platform() -> str:
    return os.environ.get("TC_PLATFORM", "ec2")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/meta")
def meta() -> dict[str, str]:
    return {
        "service": SERVICE_NAME,
        "platform": _platform(),
        "version": VERSION,
    }


@app.get("/score")
def score(legacy: bool = False) -> dict[str, Any]:
    if legacy:
        return _legacy_score()
    return _fast_score()


def _fast_score() -> dict[str, Any]:
    return {
        "service": SERVICE_NAME,
        "score": random.randint(50, 100),
        "via": "fast",
    }


def _legacy_score() -> dict[str, Any]:
    # 旧実装の名残: 同じ結果を返すために 2 秒待たせる必要は本当はない。
    # 競技者はこの遅延を取り除くこと。
    time.sleep(2.0)
    return {
        "service": SERVICE_NAME,
        "score": random.randint(50, 100),
        "via": "legacy",
    }
