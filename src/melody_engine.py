#!/usr/bin/env python3
"""
melody_engine.py  --  Core Lyrics2Melody logic (the ONE file that lives in src/)
================================================================================
Pure functions behind the Text-to-Tune GUI. No Flask here.

Must sit alongside the original project's utils.py + midi_statistics.py, with:
    ./enc_models/syllEncoding_20190419.bin
    ./enc_models/wordLevelEncoder_20190419.bin
    ./saved_gan_models/saved_model_best_overall_mmd/
"""

import hashlib
import os
import re
import sys

import numpy as np

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

SONG_LENGTH = 20
NUM_MIDI_FEATURES = 3

DEFAULT_SYLL_MODEL = "./enc_models/syllEncoding_20190419.bin"
DEFAULT_WORD_MODEL = "./enc_models/wordLevelEncoder_20190419.bin"
DEFAULT_GAN_MODEL = "./saved_gan_models/saved_model_best_overall_mmd"

# Full General MIDI Level-1 instrument list (program 0-127), with the
# soundfont-player CDN name for each (gleitz MIDI-js soundfonts, FluidR3_GM).
GM_INSTRUMENTS = [
    {"p":0,"n":"Acoustic Grand Piano","sf":"acoustic_grand_piano"},
    {"p":1,"n":"Bright Acoustic Piano","sf":"bright_acoustic_piano"},
    {"p":2,"n":"Electric Grand Piano","sf":"electric_grand_piano"},
    {"p":3,"n":"Honky-tonk Piano","sf":"honky_tonk_piano"},
    {"p":4,"n":"Electric Piano 1","sf":"electric_piano_1"},
    {"p":5,"n":"Electric Piano 2","sf":"electric_piano_2"},
    {"p":6,"n":"Harpsichord","sf":"harpsichord"},
    {"p":7,"n":"Clavinet","sf":"clavinet"},
    {"p":8,"n":"Celesta","sf":"celesta"},
    {"p":9,"n":"Glockenspiel","sf":"glockenspiel"},
    {"p":10,"n":"Music Box","sf":"music_box"},
    {"p":11,"n":"Vibraphone","sf":"vibraphone"},
    {"p":12,"n":"Marimba","sf":"marimba"},
    {"p":13,"n":"Xylophone","sf":"xylophone"},
    {"p":14,"n":"Tubular Bells","sf":"tubular_bells"},
    {"p":15,"n":"Dulcimer","sf":"dulcimer"},
    {"p":16,"n":"Drawbar Organ","sf":"drawbar_organ"},
    {"p":17,"n":"Percussive Organ","sf":"percussive_organ"},
    {"p":18,"n":"Rock Organ","sf":"rock_organ"},
    {"p":19,"n":"Church Organ","sf":"church_organ"},
    {"p":20,"n":"Reed Organ","sf":"reed_organ"},
    {"p":21,"n":"Accordion","sf":"accordion"},
    {"p":22,"n":"Harmonica","sf":"harmonica"},
    {"p":23,"n":"Tango Accordion","sf":"tango_accordion"},
    {"p":24,"n":"Acoustic Guitar (nylon)","sf":"acoustic_guitar_nylon"},
    {"p":25,"n":"Acoustic Guitar (steel)","sf":"acoustic_guitar_steel"},
    {"p":26,"n":"Electric Guitar (jazz)","sf":"electric_guitar_jazz"},
    {"p":27,"n":"Electric Guitar (clean)","sf":"electric_guitar_clean"},
    {"p":28,"n":"Electric Guitar (muted)","sf":"electric_guitar_muted"},
    {"p":29,"n":"Overdriven Guitar","sf":"overdriven_guitar"},
    {"p":30,"n":"Distortion Guitar","sf":"distortion_guitar"},
    {"p":31,"n":"Guitar Harmonics","sf":"guitar_harmonics"},
    {"p":32,"n":"Acoustic Bass","sf":"acoustic_bass"},
    {"p":33,"n":"Electric Bass (finger)","sf":"electric_bass_finger"},
    {"p":34,"n":"Electric Bass (pick)","sf":"electric_bass_pick"},
    {"p":35,"n":"Fretless Bass","sf":"fretless_bass"},
    {"p":36,"n":"Slap Bass 1","sf":"slap_bass_1"},
    {"p":37,"n":"Slap Bass 2","sf":"slap_bass_2"},
    {"p":38,"n":"Synth Bass 1","sf":"synth_bass_1"},
    {"p":39,"n":"Synth Bass 2","sf":"synth_bass_2"},
    {"p":40,"n":"Violin","sf":"violin"},
    {"p":41,"n":"Viola","sf":"viola"},
    {"p":42,"n":"Cello","sf":"cello"},
    {"p":43,"n":"Contrabass","sf":"contrabass"},
    {"p":44,"n":"Tremolo Strings","sf":"tremolo_strings"},
    {"p":45,"n":"Pizzicato Strings","sf":"pizzicato_strings"},
    {"p":46,"n":"Orchestral Harp","sf":"orchestral_harp"},
    {"p":47,"n":"Timpani","sf":"timpani"},
    {"p":48,"n":"String Ensemble 1","sf":"string_ensemble_1"},
    {"p":49,"n":"String Ensemble 2","sf":"string_ensemble_2"},
    {"p":50,"n":"Synth Strings 1","sf":"synth_strings_1"},
    {"p":51,"n":"Synth Strings 2","sf":"synth_strings_2"},
    {"p":52,"n":"Choir Aahs","sf":"choir_aahs"},
    {"p":53,"n":"Voice Oohs","sf":"voice_oohs"},
    {"p":54,"n":"Synth Voice","sf":"synth_voice"},
    {"p":55,"n":"Orchestra Hit","sf":"orchestra_hit"},
    {"p":56,"n":"Trumpet","sf":"trumpet"},
    {"p":57,"n":"Trombone","sf":"trombone"},
    {"p":58,"n":"Tuba","sf":"tuba"},
    {"p":59,"n":"Muted Trumpet","sf":"muted_trumpet"},
    {"p":60,"n":"French Horn","sf":"french_horn"},
    {"p":61,"n":"Brass Section","sf":"brass_section"},
    {"p":62,"n":"Synth Brass 1","sf":"synth_brass_1"},
    {"p":63,"n":"Synth Brass 2","sf":"synth_brass_2"},
    {"p":64,"n":"Soprano Sax","sf":"soprano_sax"},
    {"p":65,"n":"Alto Sax","sf":"alto_sax"},
    {"p":66,"n":"Tenor Sax","sf":"tenor_sax"},
    {"p":67,"n":"Baritone Sax","sf":"baritone_sax"},
    {"p":68,"n":"Oboe","sf":"oboe"},
    {"p":69,"n":"English Horn","sf":"english_horn"},
    {"p":70,"n":"Bassoon","sf":"bassoon"},
    {"p":71,"n":"Clarinet","sf":"clarinet"},
    {"p":72,"n":"Piccolo","sf":"piccolo"},
    {"p":73,"n":"Flute","sf":"flute"},
    {"p":74,"n":"Recorder","sf":"recorder"},
    {"p":75,"n":"Pan Flute","sf":"pan_flute"},
    {"p":76,"n":"Blown Bottle","sf":"blown_bottle"},
    {"p":77,"n":"Shakuhachi","sf":"shakuhachi"},
    {"p":78,"n":"Whistle","sf":"whistle"},
    {"p":79,"n":"Ocarina","sf":"ocarina"},
    {"p":80,"n":"Lead 1 (square)","sf":"lead_1_square"},
    {"p":81,"n":"Lead 2 (sawtooth)","sf":"lead_2_sawtooth"},
    {"p":82,"n":"Lead 3 (calliope)","sf":"lead_3_calliope"},
    {"p":83,"n":"Lead 4 (chiff)","sf":"lead_4_chiff"},
    {"p":84,"n":"Lead 5 (charang)","sf":"lead_5_charang"},
    {"p":85,"n":"Lead 6 (voice)","sf":"lead_6_voice"},
    {"p":86,"n":"Lead 7 (fifths)","sf":"lead_7_fifths"},
    {"p":87,"n":"Lead 8 (bass + lead)","sf":"lead_8_bass_plus_lead"},
    {"p":88,"n":"Pad 1 (new age)","sf":"pad_1_new_age"},
    {"p":89,"n":"Pad 2 (warm)","sf":"pad_2_warm"},
    {"p":90,"n":"Pad 3 (polysynth)","sf":"pad_3_polysynth"},
    {"p":91,"n":"Pad 4 (choir)","sf":"pad_4_choir"},
    {"p":92,"n":"Pad 5 (bowed)","sf":"pad_5_bowed"},
    {"p":93,"n":"Pad 6 (metallic)","sf":"pad_6_metallic"},
    {"p":94,"n":"Pad 7 (halo)","sf":"pad_7_halo"},
    {"p":95,"n":"Pad 8 (sweep)","sf":"pad_8_sweep"},
    {"p":96,"n":"FX 1 (rain)","sf":"fx_1_rain"},
    {"p":97,"n":"FX 2 (soundtrack)","sf":"fx_2_soundtrack"},
    {"p":98,"n":"FX 3 (crystal)","sf":"fx_3_crystal"},
    {"p":99,"n":"FX 4 (atmosphere)","sf":"fx_4_atmosphere"},
    {"p":100,"n":"FX 5 (brightness)","sf":"fx_5_brightness"},
    {"p":101,"n":"FX 6 (goblins)","sf":"fx_6_goblins"},
    {"p":102,"n":"FX 7 (echoes)","sf":"fx_7_echoes"},
    {"p":103,"n":"FX 8 (sci-fi)","sf":"fx_8_sci_fi"},
    {"p":104,"n":"Sitar","sf":"sitar"},
    {"p":105,"n":"Banjo","sf":"banjo"},
    {"p":106,"n":"Shamisen","sf":"shamisen"},
    {"p":107,"n":"Koto","sf":"koto"},
    {"p":108,"n":"Kalimba","sf":"kalimba"},
    {"p":109,"n":"Bagpipe","sf":"bagpipe"},
    {"p":110,"n":"Fiddle","sf":"fiddle"},
    {"p":111,"n":"Shanai","sf":"shanai"},
    {"p":112,"n":"Tinkle Bell","sf":"tinkle_bell"},
    {"p":113,"n":"Agogo","sf":"agogo"},
    {"p":114,"n":"Steel Drums","sf":"steel_drums"},
    {"p":115,"n":"Woodblock","sf":"woodblock"},
    {"p":116,"n":"Taiko Drum","sf":"taiko_drum"},
    {"p":117,"n":"Melodic Tom","sf":"melodic_tom"},
    {"p":118,"n":"Synth Drum","sf":"synth_drum"},
    {"p":119,"n":"Reverse Cymbal","sf":"reverse_cymbal"},
    {"p":120,"n":"Guitar Fret Noise","sf":"guitar_fret_noise"},
    {"p":121,"n":"Breath Noise","sf":"breath_noise"},
    {"p":122,"n":"Seashore","sf":"seashore"},
    {"p":123,"n":"Bird Tweet","sf":"bird_tweet"},
    {"p":124,"n":"Telephone Ring","sf":"telephone_ring"},
    {"p":125,"n":"Helicopter","sf":"helicopter"},
    {"p":126,"n":"Applause","sf":"applause"},
    {"p":127,"n":"Gunshot","sf":"gunshot"},
]


# program number -> display name, for convenience
PROGRAM_TO_NAME = {i["p"]: i["n"] for i in GM_INSTRUMENTS}

# ---------------------------------------------------------------------------
# Model loading (cached at module level)
# ---------------------------------------------------------------------------
_syll_model = None
_word_model = None


def load_embedding_models(syll_path=DEFAULT_SYLL_MODEL, word_path=DEFAULT_WORD_MODEL):
    global _syll_model, _word_model
    if Word2Vec is None:
        raise RuntimeError("gensim is not installed.")
    if _syll_model is None:
        _syll_model = Word2Vec.load(syll_path)
    if _word_model is None:
        _word_model = Word2Vec.load(word_path)
    return _syll_model, _word_model


# ---------------------------------------------------------------------------
# Vocabulary helpers (gensim 3.x / 4.x tolerant)
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
    for candidate in (key, key.lower(), key.capitalize(), key.upper()):
        if _in_vocab(model_wv, candidate):
            return model_wv[candidate], candidate
    return default_vec, None


def _centroid(model_wv):
    if hasattr(model_wv, "vectors"):
        return model_wv.vectors.mean(axis=0)
    return np.array([model_wv[k] for k in model_wv.index_to_key]).mean(axis=0)


# ---------------------------------------------------------------------------
# Lyrics -> syllables -> conditioning
# ---------------------------------------------------------------------------
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


def _tokenize_words(line_text):
    """Robust word extraction:
      - lowercase everything
      - split punctuation off words even when there's no surrounding space,
        so "fool,bar" -> ["fool", "bar"] and "me!" -> ["me"]
      - keep word-internal apostrophes ("don't" stays one word)
    Pure punctuation tokens are dropped (they separate words but don't become
    notes). Returns a flat list of lowercase word strings.
    """
    text = line_text.lower()
    # insert spaces around any run of non-word, non-apostrophe characters,
    # so punctuation glued to words gets separated into its own token
    text = re.sub(r"([^\w'\s]+)", r" \1 ", text)
    raw = text.split()
    words = []
    for tok in raw:
        w = _clean(tok)               # strip any leftover edge punctuation
        if w and re.search(r"[a-z0-9]", w):   # keep only tokens with a letter/digit
            words.append(w)
    return words


def line_to_condition(line_text, syll_model, word_model):
    syll_default = _centroid(syll_model.wv)
    word_default = _centroid(word_model.wv)
    words = _tokenize_words(line_text)
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
# GAN inference (one persistent session)
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
    pitches = [int(round(s[0])) for s in sample[:used_length]]
    h = hashlib.sha256(str(pitches).encode()).hexdigest()
    return int(h[:8], 16)


# ---------------------------------------------------------------------------
# Output: MIDI, WAV, MusicXML, dark-themed notation PNG
# ---------------------------------------------------------------------------
def save_midi(results, out_path, program=0, tempo=120):
    import pretty_midi
    pm = pretty_midi.PrettyMIDI(initial_tempo=tempo)
    inst = pretty_midi.Instrument(program=program)
    t = 0.0
    for res in results:
        sample = res["sample"][: res["used_length"]]
        for i in range(len(sample)):
            length = sample[i][1] * 60.0 / tempo
            gap = (sample[i + 1][2] * 60.0 / tempo) if i < len(sample) - 1 else 0.0
            note = pretty_midi.Note(velocity=100, pitch=int(sample[i][0]), start=t, end=t + length)
            inst.notes.append(note)
            t += length + gap
        t += 0.3
    pm.instruments.append(inst)
    pm.write(out_path)
    return pm


def render_wav(midi_path, wav_path, soundfont_path=None,
               metronome=False, metro_tempo=120, metro_vol=0.6):
    import pretty_midi
    pm = pretty_midi.PrettyMIDI(midi_path)
    method = "sine"
    audio = None
    if soundfont_path and os.path.exists(soundfont_path):
        try:
            audio = pm.fluidsynth(fs=44100, sf2_path=soundfont_path)
            method = "fluidsynth"
        except Exception:
            audio = None
    if audio is None:
        audio = pm.synthesize(fs=44100)
        method = "sine"
    if metronome:
        audio = _mix_metronome(audio, 44100, metro_tempo, metro_vol)
    _write_wav(audio, wav_path)
    return method


def _mix_metronome(audio, fs, tempo, vol):
    """Mix a click track into the audio at the given (independent) tempo.
    First beat of each bar of 4 is accented."""
    audio = np.asarray(audio, dtype=np.float64)
    # normalise the music first so the click sits at a predictable level
    peak = np.max(np.abs(audio)) if audio.size else 0
    if peak > 0:
        audio = audio / peak
    total = len(audio)
    beat = 60.0 / float(tempo if tempo else 120)
    click_len = int(0.04 * fs)
    t = np.arange(click_len) / fs
    env = np.exp(-t * 60.0)
    beat_idx = 0
    pos = 0.0
    while int(pos * fs) < total:
        start = int(pos * fs)
        accent = (beat_idx % 4 == 0)
        freq = 1600.0 if accent else 1000.0
        amp = float(vol) * (0.95 if accent else 0.7)
        click = (np.sin(2 * np.pi * freq * t) * env * amp).astype(np.float64)
        end = min(start + click_len, total)
        audio[start:end] += click[: end - start]
        pos += beat
        beat_idx += 1
    return audio


def _write_wav(audio, wav_path):
    from scipy.io import wavfile
    if np.max(np.abs(audio)) > 0:
        audio = audio / np.max(np.abs(audio))
    wavfile.write(wav_path, 44100, (audio * 32767).astype(np.int16))


def save_musicxml(results, xml_path, tempo=120):
    try:
        from music21 import stream, note as m21note, tempo as m21tempo, meter
    except ImportError:
        return False
    s = stream.Stream()
    s.append(m21tempo.MetronomeMark(number=tempo))
    s.append(meter.TimeSignature("4/4"))
    for res in results:
        sample = res["sample"][: res["used_length"]]
        syl_words = res["syllable_words"]
        for i in range(len(sample)):
            n = m21note.Note(int(sample[i][0]))
            n.quarterLength = max(0.25, round(float(sample[i][1]) * 4) / 4.0)
            if i < len(syl_words):
                n.lyric = syl_words[i][0]
            s.append(n)
    s.write("musicxml", fp=xml_path)
    return True


def render_score_png(xml_path, png_path_prefix):
    """Render notation to PNG via LilyPond (music21 shells out). Returns path
    or None. We post-process the PNG to be transparent + light-inked so it sits
    on the dark UI instead of being a white box."""
    try:
        from music21 import converter
    except ImportError:
        return None
    try:
        score = converter.parse(xml_path)
        out = score.write("lily.png", fp=png_path_prefix)
        out = str(out)
        _theme_png(out)
        return out
    except Exception:
        return None


def _theme_png(png_path):
    """Make a black-on-white LilyPond PNG into light-ink-on-transparent so it
    blends with the dark UI. White -> transparent, black ink -> pale lavender."""
    try:
        from PIL import Image
        img = Image.open(png_path).convert("RGBA")
        px = img.getdata()
        out = []
        for r, g, b, a in px:
            # luminance: white background -> transparent; dark ink -> light tint
            lum = (r + g + b) / 3
            if lum > 200:
                out.append((0, 0, 0, 0))            # transparent background
            else:
                # pale lavender ink, alpha scaled by how dark the pixel was
                ink = int(255 - lum)
                out.append((222, 226, 255, min(255, ink + 80)))
        img.putdata(out)
        img.save(png_path)
    except Exception:
        pass  # if PIL missing or anything fails, leave the original PNG
