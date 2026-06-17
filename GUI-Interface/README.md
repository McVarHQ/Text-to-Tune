# Text-to-Tune GUI

A web interface for the Lyrics2Melody project. Type lyrics line by line, generate
a melody for each line (with light continuity between lines), see the notation, and
download MIDI / MusicXML / WAV.

## Where each file goes

This GUI is **two** pieces that live in different places in your project:

```
Text-to-Tune/                      <- your existing project root
├── melody_engine.py               <-  PUT THIS IN  src/   (next to utils.py)
├── utils.py                       (existing)
├── midi_statistics.py             (existing)
├── enc_models/                    (existing)
├── saved_gan_models/              (existing)
├── outputs/                       (created automatically; MIDI saved here)
│
└── GUI-Interface/                 <-  THIS WHOLE FOLDER goes in the project root
    ├── app.py
    ├── soundfont.sf2              <-  YOU ADD THIS (see "Soundfont" below)
    ├── templates/
    │   └── index.html
    └── static/
        ├── style.css
        ├── app.js
        ├── bg.jpg                 <-  YOU ADD THIS (your 5000x5000 background)
        └── music_symbols/         <-  YOU ADD THIS (the symbol PNGs)
            ├── 01_clef_bass_treble_system.png
            ├── ... (all the rest)
            └── 38_beamed_group_I.png
```

Important: `melody_engine.py` is the ONE file that lives in `src/` (the project
root, alongside `utils.py`), because it imports `utils` and `midi_statistics` and
loads the model. Everything else lives inside `GUI-Interface/`.

## Assets you need to drop in

1. **`static/bg.jpg`** — your background image (the equalizer artwork). Any size;
   it's scaled to fit width.
2. **`static/music_symbols/`** — the folder of note/rest/clef PNGs. The filenames
   the code references are listed in `static/app.js` (the `SYM` object). If your
   filenames differ, edit that object — it's all in one place.
3. **`GUI-Interface/soundfont.sf2`** — a General MIDI soundfont, for good audio.
   Without it, audio still works but uses a robotic sine synth. A free one:
   "FluidR3_GM" or any `.sf2` GM soundfont. Rename it to `soundfont.sf2`.

## Running it

From inside the Docker container (the only place the model runs), at the project
root:

```
python GUI-Interface/app.py
```

Then open **http://localhost:5000** in your browser.

(Port 5000 is exposed in docker-compose.yml alongside Jupyter's 8888.)

## Notes on what's real vs. simplified

- **Per-line continuity**: each line's random seed is derived from the previous
  line's pitches, so consecutive phrases relate to each other. It's a light touch,
  not a re-trained model.
- **Notation**: rendered for real by LilyPond (via music21) when available — the
  `score_png` under the staves. The animated staves themselves use your symbol
  PNGs positioned by pitch, as a live loading visual.
- **Audio / instruments**: the Mix tab swaps the General-MIDI instrument the WAV is
  rendered with. Full per-band EQ is intentionally out of scope.
- **Storage**: only MIDI is persisted, in `outputs/<session_id>/`. WAV and MusicXML
  are generated on demand and offered as browser downloads.
