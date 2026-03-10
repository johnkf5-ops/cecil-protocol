"""
Podcast Transcription Pipeline for Cecil Protocol
Downloads episodes from RSS feed, transcribes with faster-whisper (CUDA).
Output: JSON transcripts with timestamps per segment.

Usage:
  pip install faster-whisper requests feedparser
  python scripts/transcribe-podcasts.py

Requires: NVIDIA GPU with CUDA
Estimated time: ~1 minute per episode
"""

import json
import os
import re
import sys
import time
from pathlib import Path

import feedparser
import requests
from faster_whisper import WhisperModel

RSS_URL = "YOUR_RSS_FEED_URL"  # Replace with your podcast RSS feed URL
BASE_DIR = Path(__file__).resolve().parent.parent
PODCAST_DIR = BASE_DIR / "podcasts"
TRANSCRIPT_DIR = PODCAST_DIR / "transcripts"

# faster-whisper config
WHISPER_MODEL = "base.en"  # Upgrade to "turbo" if quality needs improvement
DEVICE = "cuda"
COMPUTE_TYPE = "float16"


def parse_rss(url: str) -> list[dict]:
    """Parse RSS feed and return episode list sorted by episode number."""
    print(f"Fetching RSS feed: {url}")
    feed = feedparser.parse(url)

    episodes = []
    for i, entry in enumerate(reversed(feed.entries)):  # oldest first
        # Find the MP3 enclosure
        mp3_url = None
        for link in entry.get("links", []):
            if link.get("type", "").startswith("audio/"):
                mp3_url = link["href"]
                break
        if not mp3_url:
            for enc in entry.get("enclosures", []):
                if enc.get("type", "").startswith("audio/"):
                    mp3_url = enc["href"]
                    break

        if not mp3_url:
            print(f"  Skipping '{entry.title}' — no audio URL found")
            continue

        episode_num = i + 1
        episodes.append({
            "episodeNumber": episode_num,
            "title": entry.title.strip(),
            "url": mp3_url,
            "published": entry.get("published", ""),
        })

    print(f"Found {len(episodes)} episodes")
    return episodes


def slugify(text: str) -> str:
    """Convert title to filesystem-safe slug."""
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    text = re.sub(r"-+", "-", text)
    return text[:80].strip("-")


def download_episode(episode: dict, dest_dir: Path) -> Path:
    """Download an MP3 episode. Skips if already downloaded."""
    slug = slugify(episode["title"])
    filename = f"episode-{episode['episodeNumber']}-{slug}.mp3"
    filepath = dest_dir / filename

    if filepath.exists():
        size_mb = filepath.stat().st_size / (1024 * 1024)
        print(f"  Already downloaded: {filename} ({size_mb:.1f} MB)")
        return filepath

    print(f"  Downloading: {episode['title']}...")
    response = requests.get(episode["url"], stream=True, timeout=120)
    response.raise_for_status()

    total = int(response.headers.get("content-length", 0))
    downloaded = 0

    with open(filepath, "wb") as f:
        for chunk in response.iter_content(chunk_size=8192):
            f.write(chunk)
            downloaded += len(chunk)
            if total > 0:
                pct = downloaded / total * 100
                print(f"\r  [{pct:5.1f}%] {downloaded // (1024*1024)} MB / {total // (1024*1024)} MB", end="", flush=True)

    print(f"\r  Downloaded: {filename} ({downloaded // (1024*1024)} MB)          ")
    return filepath


def transcribe_episode(model: WhisperModel, mp3_path: Path, episode: dict) -> dict:
    """Transcribe a single episode. Returns transcript dict."""
    transcript_filename = f"episode-{episode['episodeNumber']}.json"
    transcript_path = TRANSCRIPT_DIR / transcript_filename

    if transcript_path.exists():
        print(f"  Already transcribed: {transcript_filename}")
        with open(transcript_path, "r", encoding="utf-8") as f:
            return json.load(f)

    print(f"  Transcribing: {episode['title']}...")
    start = time.time()

    segments, info = model.transcribe(
        str(mp3_path),
        beam_size=5,
        language="en",
        vad_filter=True,  # Skip silence for speed
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
        "episodeNumber": episode["episodeNumber"],
        "title": episode["title"],
        "published": episode["published"],
        "durationMinutes": round(duration_min, 1),
        "transcriptionTimeSeconds": round(elapsed, 1),
        "segmentCount": len(transcript_segments),
        "segments": transcript_segments,
    }

    with open(transcript_path, "w", encoding="utf-8") as f:
        json.dump(transcript, f, indent=2, ensure_ascii=False)

    print(f"  Done: {len(transcript_segments)} segments in {elapsed:.1f}s (episode was {duration_min:.0f} min)")
    return transcript


def main():
    # Create directories
    PODCAST_DIR.mkdir(parents=True, exist_ok=True)
    TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)

    # Parse RSS
    episodes = parse_rss(RSS_URL)
    if not episodes:
        print("No episodes found in RSS feed.")
        sys.exit(1)

    # Download all episodes
    print(f"\n{'='*60}")
    print(f"Downloading {len(episodes)} episodes...")
    print(f"{'='*60}\n")

    mp3_paths = {}
    for ep in episodes:
        mp3_paths[ep["episodeNumber"]] = download_episode(ep, PODCAST_DIR)

    # Load whisper model
    print(f"\n{'='*60}")
    print(f"Loading faster-whisper model: {WHISPER_MODEL} ({DEVICE})")
    print(f"{'='*60}\n")

    model = WhisperModel(WHISPER_MODEL, device=DEVICE, compute_type=COMPUTE_TYPE)

    # Transcribe all episodes
    print(f"\n{'='*60}")
    print(f"Transcribing {len(episodes)} episodes...")
    print(f"{'='*60}\n")

    total_start = time.time()
    for ep in episodes:
        mp3_path = mp3_paths[ep["episodeNumber"]]
        transcribe_episode(model, mp3_path, ep)
        print()

    total_elapsed = time.time() - total_start

    # Summary
    print(f"\n{'='*60}")
    print(f"COMPLETE")
    print(f"{'='*60}")
    print(f"Episodes transcribed: {len(episodes)}")
    print(f"Total time: {total_elapsed / 60:.1f} minutes")
    print(f"Transcripts saved to: {TRANSCRIPT_DIR}")
    print(f"\nNext step: Run the ingest API to embed transcripts into Cecil memory")
    print(f"  curl -X POST http://localhost:3000/api/ingest-podcasts")


if __name__ == "__main__":
    main()
