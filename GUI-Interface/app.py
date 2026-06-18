#!/usr/bin/env python3
"""
app.py  --  Text-to-Tune web GUI (Flask), staged build:
  Compose -> (gates) Voice -> (gates) DJ
Runs INSIDE the Docker container. Open http://localhost:5000

Lives in GUI-Interface/. Imports melody_engine from src/ (project root).
"""
import os
import re
import sys
import time
import uuid
import threading
import traceback

from flask import (
    Flask, render_template, request, jsonify, send_file, session,
)

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(HERE, ".."))
for p in (PROJECT_ROOT, os.path.join(PROJECT_ROOT, "src")):
    if p not in sys.path:
        sys.path.insert(0, p)

import melody_engine as engine

app = Flask(__name__, static_folder="static", template_folder="templates")
app.secret_key = "text-to-tune-demo-key"

OUTPUTS_DIR = os.path.join(PROJECT_ROOT, "outputs")
# Look for the soundfont in a couple of sensible spots.
SOUNDFONT_CANDIDATES = [
    os.path.join(PROJECT_ROOT, "GUI-Interface", "FluidR3_GM.sf2"),
    os.path.join(PROJECT_ROOT, "GUI-Interface", "soundfont.sf2"),
    os.path.join(PROJECT_ROOT, "FluidR3_GM.sf2"),
]
def _soundfont():
    for c in SOUNDFONT_CANDIDATES:
        if os.path.exists(c):
            return c
    return None

JOBS = {}


def _session_dir(sid):
    d = os.path.join(OUTPUTS_DIR, sid)
    os.makedirs(d, exist_ok=True)
    return d


@app.route("/")
def index():
    if "sid" not in session:
        session["sid"] = uuid.uuid4().hex[:12]
    return render_template("index.html", instruments=engine.GM_INSTRUMENTS)


@app.route("/generate", methods=["POST"])
def generate():
    data = request.get_json(force=True)
    lyrics = data.get("lyrics", "")
    sid = session.get("sid") or uuid.uuid4().hex[:12]
    lines = [ln for ln in lyrics.split("\n") if ln.strip()]
    if not lines:
        return jsonify({"error": "Please enter at least one line of lyrics."}), 400
    job_id = uuid.uuid4().hex[:12]
    JOBS[job_id] = {
        "status": "running", "total": len(lines), "done": 0,
        "session_id": sid, "error": None, "result": None,
        "line_times": [],            # measured seconds per finished line
        "est_current": 6.0,          # estimate (s) for the line in progress
        "current_started": None,     # epoch when current line started
    }
    threading.Thread(target=_run_job, args=(job_id, lines, sid), daemon=True).start()
    return jsonify({"job_id": job_id, "total": len(lines)})


# fixed estimate (seconds) for line 1, before any real data exists
DEFAULT_LINE_ESTIMATE = 8.0


def _run_job(job_id, lines, sid):
    job = JOBS[job_id]
    try:
        engine.load_embedding_models()
        engine._ensure_session()
        syll_model, word_model = engine.load_embedding_models()
        results = []
        prev_seed = None
        for idx, line in enumerate(lines):
            # set the estimate for THIS line: fixed default for the first,
            # rolling average of measured times afterwards (hybrid).
            if job["line_times"]:
                job["est_current"] = sum(job["line_times"]) / len(job["line_times"])
            else:
                job["est_current"] = DEFAULT_LINE_ESTIMATE
            job["current_started"] = time.time()

            flat, used_len, oov, syl_words = engine.line_to_condition(line, syll_model, word_model)
            if flat is None:
                job["done"] = idx + 1
                continue
            sample = engine.generate_line(flat, seed=prev_seed)
            prev_seed = engine._seed_from_pitches(sample, used_len)

            elapsed = time.time() - job["current_started"]
            job["line_times"].append(elapsed)
            results.append({
                "line_index": idx, "text": line, "sample": sample,
                "used_length": used_len, "oov_flags": oov, "syllable_words": syl_words,
            })
            job["done"] = idx + 1

        sdir = _session_dir(sid)
        midi_path = os.path.join(sdir, "generated_song.mid")
        engine.save_midi(results, midi_path, program=0, tempo=120)
        xml_path = os.path.join(sdir, "generated_song.xml")
        has_xml = engine.save_musicxml(results, xml_path, tempo=120)
        # The on-screen notation is now drawn live in the browser with VexFlow
        # (from the note data below), so the LilyPond PNG is only a fallback for
        # if VexFlow can't load. Rendering it is slow, so we skip it by default;
        # set T2T_RENDER_PNG=1 to also produce the PNG fallback.
        score_png = None
        if has_xml and os.environ.get("T2T_RENDER_PNG") == "1":
            try:
                score_png = engine.render_score_png(xml_path, os.path.join(sdir, "score"))
            except Exception:
                score_png = None

        # flatten all notes into one absolute-time list for the DJ playback view
        flat_notes = []
        tempo = 120
        t = 0.0
        for r in results:
            sample = r["sample"][: r["used_length"]]
            for i in range(len(sample)):
                length = sample[i][1] * 60.0 / tempo
                gap = (sample[i+1][2] * 60.0 / tempo) if i < len(sample)-1 else 0.0
                flat_notes.append({
                    "pitch": int(sample[i][0]),
                    "start": round(t, 4),
                    "dur": round(length, 4),
                })
                t += length + gap
            t += 0.3

        job["result"] = {
            "session_id": sid,
            "num_lines": len(results),
            "has_xml": has_xml,
            "score_png": os.path.basename(score_png) if score_png else None,
            "flat_notes": flat_notes,
            "total_time": round(t, 4),
            "lines": [
                {
                    "text": r["text"],
                    "syllables": [sw[0] for sw in r["syllable_words"]],
                    "notes": [
                        {"pitch": int(s[0]), "dur": float(s[1]), "rest": float(s[2])}
                        for s in r["sample"][: r["used_length"]]
                    ],
                    "oov_flags": r["oov_flags"],
                }
                for r in results
            ],
        }
        job["status"] = "done"
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e) + "\n" + traceback.format_exc()


@app.route("/progress/<job_id>")
def progress(job_id):
    job = JOBS.get(job_id)
    if not job:
        return jsonify({"error": "unknown job"}), 404
    # report elapsed-on-current-line + the current estimate so the frontend
    # can drive an honest time-based fill rather than a canned animation.
    elapsed = None
    if job["current_started"] is not None and job["status"] == "running":
        elapsed = round(time.time() - job["current_started"], 3)
    return jsonify({
        "status": job["status"],
        "done": job["done"],
        "total": job["total"],
        "est_current": round(job.get("est_current", DEFAULT_LINE_ESTIMATE), 3),
        "elapsed_current": elapsed,
        "error": (job["error"] or "").split("\n")[0] if job["error"] else None,
        "result": job["result"] if job["status"] == "done" else None,
    })


def _rerender(sid, program, tempo, metronome=False, metro_tempo=120, metro_vol=0.6):
    """Re-write MIDI (with program+tempo, plus an optional metronome click
    track) and re-render WAV. Used on download/playback so the files always
    match the chosen instrument/tempo/metronome."""
    sdir = _session_dir(sid)
    midi_src = os.path.join(sdir, "generated_song.mid")
    if not os.path.exists(midi_src):
        return None, None, None
    import pretty_midi
    pm = pretty_midi.PrettyMIDI(midi_src)
    for inst in pm.instruments:
        inst.program = int(program)
    # tempo change: re-time by ratio relative to the 120 the notes were laid at
    ratio = 120.0 / float(tempo) if tempo else 1.0
    if abs(ratio - 1.0) > 1e-6:
        for inst in pm.instruments:
            for n in inst.notes:
                n.start *= ratio
                n.end *= ratio
    # song length (after retiming) so we know how long to run the click track
    song_end = 0.0
    for inst in pm.instruments:
        for n in inst.notes:
            song_end = max(song_end, n.end)
    if metronome and song_end > 0:
        _add_midi_metronome(pm, song_end, metro_tempo)
    out_midi = os.path.join(sdir, "render.mid")
    pm.write(out_midi)
    wav_path = os.path.join(sdir, "generated_song.wav")
    method = engine.render_wav(out_midi, wav_path, soundfont_path=_soundfont(),
                               metronome=metronome, metro_tempo=metro_tempo,
                               metro_vol=metro_vol)
    return out_midi, wav_path, method


def _add_midi_metronome(pm, song_end, metro_tempo):
    """Add a woodblock click track (its own instrument) at the metronome tempo."""
    import pretty_midi
    click = pretty_midi.Instrument(program=115, is_drum=False, name="Metronome")
    beat = 60.0 / float(metro_tempo if metro_tempo else 120)
    t, i = 0.0, 0
    while t < song_end:
        accent = (i % 4 == 0)
        click.notes.append(pretty_midi.Note(
            velocity=110 if accent else 80,
            pitch=76 if accent else 77,   # high/low woodblock-ish
            start=t, end=t + 0.05))
        t += beat
        i += 1
    pm.instruments.append(click)


def _metro_args():
    """Parse metronome query params shared by download + render endpoints."""
    on = request.args.get("metro", default="0") in ("1", "true", "True")
    mt = request.args.get("metro_tempo", default=120, type=int)
    mv = request.args.get("metro_vol", default=60, type=int) / 100.0
    return on, mt, mv


@app.route("/download/<kind>")
def download(kind):
    sid = session.get("sid")
    if not sid:
        return "No session", 400
    program = request.args.get("program", default=0, type=int)
    tempo = request.args.get("tempo", default=120, type=int)
    metro_on, metro_tempo, metro_vol = _metro_args()
    sdir = _session_dir(sid)

    if kind == "midi":
        out_midi, _, _ = _rerender(sid, program, tempo, metro_on, metro_tempo, metro_vol)
        path = out_midi or os.path.join(sdir, "generated_song.mid")
        if not os.path.exists(path):
            return "Generate a melody first.", 404
        return send_file(path, as_attachment=True,
                         download_name="text_to_tune.mid", mimetype="audio/midi")

    if kind == "wav":
        _, wav_path, _ = _rerender(sid, program, tempo, metro_on, metro_tempo, metro_vol)
        if not wav_path or not os.path.exists(wav_path):
            return "Generate a melody first.", 404
        return send_file(wav_path, as_attachment=True,
                         download_name="text_to_tune.wav", mimetype="audio/wav")

    if kind == "xml":
        path = os.path.join(sdir, "generated_song.xml")
        if not os.path.exists(path):
            return "MusicXML not available.", 404
        return send_file(path, as_attachment=True,
                         download_name="text_to_tune.musicxml",
                         mimetype="application/vnd.recordare.musicxml+xml")

    return "Unknown file", 404


@app.route("/musicxml_raw")
def musicxml_raw():
    """Serve the raw MusicXML (not as attachment) for OSMD to render in-browser."""
    sid = session.get("sid")
    if not sid:
        return "No session", 400
    path = os.path.join(OUTPUTS_DIR, sid, "generated_song.xml")
    if not os.path.exists(path):
        return "Not available", 404
    return send_file(path, mimetype="application/xml")


# ---- server-side playback (no CDN): render the melody to WAV with the real
# FluidR3_GM.sf2 so the DJ deck can play it through an <audio> element. ----
@app.route("/render_wav", methods=["POST"])
def render_wav_route():
    sid = session.get("sid")
    if not sid:
        return jsonify({"error": "no session"}), 400
    data = request.get_json(force=True) if request.data else {}
    program = int(data.get("program", 0))
    tempo = int(data.get("tempo", 120))
    out_midi, wav_path, method = _rerender(sid, program, tempo)
    if not wav_path or not os.path.exists(wav_path):
        return jsonify({"error": "Generate a melody first."}), 404
    # cache-busting token so the browser reloads the new render
    return jsonify({
        "ok": True,
        "method": method,                      # "fluidsynth" or "sine"
        "url": "/audio/wav?sid=%s&t=%d" % (sid, int(time.time() * 1000)),
    })


@app.route("/audio/wav")
def audio_wav():
    sid = request.args.get("sid") or session.get("sid")
    if not sid:
        return "No session", 400
    wav_path = os.path.join(OUTPUTS_DIR, sid, "generated_song.wav")
    if not os.path.exists(wav_path):
        return "Not rendered yet", 404
    # not as_attachment: this is for the <audio> element to stream/play
    return send_file(wav_path, mimetype="audio/wav", conditional=True)


@app.route("/score/<session_id>/<filename>")
def score_image(session_id, filename):
    fpath = os.path.join(OUTPUTS_DIR, session_id, filename)
    if not os.path.exists(fpath):
        return "Not found", 404
    return send_file(fpath, mimetype="image/png")


@app.route("/upload_vocals", methods=["POST"])
def upload_vocals():
    sid = session.get("sid")
    if not sid:
        return jsonify({"error": "no session"}), 400
    if "file" not in request.files:
        return jsonify({"error": "no file"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "empty filename"}), 400
    sdir = _session_dir(sid)
    voc_dir = os.path.join(sdir, "vocals")
    os.makedirs(voc_dir, exist_ok=True)
    safe = re.sub(r"[^\w.\-]+", "_", f.filename)
    f.save(os.path.join(voc_dir, safe))
    existing = sorted(os.listdir(voc_dir))
    return jsonify({"ok": True, "filename": safe, "all": existing})


if __name__ == "__main__":
    os.makedirs(OUTPUTS_DIR, exist_ok=True)
    sf = _soundfont()
    print("Soundfont:", sf if sf else "NONE FOUND (WAV will use sine fallback)")
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
