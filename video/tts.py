"""Generate one voiceover clip per scene from VIDEO_SCRIPT.md (the script stays the single source of truth).

Usage: python tts.py [voice]   e.g. python tts.py en-US-AndrewNeural
Writes audio/<SCENE_ID>.mp3 and audio/durations.json.
"""
import asyncio, json, re, subprocess, sys
from pathlib import Path

import edge_tts

HERE = Path(__file__).parent
VOICE = sys.argv[1] if len(sys.argv) > 1 else "en-US-AndrewNeural"
OUT = HERE / "audio"


def scenes():
    rows = [l for l in (HERE / "VIDEO_SCRIPT.md").read_text(encoding="utf-8").splitlines() if l.startswith("| **")]
    out = []
    for r in rows:
        cells = [c.strip() for c in r.split("|")]
        scene_id = re.match(r"\*\*(\w+)", cells[1]).group(1)  # "**D2 Chatbot**" -> "D2"
        out.append((scene_id, cells[4]))
    assert out, "no scene rows found in VIDEO_SCRIPT.md"
    return out


def duration(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True)
    return float(r.stdout.strip())


async def main():
    OUT.mkdir(exist_ok=True)
    durations = {}
    for scene_id, text in scenes():
        path = OUT / f"{scene_id}.mp3"
        await edge_tts.Communicate(text, VOICE, rate="-4%").save(str(path))
        durations[scene_id] = round(duration(path), 2)
        print(f"{scene_id:4} {durations[scene_id]:6.2f}s")
    (OUT / "durations.json").write_text(json.dumps(durations, indent=2))
    print(f"total speech {sum(durations.values()):.1f}s with {VOICE}")


asyncio.run(main())
