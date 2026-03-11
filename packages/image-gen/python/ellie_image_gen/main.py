"""FastAPI application for the image generation service."""

from __future__ import annotations

import time
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .core.errors import ImageGenError, ServiceBusyError, ValidationError

_start_time = time.monotonic()


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    app = FastAPI(title="Ellie Image Gen", version="0.1.0")

    # Register exception handlers
    @app.exception_handler(ImageGenError)
    async def handle_image_gen_error(request: Request, exc: ImageGenError) -> JSONResponse:
        request_id = getattr(request.state, "request_id", None)
        status = 409 if isinstance(exc, ServiceBusyError) else 422 if isinstance(exc, ValidationError) else 500
        return JSONResponse(
            status_code=status,
            content={"error": exc.to_dict(request_id)},
        )

    @app.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        request_id = getattr(request.state, "request_id", None)
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": "INTERNAL_ERROR",
                    "message": str(exc),
                    "retryable": False,
                    **({"requestId": request_id} if request_id else {}),
                }
            },
        )

    @app.middleware("http")
    async def add_request_id(request: Request, call_next):
        request.state.request_id = str(uuid.uuid4())
        response = await call_next(request)
        response.headers["X-Request-Id"] = request.state.request_id
        return response

    # Import and register routes
    from .api.routes import router
    app.include_router(router)

    return app
