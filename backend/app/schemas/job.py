from typing import Literal

from pydantic import BaseModel, Field


JobPhase = Literal[
    "queued",
    "cutting",
    "transcribing",
    "refining",
    "done",
    "error",
]


class DownloadLinks(BaseModel):
    video: str | None = None
    srt_es: str | None = None
    srt_en: str | None = None
    video_es: str | None = None
    video_en: str | None = None


class VideoItem(BaseModel):
    file_id: str
    filename: str
    status: JobPhase
    detail: str = ""
    error: str | None = None
    downloads: DownloadLinks = Field(default_factory=DownloadLinks)


class CaptionStyle(BaseModel):
    preset: Literal["pop", "highlight", "typewriter"] = "pop"
    font: str = "Inter"
    text_color: str = "#FFFFFF"
    highlight_color: str = "#FFE14A"
    position: Literal["bottom", "center"] = "bottom"
    size: Literal["sm", "md", "lg"] = "md"


class BatchJob(BaseModel):
    job_id: str
    status: JobPhase
    style: CaptionStyle = Field(default_factory=CaptionStyle)
    items: list[VideoItem]
