from typing import Literal

from pydantic import BaseModel, Field


JobPhase = Literal[
    "queued",
    "cutting",
    "transcribing",
    "refining",
    "review_cut",
    "review_cues",
    "review_text",
    "review_burn",
    "done",
    "error",
]


class DownloadLinks(BaseModel):
    video: str | None = None
    srt_es: str | None = None
    srt_en: str | None = None
    video_es: str | None = None
    video_en: str | None = None


class Span(BaseModel):
    start: float
    end: float


class CueDraft(BaseModel):
    start: float
    end: float
    text: str
    source: str = ""
    suggestion: str = ""


class VideoItem(BaseModel):
    file_id: str
    filename: str
    status: JobPhase
    detail: str = ""
    error: str | None = None
    downloads: DownloadLinks = Field(default_factory=DownloadLinks)
    keeps: list[Span] = Field(default_factory=list)
    cues: list[CueDraft] = Field(default_factory=list)
    cues_en: list[CueDraft] = Field(default_factory=list)
    review_language: Literal["", "es", "en"] = ""
    recut: bool = False
    cut_revision: int = 0


class CaptionStyle(BaseModel):
    preset: Literal["pop", "highlight", "typewriter"] = "pop"
    font: str = "Inter"
    text_color: str = "#FFFFFF"
    highlight_color: str = "#FFE14A"
    position: Literal["bottom", "center"] = "bottom"
    size: Literal["sm", "md", "lg"] = "md"
    track: Literal["es", "en", "both"] = "both"
    mode: Literal["auto", "review"] = "auto"


class BatchJob(BaseModel):
    job_id: str
    status: JobPhase
    style: CaptionStyle = Field(default_factory=CaptionStyle)
    items: list[VideoItem]
