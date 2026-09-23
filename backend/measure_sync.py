import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.services.ffmpeg_silence import (
    detect_silences,
    extract_whisper_wav,
    probe_durations,
    render_without_silence,
)

root = Path(__file__).resolve().parent / "data" / "sync-measure"
root.mkdir(parents=True, exist_ok=True)
source = root / "source.mp4"
audio_filter = (
    "sine=frequency=440:sample_rate=48000:duration=12,"
    "volume=0:enable='between(t,3,5)+between(t,8,9.5)'"
)
cmd = [
    "ffmpeg",
    "-y",
    "-hide_banner",
    "-f",
    "lavfi",
    "-i",
    audio_filter,
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=640x360:r=30:d=12",
    "-shortest",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    str(source),
]
subprocess.run(cmd, check=True, capture_output=True)
dest = root / "cut-nvenc.mp4"
measured = render_without_silence(source, dest, root / "work-nvenc")
wav = extract_whisper_wav(dest, root / "work" / "speech.wav")
leftover = detect_silences(dest)
video = measured.get("video")
audio = measured.get("audio")
wav_duration = wav.get("audio", wav.get("format"))
print(
    {
        "video": video,
        "audio": audio,
        "wav": wav_duration,
        "av_delta_ms": round((video - audio) * 1000, 3),
        "wav_delta_ms": round((wav_duration - audio) * 1000, 3),
        "leftover_silences": leftover,
    }
)
