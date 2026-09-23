from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    PROPÓSITO: Centralizar umbrales de silencio, rutas locales y la API de DeepSeek.
    CONEXIONES: Variables de entorno. Sin base de datos.
    """

    model_config = SettingsConfigDict(
        env_file=Path(__file__).resolve().parents[1] / ".env",
        extra="ignore",
    )

    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-chat"
    data_dir: Path = Path("./data")
    silence_noise_db: str = "-32dB"
    silence_min_duration: float = 0.45
    silence_pad: float = 0.18
    cors_origins: list[str] = ["http://localhost:3001", "http://127.0.0.1:3001"]


settings = Settings()
