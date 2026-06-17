#!/usr/bin/env python3
"""
melody_engine.py  --  Core Lyrics2Melody logic (the ONE file that lives in src/)
================================================================================

This module is the reusable engine behind the Text-to-Tune GUI. It contains
no Flask / web code on purpose: it's pure functions the web layer calls, so it
can also be used from a notebook or the command line.

It must live alongside the original project's `utils.py` and
`midi_statistics.py`, and have access to:
    ./enc_models/syllEncoding_20190419.bin
    ./enc_models/wordLevelEncoder_20190419.bin
    ./saved_gan_models/saved_model_best_overall_mmd/

What it does, end to end:
    typed line of lyrics
      -> syllable split (pyphen)
      -> per-syllable (syllable-embedding + word-embedding) conditioning vector
      -> trained GAN generates [pitch, duration, rest] triplets
      -> tuned to a musical scale + discretized
      -> MIDI (via pretty_midi)  +  optional WAV (via fluidsynth soundfont)
                                 +  optional MusicXML / LilyPond notation

Multi-line:
    Each line is generated independently BUT the random seed for line N is
    derived from line N-1's generated pitches, so consecutive lines vary in a
    related way rather than being fully independent draws. This is a light
    "continuity" touch, not a re-architecture of the model.
"""

import hashlib
import os
import sys

import numpy as np

# --- Optional deps: import lazily / defensively so a missing one gives a
#     clear message rather than an import-time crash of the whole app. ---
try:
    import pyphen
except ImportError:
    pyphen = None

try:
    from gensim.models import Word2Vec
except ImportError:
    Word2Vec = None

import tensorflow as tf
tfc = tf.compat.v1
if tf.__version__.startswith("2"):
    tfc.disable_v2_behavior()

import utils
import midi_statistics


# ---------------------------------------------------------------------------
# Config -- matches the values the GAN was trained with (from "4. Create song")
# ---------------------------------------------------------------------------
SONG_LENGTH = 20
NUM_MIDI_FEATURES = 3

DEFAULT_SYLL_MODEL = "./enc_models/syllEncoding_20190419.bin"
DEFAULT_WORD_MODEL = "./enc_models/wordLevelEncoder_20190419.bin"
DEFAULT_GAN_MODEL = "./saved_gan_models/saved_model_best_overall_mmd"

# General MIDI program numbers for the instruments we expose in the DJ tab.
# (These are the standard GM patch numbers; fluidsynth maps them to the
# matching instrument in any General-MIDI soundfont.)
INSTRUMENTS = {
    "piano": 0,        # Acoustic Grand Piano
    "guitar": 24,      # Nylon Acoustic Guitar
    "bass": 33,        # Electric Bass (finger)
    "strings": 48,     # String Ensemble
    "epiano": 4,       # Electric Piano
    "music_box": 10,   # Music Box
    "flute": 73,       # Flute
    "synth": 80,       # Synth Lead (square)
}


# ---------------------------------------------------------------------------
# Model loading -- cache loaded models at module level so the web app loads
# them once on first use, not on every request.
# ---------------------------------------------------------------------------
_syll_model = None
_word_model = None


def load_embedding_models(syll_path=DEFAULT_SYLL_MODEL, word_path=DEFAULT_WORD_MODEL):
    """Load (and cache) the syllable + word Word2Vec models."""
    global _syll_model, _word_model
    if Word2Vec is None:
        raise RuntimeError("gensim is not installed. `pip install gensim`.")
    if _syll_model is None:
        _syll_model = Word2Vec.load(syll_path)
    if _word_model is None:
        _word_model = Word2Vec.load(word_path)
    return _syll_model, _word_model


# ---------------------------------------------------------------------------
# Vocabulary helpers (tolerant of gensim 3.x vs 4.x API differences)
# ---------------------------------------------------------------------------
def _in_vocab(model_wv, key):
    try:
        return key in model_wv
    except Exception:
        try:
            return key in model_wv.vocab
        except Exception:
            return False


def _get_embedding(model_wv, key, default_vec):
    """Look up an embedding, trying case variants; fall back to default_vec.
    Returns (vector, matched_key_or_None)."""
    for candidate in (key, key.lower(), key.capitalize(), key.upper()):
        if _in_vocab(model_wv, candidate):
            return model_wv[candidate], candidate
    return default_vec, None


def _centroid(model_wv):
    """Mean of all vectors -- a 'neutral' fallback for unknown tokens."""
    if hasattr(model_wv, "vectors"):
        return model_wv.vectors.mean(axis=0)
    return np.array([model_wv[k] for k in model_wv.index_to_key]).mean(axis=0)


# ---------------------------------------------------------------------------
# Lyrics -> syllables -> conditioning vector
# ---------------------------------------------------------------------------
import re

_dic = None


def _syllabify(word):
    global _dic
    if pyphen is None:
        return [word]
    if _dic is None:
        _dic = pyphen.Pyphen(lang="en_US")
    try:
        parts = _dic.inserted(word, hyphen="-").split("-")
        return [p for p in parts if p] or [word]
    except Exception:
        return [word]


def _clean(word):
    return re.sub(r"^[^\w']+|[^\w']+$", "", word)


def line_to_condition(line_text, syll_model, word_model):
    """Turn one line of lyrics into (flattened_cond, used_length, oov_report,
    syllable_words). Unknown tokens use a neutral centroid embedding so the
    line keeps its structure instead of crashing."""
    syll_default = _centroid(syll_model.wv)
    word_default = _centroid(word_model.wv)

    words = [w for w in (_clean(w) for w in line_text.split()) if w]
    pairs = []
    for word in words:
        for syll in _syllabify(word):
            pairs.append((syll, word))

    conditions, oov_report, syl_words = [], [], []
    for syll, word in pairs:
        svec, sused = _get_embedding(syll_model.wv, syll, syll_default)
        wvec, wused = _get_embedding(word_model.wv, word, word_default)
        conditions.append(np.concatenate((svec, wvec)))
        oov_report.append(sused is None or wused is None)
        syl_words.append((syll, word))

    if not conditions:
        return None, 0, [], []

    used_length = min(len(conditions), SONG_LENGTH)

    # pad / truncate to SONG_LENGTH
    if len(conditions) > SONG_LENGTH:
        conditions = conditions[:SONG_LENGTH]
        syl_words = syl_words[:SONG_LENGTH]
        oov_report = oov_report[:SONG_LENGTH]
    elif len(conditions) < SONG_LENGTH:
        pad = np.concatenate((syll_default, word_default))
        conditions += [pad] * (SONG_LENGTH - len(conditions))

    flat = []
    for vec in conditions:
        flat.extend(vec)
    return flat, used_length, oov_report, syl_words


# ---------------------------------------------------------------------------
# GAN inference  (one persistent TF session reused across lines/requests)
# ---------------------------------------------------------------------------
_sess = None
_tensors = None


def _ensure_session(model_path=DEFAULT_GAN_MODEL):
    global _sess, _tensors
    if _sess is not None:
        return
    if not os.path.isdir(model_path):
        raise RuntimeError("GAN model folder not found: %s" % model_path)
    graph = tf.Graph()
    _sess = tfc.Session(graph=graph)
    with graph.as_default():
        tfc.saved_model.loader.load(_sess, [], model_path)
        _tensors = {
            "keep_prob": graph.get_tensor_by_name("model/keep_prob:0"),
            "input_metadata": graph.get_tensor_by_name("model/input_metadata:0"),
            "input_songdata": graph.get_tensor_by_name("model/input_data:0"),
            "output_midi": graph.get_tensor_by_name("output_midi:0"),
        }


def generate_line(flattened_cond, seed=None, model_path=DEFAULT_GAN_MODEL):
    """Run the GAN for a single line. `seed` makes the random songdata input
    reproducible AND lets us chain lines for continuity. Returns a tuned,
    discretized list of [pitch, duration, rest]."""
    _ensure_session(model_path)
    rng = np.random.RandomState(seed) if seed is not None else np.random
    songdata = rng.uniform(size=(1, SONG_LENGTH, NUM_MIDI_FEATURES))
    feed = {
        _tensors["keep_prob"].name: 1.0,
        _tensors["input_songdata"].name: songdata,
        _tensors["input_metadata"].name: [np.split(np.asarray(flattened_cond), SONG_LENGTH)],
    }
    generated = _sess.run(_tensors["output_midi"], feed)
    sample = [x[0, :] for x in generated]
    return midi_statistics.tune_song(utils.discretize(sample))


def _seed_from_pitches(sample, used_length):
    """Derive a stable integer seed from a line's generated pitches, so the
    NEXT line's random draw is influenced by this line's ending -> a light
    sense of continuity between consecutive lines."""
    pitches = [int(round(s[0])) for s in sample[:used_length]]
    h = hashlib.sha256(str(pitches).encode()).hexdigest()
    return int(h[:8], 16)


def generate_multiline(lines, model_path=DEFAULT_GAN_MODEL):
    """Generate a melody for each non-empty line, chaining seeds for
    continuity. Returns a list of per-line dicts."""
    syll_model, word_model = load_embedding_models()
    results = []
    prev_seed = None
    for idx, line in enumerate(lines):
        if not line.strip():
            continue
        flat, used_len, oov, syl_words = line_to_condition(line, syll_model, word_model)
        if flat is None:
            continue
        sample = generate_line(flat, seed=prev_seed, model_path=model_path)
        prev_seed = _seed_from_pitches(sample, used_len)
        results.append({
            "line_index": idx,
            "text": line,
            "sample": sample,
            "used_length": used_len,
            "oov_flags": oov,
            "syllable_words": syl_words,
        })
    return results


# ---------------------------------------------------------------------------
# Output: MIDI, WAV (soundfont), MusicXML, LilyPond-rendered notation
# ---------------------------------------------------------------------------
def save_midi(results, out_path, instrument="piano"):
    """Concatenate all lines into one pretty_midi object and write a .mid.
    Returns the pretty_midi object too (for downstream WAV/score rendering)."""
    import pretty_midi
    program = INSTRUMENTS.get(instrument, 0)
    pm = pretty_midi.PrettyMIDI()
    inst = pretty_midi.Instrument(program=program)
    tempo = 120
    t = 0.0
    for res in results:
        sample = res["sample"][: res["used_length"]]
        for i in range(len(sample)):
            length = sample[i][1] * 60.0 / tempo
            gap = (sample[i + 1][2] * 60.0 / tempo) if i < len(sample) - 1 else 0.0
            note = pretty_midi.Note(
                velocity=100, pitch=int(sample[i][0]), start=t, end=t + length
            )
            inst.notes.append(note)
            t += length + gap
        t += 0.3  # small breath between lines
    pm.instruments.append(inst)
    pm.write(out_path)
    return pm


def render_wav(midi_path, wav_path, soundfont_path=None):
    """Render a MIDI file to WAV using a soundfont via fluidsynth. Falls back
    to pretty_midi's sine synth if fluidsynth/soundfont unavailable (and says
    so by returning the method used)."""
    import pretty_midi
    pm = pretty_midi.PrettyMIDI(midi_path)

    # Try fluidsynth + soundfont first (good quality).
    if soundfont_path and os.path.exists(soundfont_path):
        try:
            audio = pm.fluidsynth(fs=44100, sf2_path=soundfont_path)
            _write_wav(audio, wav_path)
            return "fluidsynth"
        except Exception:
            pass

    # Fallback: built-in sine synth (robotic but always works).
    audio = pm.synthesize(fs=44100)
    _write_wav(audio, wav_path)
    return "sine"


def _write_wav(audio, wav_path):
    from scipy.io import wavfile
    if np.max(np.abs(audio)) > 0:
        audio = audio / np.max(np.abs(audio))
    wavfile.write(wav_path, 44100, (audio * 32767).astype(np.int16))


def save_musicxml(results, xml_path):
    """Write MusicXML using music21, so the user can open it in any notation
    program. Returns True on success, False if music21 isn't available."""
    try:
        from music21 import stream, note as m21note, tempo as m21tempo, meter
    except ImportError:
        return False

    s = stream.Stream()
    s.append(m21tempo.MetronomeMark(number=120))
    s.append(meter.TimeSignature("4/4"))

    # Map our duration values (in quarter-note beats) onto the closest
    # quarterLength music21 understands.
    for res in results:
        sample = res["sample"][: res["used_length"]]
        syl_words = res["syllable_words"]
        for i in range(len(sample)):
            pitch_val = int(sample[i][0])
            dur_beats = float(sample[i][1])
            n = m21note.Note(pitch_val)
            n.quarterLength = max(0.25, round(dur_beats * 4) / 4.0)
            # attach the syllable as a lyric, like the screenshot's alignment
            if i < len(syl_words):
                n.lyric = syl_words[i][0]
            s.append(n)
    s.write("musicxml", fp=xml_path)
    return True


def render_score_png(xml_path, png_path_prefix):
    """Render notation to PNG using LilyPond (via music21's converter).
    Returns the path to the generated PNG, or None if LilyPond isn't
    installed. music21 shells out to lilypond, which must be on PATH."""
    try:
        from music21 import converter, environment
    except ImportError:
        return None
    try:
        us = environment.UserSettings()
        # music21 auto-detects lilypond on PATH; if installed at a custom
        # location, the Dockerfile sets it. We just attempt the conversion.
        score = converter.parse(xml_path)
        out = score.write("lily.png", fp=png_path_prefix)
        return str(out)
    except Exception:
        return None
