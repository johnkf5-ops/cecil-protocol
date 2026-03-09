"""
Speaker Diarization Pipeline for Unfiltered Podcast Episodes 1-21.
Uses pyannote.audio to identify host vs guest, then merges speaker labels
onto existing faster-whisper transcripts.

Output: podcasts/transcripts-diarized/episode-{N}.json

Usage:
  pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
  pip install pyannote.audio
  python scripts/diarize-episodes.py

Requires:
  - NVIDIA GPU with CUDA (RTX 4090 recommended)
  - HuggingFace token with access to pyannote/speaker-diarization-3.1
  - Set HF_TOKEN env var or run huggingface-cli login
"""

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from dotenv import load_dotenv
from pyannote.audio import Pipeline

# Load .env from project root
BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

PODCAST_DIR = BASE_DIR / "podcasts"
TRANSCRIPT_DIR = PODCAST_DIR / "transcripts"
DIARIZED_DIR = PODCAST_DIR / "transcripts-diarized"

HF_TOKEN = os.environ.get("HF_TOKEN", "")
NUM_SPEAKERS = 2  # All Unfiltered episodes are 2-speaker (host + guest)


def identify_host(diarization, max_time: float = 120.0) -> str | None:
    """Identify the host by who speaks more in the first 2 minutes.
    John always opens the show with an intro."""
    speaker_time: dict[str, float] = {}

    for turn, _, speaker in diarization.itertracks(yield_label=True):
        if turn.start > max_time:
            break
        overlap_start = max(turn.start, 0)
        overlap_end = min(turn.end, max_time)
        duration = max(0, overlap_end - overlap_start)
        speaker_time[speaker] = speaker_time.get(speaker, 0) + duration

    if not speaker_time:
        return None
    return max(speaker_time, key=speaker_time.get)


def assign_speaker(
    seg_start: float,
    seg_end: float,
    diarization,
    host_speaker: str,
) -> str:
    """Assign 'host' or 'guest' to a transcript segment based on
    which pyannote speaker has the most temporal overlap."""
    speaker_overlap: dict[str, float] = {}

    for turn, _, speaker in diarization.itertracks(yield_label=True):
        # Skip turns that can't overlap this segment
        if turn.end < seg_start:
            continue
        if turn.start > seg_end:
            break

        overlap = min(turn.end, seg_end) - max(turn.start, seg_start)
        if overlap > 0:
            speaker_overlap[speaker] = speaker_overlap.get(speaker, 0) + overlap

    if not speaker_overlap:
        return "unknown"

    best_speaker = max(speaker_overlap, key=speaker_overlap.get)
    return "host" if best_speaker == host_speaker else "guest"


def find_mp3(episode_num: int) -> Path | None:
    """Find the MP3 file for a given episode number."""
    matches = list(PODCAST_DIR.glob(f"episode-{episode_num}-*.mp3"))
    return matches[0] if matches else None


def process_episode(pipeline: Pipeline, episode_num: int) -> bool:
    """Diarize a single episode and merge labels onto its transcript."""
    output_path = DIARIZED_DIR / f"episode-{episode_num}.json"
    if output_path.exists():
        print(f"  Already diarized: episode-{episode_num}")
        return True

    # Find audio
    mp3_path = find_mp3(episode_num)
    if not mp3_path:
        print(f"  ERROR: No MP3 found for episode-{episode_num}")
        return False

    # Load existing transcript
    transcript_path = TRANSCRIPT_DIR / f"episode-{episode_num}.json"
    if not transcript_path.exists():
        print(f"  ERROR: No transcript found for episode-{episode_num}")
        return False

    with open(transcript_path, "r", encoding="utf-8") as f:
        transcript = json.load(f)

    print(f"  Audio: {mp3_path.name}")
    print(f"  Segments: {len(transcript.get('segments', []))}")

    # Convert MP3 to 16kHz mono WAV via ffmpeg, then load with soundfile
    # (bypasses broken torchcodec on Windows)
    print(f"  Loading audio via ffmpeg...")
    tmp_wav = tempfile.mktemp(suffix=".wav")
    try:
        subprocess.run(
            ["ffmpeg", "-i", str(mp3_path), "-ar", "16000", "-ac", "1", "-y", tmp_wav],
            capture_output=True, check=True,
        )
        data, sample_rate = sf.read(tmp_wav, dtype="float32")
    finally:
        if os.path.exists(tmp_wav):
            os.unlink(tmp_wav)

    waveform = torch.from_numpy(data).unsqueeze(0)  # (1, samples)

    # Run diarization with waveform dict
    start = time.time()
    print(f"  Diarizing...")
    diarization = pipeline(
        {"waveform": waveform, "sample_rate": sample_rate},
        num_speakers=NUM_SPEAKERS,
    )
    diarize_time = time.time() - start
    print(f"  Diarization complete in {diarize_time:.1f}s")

    # pyannote v4 returns DiarizeOutput — extract the Annotation
    if hasattr(diarization, "speaker_diarization"):
        diarization = diarization.speaker_diarization

    # Identify host
    host_speaker = identify_host(diarization)
    if host_speaker is None:
        print(f"  WARNING: Could not identify host, defaulting to SPEAKER_00")
        host_speaker = "SPEAKER_00"

    # Count speaker segments for summary
    speaker_counts: dict[str, int] = {}
    for _, _, speaker in diarization.itertracks(yield_label=True):
        speaker_counts[speaker] = speaker_counts.get(speaker, 0) + 1
    print(f"  Speakers detected: {speaker_counts}")
    print(f"  Host identified as: {host_speaker}")

    # Merge speaker labels onto transcript segments
    segments = transcript.get("segments", [])
    host_count = 0
    guest_count = 0
    unknown_count = 0

    for seg in segments:
        label = assign_speaker(seg["start"], seg["end"], diarization, host_speaker)
        seg["speaker"] = label
        if label == "host":
            host_count += 1
        elif label == "guest":
            guest_count += 1
        else:
            unknown_count += 1

    print(f"  Labels: {host_count} host, {guest_count} guest, {unknown_count} unknown")

    # Write diarized transcript
    diarized = {
        "episodeNumber": transcript.get("episodeNumber", episode_num),
        "title": transcript.get("title", f"Episode #{episode_num}"),
        "published": transcript.get("published", ""),
        "durationMinutes": transcript.get("durationMinutes", 0),
        "diarized": True,
        "hostSpeakerId": host_speaker,
        "segmentCount": len(segments),
        "segments": segments,
    }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(diarized, f, indent=2, ensure_ascii=False)

    return True


def main():
    if not HF_TOKEN:
        print("ERROR: HF_TOKEN not set. Add it to .env or run huggingface-cli login")
        print("  1. Accept license: https://huggingface.co/pyannote/speaker-diarization-3.1")
        print("  2. Accept license: https://huggingface.co/pyannote/segmentation-3.0")
        print("  3. Create token: https://huggingface.co/settings/tokens")
        print("  4. Add HF_TOKEN=hf_xxxxx to E:\\echo_protocol\\.env")
        sys.exit(1)

    DIARIZED_DIR.mkdir(parents=True, exist_ok=True)

    # Check GPU
    if torch.cuda.is_available():
        gpu_name = torch.cuda.get_device_name(0)
        vram_gb = torch.cuda.get_device_properties(0).total_memory / (1024**3)
        print(f"GPU: {gpu_name} ({vram_gb:.1f} GB VRAM)")
    else:
        print("WARNING: No CUDA GPU detected. Diarization will be slow on CPU.")

    # Load pipeline
    print(f"\nLoading pyannote speaker-diarization-3.1...")
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        token=HF_TOKEN,
    )
    pipeline.to(torch.device("cuda" if torch.cuda.is_available() else "cpu"))
    print("Pipeline loaded.\n")

    # Process all 21 episodes
    print(f"{'=' * 60}")
    print(f"Diarizing Unfiltered Episodes 1-21")
    print(f"{'=' * 60}\n")

    total_start = time.time()
    success = 0
    failed = 0

    for ep_num in range(1, 22):
        print(f"[{ep_num}/21] Episode {ep_num}")
        if process_episode(pipeline, ep_num):
            success += 1
        else:
            failed += 1
        print()

    total_elapsed = time.time() - total_start

    # Summary
    print(f"{'=' * 60}")
    print(f"COMPLETE")
    print(f"{'=' * 60}")
    print(f"Episodes diarized: {success}")
    print(f"Failed: {failed}")
    print(f"Total time: {total_elapsed / 60:.1f} minutes")
    print(f"Output: {DIARIZED_DIR}")
    print(f"\nNext: Spot-check a few diarized transcripts, then run fact extraction")


if __name__ == "__main__":
    main()
