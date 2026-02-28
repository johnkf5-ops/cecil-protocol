"""
Transcribe interview podcast files (local MP3/M4A) for Cecil Protocol.
Uses faster-whisper with CUDA on RTX 4090.

Usage:
  python scripts/transcribe-interviews.py
"""

import json
import time
from pathlib import Path

from faster_whisper import WhisperModel

BASE_DIR = Path(__file__).resolve().parent.parent
INTERVIEW_DIR = BASE_DIR / "podcasts" / "interviews"
TRANSCRIPT_DIR = INTERVIEW_DIR / "transcripts"

WHISPER_MODEL = "base.en"
DEVICE = "cuda"
COMPUTE_TYPE = "float16"


def transcribe_file(model: WhisperModel, audio_path: Path) -> dict:
    """Transcribe a single audio file. Returns transcript dict."""
    transcript_filename = audio_path.stem + ".json"
    transcript_path = TRANSCRIPT_DIR / transcript_filename

    if transcript_path.exists():
        print(f"  Already transcribed: {transcript_filename}")
        with open(transcript_path, "r", encoding="utf-8") as f:
            return json.load(f)

    print(f"  Transcribing: {audio_path.name}...")
    start = time.time()

    segments, info = model.transcribe(
        str(audio_path),
        beam_size=5,
        language="en",
        vad_filter=True,
    )

    transcript_segments = []
    for seg in segments:
        transcript_segments.append({
            "start": round(seg.start, 2),
            "end": round(seg.end, 2),
            "text": seg.text.strip(),
        })

    elapsed = time.time() - start
    duration_min = info.duration / 60 if info.duration else 0

    transcript = {
        "sourceFile": audio_path.name,
        "title": audio_path.stem,
        "durationMinutes": round(duration_min, 1),
        "transcriptionTimeSeconds": round(elapsed, 1),
        "segmentCount": len(transcript_segments),
        "segments": transcript_segments,
    }

    with open(transcript_path, "w", encoding="utf-8") as f:
        json.dump(transcript, f, indent=2, ensure_ascii=False)

    print(f"  Done: {len(transcript_segments)} segments in {elapsed:.1f}s (audio was {duration_min:.0f} min)")
    return transcript


def main():
    TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)

    audio_files = sorted(
        [f for f in INTERVIEW_DIR.iterdir() if f.suffix.lower() in (".mp3", ".m4a", ".wav", ".ogg")]
    )

    if not audio_files:
        print(f"No audio files found in {INTERVIEW_DIR}")
        return

    print(f"Found {len(audio_files)} audio files to transcribe")
    print(f"Output: {TRANSCRIPT_DIR}\n")

    print(f"Loading faster-whisper model: {WHISPER_MODEL} ({DEVICE})")
    model = WhisperModel(WHISPER_MODEL, device=DEVICE, compute_type=COMPUTE_TYPE)
    print()

    total_start = time.time()
    for audio_path in audio_files:
        transcribe_file(model, audio_path)
        print()

    total_elapsed = time.time() - total_start

    print(f"{'='*60}")
    print(f"COMPLETE")
    print(f"{'='*60}")
    print(f"Files transcribed: {len(audio_files)}")
    print(f"Total time: {total_elapsed / 60:.1f} minutes")
    print(f"Transcripts saved to: {TRANSCRIPT_DIR}")


if __name__ == "__main__":
    main()
