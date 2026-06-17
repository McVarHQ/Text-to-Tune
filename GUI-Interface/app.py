#!/usr/bin/env python3
"""
app.py  --  Text-to-Tune web GUI (Flask)
=========================================

Runs INSIDE the Docker container (where TensorFlow 1.14 + the trained model
work). Serves a single-page UI and exposes a few JSON endpoints the page calls.

Run it (from the project root, the folder that has melody_engine.py / utils.py):
    python GUI-Interface/app.py
then open  http://localhost:5000  in your browser.

Directory contract:
    outputs/<session_id>/...       <- only MIDI is persisted here (per spec)
    (WAV + MusicXML are generated on demand and streamed as downloads;
     they are written to the session dir transiently so they can be served,
     but MIDI is the canonical stored artifact.)

This file lives in GUI-Interface/. It adds the project root to sys.path so it
can import melody_engine (which lives in src/, copied next to utils.py).
"""

import os
import sys
import uuid
import json
import threading
import traceback

from flask import (
    Flask, render_template, request, jsonify, send_file, session, Response,
)

# --- make project-root modules importable (melody_engine, utils, etc.) ---
HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(HERE, ".."))
for p in (PROJECT_ROOT, os.path.join(PROJECT_ROOT, "src")):
    if p not in sys.path:
        sys.path.insert(0, p)

import melody_engine as engine

app = Flask(__name__, static_folder="static", template_folder="templates")
app.secret_key = "text-to-tune-demo-key"  # only for session cookies in a demo

OUTPUTS_DIR = os.path.join(PROJECT_ROOT, "outputs")
SOUNDFONT_PATH = os.path.join(PROJECT_ROOT, "GUI-Interface", "soundfont.sf2")

# In-memory job store: job_id -> progress/result dict. Fine for a single-user
# demo; not for production multi-worker use.
JOBS = {}


def _session_dir(session_id):
    d = os.path.join(OUTPUTS_DIR, session_id)
    os.makedirs(d, exist_ok=True)
    return d


@app.route("/")
def index():
    if "sid" not in session:
        session["sid"] = uuid.uuid4().hex[:12]
    return render_template("index.html", instruments=list(engine.INSTRUMENTS.keys()))


@app.route("/generate", methods=["POST"])
def generate():
    """Kick off generation in a background thread; return a job_id immediately
    so the UI can poll /progress and animate the staff loading bar."""
    data = request.get_json(force=True)
    lyrics = data.get("lyrics", "")
    instrument = data.get("instrument", "piano")
    sid = session.get("sid") or uuid.uuid4().hex[:12]

    lines = [ln for ln in lyrics.split("\n") if ln.strip()]
    if not lines:
        return jsonify({"error": "Please enter at least one line of lyrics."}), 400

    job_id = uuid.uuid4().hex[:12]
    JOBS[job_id] = {
        "status": "running",
        "total": len(lines),
        "done": 0,
        "session_id": sid,
        "error": None,
        "result": None,
    }

    t = threading.Thread(
        target=_run_job, args=(job_id, lines, instrument, sid), daemon=True
    )
    t.start()
    return jsonify({"job_id": job_id, "total": len(lines)})


def _run_job(job_id, lines, instrument, sid):
    try:
        engine.load_embedding_models()
        engine._ensure_session()

        results = []
        prev_seed = None
        syll_model, word_model = engine.load_embedding_models()
        for idx, line in enumerate(lines):
            flat, used_len, oov, syl_words = engine.line_to_condition(
                line, syll_model, word_model
            )
            if flat is None:
                JOBS[job_id]["done"] = idx + 1
                continue
            sample = engine.generate_line(flat, seed=prev_seed)
            prev_seed = engine._seed_from_pitches(sample, used_len)
            results.append({
                "line_index": idx,
                "text": line,
                "sample": sample,
                "used_length": used_len,
                "oov_flags": oov,
                "syllable_words": syl_words,
            })
            JOBS[job_id]["done"] = idx + 1

        # Write outputs
        sdir = _session_dir(sid)
        midi_path = os.path.join(sdir, "generated_song.mid")
        engine.save_midi(results, midi_path, instrument=instrument)

        xml_path = os.path.join(sdir, "generated_song.xml")
        has_xml = engine.save_musicxml(results, xml_path)

        score_png = None
        if has_xml:
            score_png = engine.render_score_png(
                xml_path, os.path.join(sdir, "score")
            )

        JOBS[job_id]["result"] = {
            "session_id": sid,
            "num_lines": len(results),
            "has_xml": has_xml,
            "score_png": os.path.basename(score_png) if score_png else None,
            "lines": [
                {
                    "text": r["text"],
                    "notes": [
                        {"pitch": int(s[0]), "dur": float(s[1]), "rest": float(s[2])}
                        for s in r["sample"][: r["used_length"]]
                    ],
                    "syllables": [sw[0] for sw in r["syllable_words"]],
                    "oov_flags": r["oov_flags"],
                }
                for r in results
            ],
        }
        JOBS[job_id]["status"] = "done"
    except Exception as e:
        JOBS[job_id]["status"] = "error"
        JOBS[job_id]["error"] = str(e) + "\n" + traceback.format_exc()


@app.route("/progress/<job_id>")
def progress(job_id):
    job = JOBS.get(job_id)
    if not job:
        return jsonify({"error": "unknown job"}), 404
    return jsonify({
        "status": job["status"],
        "done": job["done"],
        "total": job["total"],
        "error": job["error"],
        "result": job["result"] if job["status"] == "done" else None,
    })


@app.route("/render_wav", methods=["POST"])
def render_wav_endpoint():
    """Render the session's MIDI to WAV with the chosen instrument, on demand."""
    data = request.get_json(force=True)
    sid = session.get("sid")
    instrument = data.get("instrument", "piano")
    if not sid:
        return jsonify({"error": "no session"}), 400
    sdir = _session_dir(sid)
    midi_path = os.path.join(sdir, "generated_song.mid")
    if not os.path.exists(midi_path):
        return jsonify({"error": "Generate a melody first."}), 400

    # Re-render MIDI with the chosen instrument program so the WAV matches the
    # DJ-tab instrument selection.
    import pretty_midi
    pm = pretty_midi.PrettyMIDI(midi_path)
    program = engine.INSTRUMENTS.get(instrument, 0)
    for inst in pm.instruments:
        inst.program = program
    tmp_midi = os.path.join(sdir, "_render.mid")
    pm.write(tmp_midi)

    wav_path = os.path.join(sdir, "generated_song.wav")
    method = engine.render_wav(tmp_midi, wav_path, soundfont_path=SOUNDFONT_PATH)
    return jsonify({"ok": True, "method": method})


@app.route("/download/<kind>")
def download(kind):
    sid = session.get("sid")
    if not sid:
        return "No session", 400
    sdir = _session_dir(sid)
    files = {
        "midi": ("generated_song.mid", "audio/midi"),
        "wav": ("generated_song.wav", "audio/wav"),
        "xml": ("generated_song.xml", "application/xml"),
    }
    if kind not in files:
        return "Unknown file", 404
    fname, mime = files[kind]
    fpath = os.path.join(sdir, fname)
    if not os.path.exists(fpath):
        return "File not generated yet", 404
    return send_file(fpath, as_attachment=True, download_name=fname, mimetype=mime)


@app.route("/audio/wav")
def audio_wav():
    """Serve the WAV inline (not as a download) for the in-page audio player."""
    sid = session.get("sid")
    if not sid:
        return "No session", 400
    fpath = os.path.join(_session_dir(sid), "generated_song.wav")
    if not os.path.exists(fpath):
        return "Not generated", 404
    return send_file(fpath, mimetype="audio/wav")


@app.route("/score/<session_id>/<filename>")
def score_image(session_id, filename):
    """Serve a generated notation PNG."""
    fpath = os.path.join(OUTPUTS_DIR, session_id, filename)
    if not os.path.exists(fpath):
        return "Not found", 404
    return send_file(fpath, mimetype="image/png")


@app.route("/upload_vocals", methods=["POST"])
def upload_vocals():
    """Accept an optional vocal file upload; store it in the session dir."""
    sid = session.get("sid")
    if not sid:
        return jsonify({"error": "no session"}), 400
    if "file" not in request.files:
        return jsonify({"error": "no file"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "empty filename"}), 400
    sdir = _session_dir(sid)
    ext = os.path.splitext(f.filename)[1].lower()
    save_path = os.path.join(sdir, "vocals" + ext)
    f.save(save_path)
    return jsonify({"ok": True, "filename": "vocals" + ext})


if __name__ == "__main__":
    os.makedirs(OUTPUTS_DIR, exist_ok=True)
    # threaded=True so the background job thread + polling requests coexist.
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
