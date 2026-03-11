"""Typer CLI for the image generation service."""

from __future__ import annotations

import typer

app = typer.Typer(name="ellie-image-gen", help="Ellie image generation service")


@app.command()
def serve(
    host: str = typer.Option("127.0.0.1", help="Bind host"),
    port: int = typer.Option(9819, help="Bind port"),
    reload: bool = typer.Option(False, help="Enable auto-reload for development"),
) -> None:
    """Start the FastAPI image generation service."""
    import uvicorn

    uvicorn.run(
        "ellie_image_gen.main:create_app",
        factory=True,
        host=host,
        port=port,
        reload=reload,
        log_level="info",
    )


if __name__ == "__main__":
    app()
