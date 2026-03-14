"""Typer CLI for the image generation service."""

from __future__ import annotations

import os
import warnings

# Suppress FutureWarning from diffusers (e.g. deprecated enable_vae_slicing)
# and UserWarning from huggingface_hub (e.g. deprecated local_dir_use_symlinks)
warnings.filterwarnings("ignore", category=FutureWarning, module="diffusers")
warnings.filterwarnings("ignore", message=".*local_dir_use_symlinks.*")

# Disable tqdm progress bars from diffusers/transformers/huggingface_hub
os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
os.environ["DIFFUSERS_VERBOSITY"] = "error"
os.environ["TRANSFORMERS_VERBOSITY"] = "error"

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
