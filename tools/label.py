"""给切片打标，生成 GPT-SoVITS 训练用 list.txt（path|speaker|lang|text）。"""
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel

FFMPEG = r"D:\anaconda3\Library\bin\ffmpeg.exe"
sliced_dir = Path(sys.argv[1])
list_path = Path(sys.argv[2])
model_path = sys.argv[3]
speaker = sys.argv[4] if len(sys.argv) > 4 else "yinlang"

model = WhisperModel(model_path, device="cpu", compute_type="int8")


def load_pcm16k(path: Path):
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name
    subprocess.run(
        [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(path),
         "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", tmp_path],
        check=True,
    )
    with wave.open(tmp_path, "rb") as w:
        frames = w.readframes(w.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


lines = []
for wav in sorted(sliced_dir.glob("*.wav")):
    audio = load_pcm16k(wav)
    segments, _ = model.transcribe(audio, language="zh", beam_size=5, vad_filter=True)
    text = "".join(s.text for s in segments).strip().replace("|", "")
    if len(text) < 2:
        print(f"skip(empty): {wav.name}")
        continue
    lines.append(f"{wav.resolve()}|{speaker}|zh|{text}")
    print(f"{wav.name}\t{text}")

list_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"wrote {len(lines)} lines -> {list_path}")
