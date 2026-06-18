# Text-to-Tune GUI  (staged build: Compose -> Voice -> DJ Deck)

A retro-equalizer web interface for the Lyrics2Melody project. Type lyrics line
by line, watch each phrase generate with a real-time progress bar, see the
notation, then play it back on a pianotify-style deck with 128 instruments,
tempo, and a metronome.

## File placement (unchanged from before, plus a soundfont)

```
Text-to-Tune/                       <- project root (= "src")
├── melody_engine.py                <-  PUT IN PROJECT ROOT (next to utils.py)
├── utils.py  midi_statistics.py    (existing)
├── enc_models/  saved_gan_models/  (existing)
├── outputs/                        (auto; MIDI saved per session here)
│
└── GUI-Interface/                  <-  THIS FOLDER in the project root
    ├── app.py
    ├── README.md
    ├── FluidR3_GM.sf2              <-  PUT YOUR SOUNDFONT HERE (for WAV export)
    ├── templates/index.html
    └── static/
        ├── style.css
        ├── app.js
        ├── bg.jpg                  <-  your background
        ├── pianotify.png           <-  your keyboard image
        └── music_symbols/          <-  the note PNGs
```

## Two soundfont roles (important)
- **Browser playback** (instant instrument switching) loads GM instruments from
  a CDN automatically via soundfont-player — nothing for you to install.
- **WAV export** (the download) renders server-side with your real
  `FluidR3_GM.sf2`. Put that file at `GUI-Interface/FluidR3_GM.sf2`
  (or `soundfont.sf2`). If it's missing, WAV export still works but falls back
  to a plain synth.

## Run
From the project root, inside the Docker container:
```
python GUI-Interface/app.py
```
Open http://localhost:5000

## What this stage includes
- Line-numbered lyrics; lines split only when you press Enter (long lines scroll,
  they don't wrap into phantom phrases).
- Real-time progress bar: a fixed estimate for phrase 1, then a rolling average
  of measured phrase times — the staff fills against actual elapsed time.
- One notation render: the loading staves resolve into real (dark-themed)
  LilyPond notation. No separate white box.
- Gated flow: Compose unlocks Voice unlocks DJ Deck.
- Voice tab: optional, multiple audio uploads, or skip.
- DJ Deck (Playback): falling-note piano roll over your keyboard image synced to
  audio; 128 GM instruments (instant switch); tempo slider; metronome with
  volume + 1st-beat accent. Downloads (MIDI / MusicXML / WAV) live here and
  re-render server-side to match the chosen instrument + tempo.
- DJ Deck (Edit): placeholder — the multitrack editor is the next stage.

## Deferred to the next stage (deliberately)
The multitrack **Edit** mode: layering multiple instrument versions + the
uploaded vocal stems on a timeline, aligning them, and bouncing a final mix.
That's a separate, larger build.
