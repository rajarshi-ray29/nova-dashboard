#!/usr/bin/env python3
"""Replay a raw microphone capture through the bridge's MusicSense, offline, and print what the beat
tracker would have done -- the way to tune the vibe without standing next to the robot.

    # record ~50 s on the Pi while music plays (pw-record FILE does NOT write a file; redirect stdout)
    ssh rajarshi@raspberrypi.local 'timeout 50 pw-record --rate 16000 --channels 1 --format s16 --latency 30ms --raw - > /tmp/mic.raw'
    scp rajarshi@raspberrypi.local:/tmp/mic.raw .
    python3 pi/tools/vibe_replay.py mic.raw            # runs on the Mac (numpy only) or on the Pi

Prints one line per second (level, score, lock, BPM, phase coherence) and the ON/OFF events, then a
summary: when it switched on, the tempo it settled on, how many parity flips / relocks. Env knobs
(NOVA_VIBE_SCORE_ON, ...) are honoured, so thresholds can be tried against a recording first."""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("NOVA_HEAD_LIMITS", "/nonexistent")     # do not touch a real head_limits.json
os.environ.setdefault("NOVA_HEAD_STATE", "/nonexistent")
spec = importlib.util.spec_from_file_location("nova_bridge", os.path.join(HERE, "..", "nova_bridge.py"))
nb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nb)
np = nb.np


def main(path: str) -> int:
    if np is None:
        print("numpy is required")
        return 1
    x = np.fromfile(path, dtype=np.int16).astype(np.float32) / 32768.0
    sr, hop = nb.MIC_SR, nb.MIC_HOP
    print(f"{path}: {len(x) / sr:.1f} s, {20 * np.log10(np.sqrt(np.mean(x * x)) + 1e-9):.1f} dBFS RMS")
    ms = nb.MusicSense(nb.BeatClock())
    t0 = 1000.0
    on_at = None
    last_print = 0
    for i in range(len(x) // hop):
        t_end = t0 + (i + 1) * hop / sr
        ms.process(x[i * hop:(i + 1) * hop], t_end)
        t = t_end - t0
        if ms.active and on_at is None:
            on_at = t
        if int(t) > last_print:
            last_print = int(t)
            bpm = f"{ms.bpm:6.1f}" if ms.locked else "   -- "
            print(f"t={t:5.1f}s level {ms.level_db:6.1f} dBFS  score {ms.score:.3f} (now {ms.score_now:.3f})  "
                  f"cand {ms.cand_bpm:6.1f}  lock {bpm}  coh {ms.coherence:.2f}  err {ms.phase_err * ms.period * 1000:+5.0f} ms  "
                  f"{'VIBING' if ms.active else ''}")
    print(f"\nfirst ON: {on_at if on_at is not None else 'never'}; final: active={ms.active} locked={ms.locked} "
          f"bpm={ms.bpm:.1f} score={ms.score:.3f} parity_flips={ms.parity_flips} relocks={ms.relocks}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
