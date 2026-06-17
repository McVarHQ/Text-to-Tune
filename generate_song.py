#!/usr/bin/env python3
"""
generate_song.py
=================
Turns a plain typed line of lyrics into a generated melody using the
trained Lyrics2Melody GAN, and writes out a playable .mid and .wav file.

USAGE
-----
    python generate_song.py "you turn my nights into days"
    python generate_song.py            # will prompt you to type lyrics instead

    python generate_song.py "some lyrics" --output-dir output --oov-strategy neutral

REQUIREMENTS
------------
This script must live in the same folder as `utils.py` and
`midi_statistics.py` from the original project (it imports and reuses
their MIDI-building/tuning logic rather than reimplementing it).

It also needs the `pyphen` package for automatic syllable splitting:
    pip install pyphen

IMPORTANT CAVEATS (read before assuming a failure is a bug in this script)
---------------------------------------------------------------------
1. `utils.py` does `import midi` (the old PyPI "midi" package). That
   package's source has Python-2-only syntax and will not import under
   Python 3 unless it has been patched (see the Dockerfile from earlier
   in this project, which clones the v0.2.3 tag and runs `2to3` on it).
   If you get `ModuleNotFoundError: No module named 'midi'`, that is the
   fix needed -- it is not something this script can work around.

2. This project's GAN was trained and saved under TensorFlow 1.14. This
   script uses `tf.compat.v1` calls so it has a chance of also working
   under a modern TensorFlow 2.x install, but that is NOT guaranteed --
   some ops baked into the old SavedModel graph may not exist in newer
   TensorFlow runtimes. The environment this is most likely to work in
   reliably is the TF1.14 Docker container built earlier for this
   project, not a bare modern Python 3.10+ install.

3. Syllable splitting uses `pyphen`, a hyphenation library. It matches
   this project's manual syllable splits very well in testing (e.g.
   "mysterious" -> "mys-te-ri-ous", exactly matching the example already
   in your notebooks), but it is an approximation, not a guarantee of
   matching how the original training corpus was syllabified.
"""

import argparse
import datetime
import os
import re
import sys

import numpy as np

try:
    import pyphen
except ImportError:
    sys.exit(
        "Missing dependency 'pyphen'. Install it with:\n"
        "    pip install pyphen\n"
    )

try:
    from gensim.models import Word2Vec
except ImportError:
    sys.exit("Missing dependency 'gensim'. Install it with:\n    pip install gensim\n")

try:
    import tensorflow as tf
    # Use the v1-compatible API regardless of whether TF1.x or TF2.x is
    # installed, since this project's model was built with the old
    # Session/SavedModel-loader API.
    tfc = tf.compat.v1
    if tf.__version__.startswith("2"):
        tfc.disable_v2_behavior()
except ImportError:
    sys.exit("Missing dependency 'tensorflow'. This project needs tensorflow-gpu==1.14.0 "
              "(or a TF1-compatible install) -- see the project README.\n")

# These come from the original project and are reused as-is.
try:
    import utils
    import midi_statistics
except ImportError:
    sys.exit(
        "Could not import 'utils' and 'midi_statistics'. This script must be "
        "placed in the same folder as those two files from the original project.\n"
    )


# ---------------------------------------------------------------------------
# Configuration -- must match the settings the GAN was actually trained with.
# These defaults match the values hardcoded in "4. Create song.ipynb".
# ---------------------------------------------------------------------------
SONG_LENGTH = 20        # number of syllable "slots" the GAN expects per song
NUM_MIDI_FEATURES = 3   # pitch, duration, rest


# ---------------------------------------------------------------------------
# Word2Vec helpers (version-tolerant across gensim 3.x and 4.x)
# ---------------------------------------------------------------------------
def in_vocab(model_wv, key):
    """Check vocabulary membership across gensim versions.

    gensim 4.x removed `.wv.vocab`; the supported check is `key in model_wv`
    in both 3.x and 4.x, so we use that as the primary path and only fall
    back to the old `.vocab` attribute for very old gensim versions where
    `in` might not be implemented the same way.
    """
    try:
        return key in model_wv
    except Exception:
        try:
            return key in model_wv.vocab
        except Exception:
            return False


def get_embedding(model_wv, key, default_vec):
    """Look up an embedding, trying a few case variants before giving up.

    Returns (vector, used_key_or_None). used_key_or_None is None if the
    fallback default vector had to be used (i.e. the word/syllable was
    out-of-vocabulary in every case variant tried).
    """
    candidates = [key, key.lower(), key.capitalize(), key.upper()]
    seen = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        if in_vocab(model_wv, candidate):
            return model_wv[candidate], candidate
    return default_vec, None


def compute_centroid(model_wv):
    """Mean vector across the whole vocabulary -- used as a 'neutral'
    fallback embedding for out-of-vocabulary words/syllables. A centroid
    sits near the middle of the embedding space rather than being any
    specific word's meaning, so substituting it in shouldn't strongly bias
    the generated melody toward any particular sound the way reusing an
    arbitrary real word (e.g. always falling back to "I") might.
    """
    vectors = model_wv.vectors if hasattr(model_wv, "vectors") else \
        np.array([model_wv[k] for k in model_wv.index_to_key])
    return vectors.mean(axis=0)


# ---------------------------------------------------------------------------
# Lyrics -> syllables -> conditioning vector
# ---------------------------------------------------------------------------
def clean_word(word):
    """Strip leading/trailing punctuation but keep internal apostrophes,
    since the vocabulary contains contractions like "I'm" and "don't".
    """
    return re.sub(r"^[^\w']+|[^\w']+$", "", word)


def syllabify(word, dic):
    """Split a word into syllables using pyphen. Falls back to treating
    the whole word as a single syllable if pyphen can't hyphenate it
    (e.g. very short words, or tokens it doesn't recognize).
    """
    try:
        hyphenated = dic.inserted(word, hyphen="-")
        syllables = hyphenated.split("-")
        return [s for s in syllables if s] or [word]
    except Exception:
        return [word]


def lyrics_to_condition(lyrics_text, syll_model, word_model, oov_strategy="neutral"):
    """Convert a plain string of lyrics into the flattened conditioning
    vector the GAN expects, handling unknown words/syllables gracefully.

    oov_strategy:
      "neutral" (default) -- substitute a centroid/neutral embedding for
                              any unknown syllable or word, so the song
                              keeps its intended length and structure.
      "drop"               -- skip that syllable's slot entirely. The
                              song may end up shorter as a result (it will
                              still be padded back up to SONG_LENGTH).

    Returns: (flattened_cond, used_length, oov_report)
      oov_report is a list of (syllable, word, used_fallback: bool) so the
      caller can show the user what was substituted.
    """
    dic = pyphen.Pyphen(lang="en_US")

    syll_default = compute_centroid(syll_model.wv)
    word_default = compute_centroid(word_model.wv)

    words = [clean_word(w) for w in lyrics_text.strip().split()]
    words = [w for w in words if w]  # drop anything that cleaned to empty
    if not words:
        sys.exit("No usable words found in the lyrics you typed.")

    syllable_word_pairs = []
    for word in words:
        for syll in syllabify(word, dic):
            syllable_word_pairs.append((syll, word))

    conditions = []
    oov_report = []
    for syll, word in syllable_word_pairs:
        syll_vec, syll_used = get_embedding(syll_model.wv, syll, syll_default)
        word_vec, word_used = get_embedding(word_model.wv, word, word_default)
        used_fallback = (syll_used is None) or (word_used is None)

        if used_fallback and oov_strategy == "drop":
            oov_report.append((syll, word, True))
            continue

        conditions.append(np.concatenate((syll_vec, word_vec)))
        oov_report.append((syll, word, used_fallback))

    if not conditions:
        sys.exit(
            "Every syllable in your lyrics was out-of-vocabulary and "
            "oov_strategy='drop' removed all of them. Try different "
            "words, or rerun with --oov-strategy neutral."
        )

    used_length = len(conditions)

    # Truncate or pad to exactly SONG_LENGTH, since the GAN's graph has a
    # fixed input size.
    if used_length > SONG_LENGTH:
        print(f"Note: your lyrics produced {used_length} syllables, but this "
              f"model only supports {SONG_LENGTH}. Truncating to the first "
              f"{SONG_LENGTH}.")
        conditions = conditions[:SONG_LENGTH]
        used_length = SONG_LENGTH
    elif used_length < SONG_LENGTH:
        pad_vec = np.concatenate((syll_default, word_default))
        conditions += [pad_vec] * (SONG_LENGTH - used_length)
        print(f"Note: your lyrics produced {used_length} syllables; padding "
              f"the remaining {SONG_LENGTH - used_length} slots with a "
              f"neutral filler so the model has a full {SONG_LENGTH}-step input.")

    flattened_cond = []
    for vec in conditions:
        flattened_cond.extend(vec)

    return flattened_cond, used_length, oov_report


# ---------------------------------------------------------------------------
# GAN inference
# ---------------------------------------------------------------------------
def generate_melody(flattened_cond, model_path):
    """Runs the trained GAN and returns a tuned, discretized melody
    (list of [pitch, duration, rest] entries).
    """
    if not os.path.isdir(model_path):
        sys.exit(f"Model path not found: {model_path}\n"
                  f"Check --model-path, or that saved_gan_models/ is present.")

    with tfc.Session(graph=tf.Graph()) as sess:
        tfc.saved_model.loader.load(sess, [], model_path)
        graph = tfc.get_default_graph()
        keep_prob = graph.get_tensor_by_name("model/keep_prob:0")
        input_metadata = graph.get_tensor_by_name("model/input_metadata:0")
        input_songdata = graph.get_tensor_by_name("model/input_data:0")
        output_midi = graph.get_tensor_by_name("output_midi:0")

        feed_dict = {
            keep_prob.name: 1.0,
            input_songdata.name: np.random.uniform(size=(1, SONG_LENGTH, NUM_MIDI_FEATURES)),
        }
        condition = [np.split(np.asarray(flattened_cond), SONG_LENGTH)]
        feed_dict[input_metadata.name] = condition

        generated_features = sess.run(output_midi, feed_dict)

    sample = [x[0, :] for x in generated_features]
    sample = midi_statistics.tune_song(utils.discretize(sample))
    return sample


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
def save_outputs(sample, used_length, output_dir, base_name=None):
    os.makedirs(output_dir, exist_ok=True)

    if base_name is None:
        base_name = "song_" + datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

    midi_pattern = utils.create_midi_pattern_from_discretized_data(sample[0:used_length])

    mid_path = os.path.join(output_dir, base_name + ".mid")
    midi_pattern.write(mid_path)

    wav_path = os.path.join(output_dir, base_name + ".wav")
    try:
        audio = midi_pattern.synthesize(fs=44100)  # built-in sine synth, no soundfont needed
        # Normalize and convert to 16-bit PCM for maximum playback compatibility.
        if np.max(np.abs(audio)) > 0:
            audio = audio / np.max(np.abs(audio))
        audio_int16 = (audio * 32767).astype(np.int16)
        from scipy.io import wavfile
        wavfile.write(wav_path, 44100, audio_int16)
    except Exception as e:
        wav_path = None
        print(f"Note: could not render a .wav preview ({e}). The .mid file is "
              f"still valid and playable in any MIDI-capable player.")

    return mid_path, wav_path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Generate a melody from typed lyrics.")
    parser.add_argument("lyrics", nargs="?", default=None,
                         help="Lyrics line as a plain string. If omitted, you'll be prompted.")
    parser.add_argument("--syll-model", default="./enc_models/syllEncoding_20190419.bin")
    parser.add_argument("--word-model", default="./enc_models/wordLevelEncoder_20190419.bin")
    parser.add_argument("--model-path", default="./saved_gan_models/saved_model_best_overall_mmd")
    parser.add_argument("--output-dir", default="./output")
    parser.add_argument("--oov-strategy", choices=["neutral", "drop"], default="neutral",
                         help="How to handle words/syllables the model has never seen. "
                              "'neutral' substitutes a safe filler embedding (default, recommended). "
                              "'drop' removes that syllable from the song entirely.")
    args = parser.parse_args()

    lyrics_text = args.lyrics
    if not lyrics_text:
        print("\n" + "=" * 60)
        print("WAITING FOR INPUT")
        print("=" * 60)
        sys.stdout.flush()  # ensure this prints before input() blocks,
                             # even if stdout is buffered (common when
                             # running inside a Docker container)
        lyrics_text = input(">>> Type a line of lyrics, then press Enter: ").strip()
    if not lyrics_text:
        sys.exit("No lyrics provided.")

    print("Loading word/syllable embedding models...")
    syll_model = Word2Vec.load(args.syll_model)
    word_model = Word2Vec.load(args.word_model)

    flattened_cond, used_length, oov_report = lyrics_to_condition(
        lyrics_text, syll_model, word_model, oov_strategy=args.oov_strategy
    )

    oov_count = sum(1 for _, _, used_fallback in oov_report if used_fallback)
    if oov_count:
        print(f"{oov_count} of {len(oov_report)} syllables were not in the training "
              f"vocabulary and used a neutral fallback embedding:")
        for syll, word, used_fallback in oov_report:
            if used_fallback:
                print(f"   '{syll}' (from word '{word}')")

    print("Generating melody...")
    sample = generate_melody(flattened_cond, args.model_path)

    mid_path, wav_path = save_outputs(sample, used_length, args.output_dir)

    print("\nDone.")
    print(f"MIDI file: {mid_path}")
    if wav_path:
        print(f"WAV preview: {wav_path}")


if __name__ == "__main__":
    main()
