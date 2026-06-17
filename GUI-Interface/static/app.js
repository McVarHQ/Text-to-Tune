/* ============================================================
   Text-to-Tune  --  frontend logic
   ============================================================ */

// inject bg image url (from Flask static) into the CSS variable
document.documentElement.style.setProperty("--bg-image", `url("${window.T2T.bgUrl}")`);

/* ---------- tab switching ---------- */
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("is-active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("is-active"));
    tab.classList.add("is-active");
    document.querySelector(`[data-panel="${tab.dataset.tab}"]`).classList.add("is-active");
  });
});

/* ---------- live line numbers in the gutter ---------- */
const lyricsEl = document.getElementById("lyrics");
const gutter = document.getElementById("gutter");
function refreshGutter(){
  const lines = lyricsEl.value.split("\n").length || 1;
  let html = "";
  for (let i = 1; i <= lines; i++) html += `<span>${i}</span>`;
  gutter.innerHTML = html;
}
lyricsEl.addEventListener("input", refreshGutter);
lyricsEl.addEventListener("scroll", () => { gutter.scrollTop = lyricsEl.scrollTop; });
refreshGutter();

/* ---------- instrument selection sync (Mix tab <-> Compose dropdown) ---------- */
let currentInstrument = window.T2T.instruments[0];
const instSelect = document.getElementById("instrument");
const instCards = document.querySelectorAll(".inst-card");

function setInstrument(name){
  currentInstrument = name;
  instSelect.value = name;
  instCards.forEach(c => c.classList.toggle("sel", c.dataset.inst === name));
}
instSelect.addEventListener("change", () => setInstrument(instSelect.value));
instCards.forEach(card => {
  card.addEventListener("click", () => setInstrument(card.dataset.inst));
});
setInstrument(currentInstrument);

/* ---------- music symbol mapping ----------
   We map a note's duration (in quarter-note beats) to one of the provided
   PNG symbols, and its MIDI pitch to a vertical position on the staff.
   Filenames + native dimensions are from the music_symbols folder.        */
const SYM = {
  // duration(beats) -> {file, w, h}  (filled note-heads, single notes)
  noteFilled: { file: "23_note_filled_C.png", w: 405, h: 682 },  // generic filled note w/ stem+flag
  noteHollow: { file: "16_note_hollow_C.png", w: 392, h: 681 },  // half note
  noteWhole:  { file: "05_symbol_pair_1.png", w: 296, h: 224 },  // whole note (oval)
  quarter:    { file: "21_note_filled_A.png", w: 283, h: 682 },  // plain quarter (stem, no flag)
};
const SYMBOL_BASE = "/static/music_symbols/";

// Which symbol to use for a given duration in beats.
function symbolForDuration(durBeats){
  if (durBeats >= 4)   return SYM.noteWhole;
  if (durBeats >= 2)   return SYM.noteHollow;
  if (durBeats >= 1)   return SYM.quarter;
  return SYM.noteFilled;  // eighth/sixteenth -> filled w/ flag
}

// MIDI pitch -> vertical offset on the staff (0 = middle line).
// Treble staff: E4(64)=bottom line ... F5(77)=top line. We map linearly and
// clamp so extreme pitches stay near the staff rather than flying off.
function pitchToY(pitch, staffHeight){
  const mid = 71; // B4, middle line of treble staff
  const semitonesFromMid = pitch - mid;
  // ~ one staff step (line/space) per ~1.5 semitones, visually pleasing
  const step = (staffHeight * 0.5) / 8;       // 8 steps from middle to edge
  let y = (staffHeight / 2) - semitonesFromMid * step * 0.5;
  y = Math.max(6, Math.min(staffHeight - 6, y));
  return y;
}

/* ---------- generation flow ---------- */
const generateBtn = document.getElementById("generateBtn");
const composeHint = document.getElementById("composeHint");
const stage = document.getElementById("stage");
const stageLabel = document.getElementById("stageLabel");
const stavesEl = document.getElementById("staves");
const results = document.getElementById("results");

let pollTimer = null;

generateBtn.addEventListener("click", async () => {
  const lyrics = lyricsEl.value.trim();
  composeHint.className = "hint";
  composeHint.textContent = "";
  if (!lyrics){
    composeHint.className = "hint error";
    composeHint.textContent = "Type at least one line of lyrics first.";
    return;
  }

  const lines = lyrics.split("\n").filter(l => l.trim());
  // build one empty staff per line and start the fill animation
  buildStaves(lines.length);
  stage.hidden = false;
  results.hidden = true;
  stageLabel.textContent = "Composing\u2026";
  generateBtn.disabled = true;

  try{
    const resp = await fetch("/generate", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ lyrics, instrument: currentInstrument })
    });
    const data = await resp.json();
    if (data.error){
      composeHint.className = "hint error";
      composeHint.textContent = data.error;
      generateBtn.disabled = false;
      return;
    }
    pollProgress(data.job_id);
  }catch(e){
    composeHint.className = "hint error";
    composeHint.textContent = "Could not reach the server: " + e;
    generateBtn.disabled = false;
  }
});

function buildStaves(n){
  stavesEl.innerHTML = "";
  for (let i = 0; i < n; i++){
    const staff = document.createElement("div");
    staff.className = "staff";
    staff.innerHTML = `<div class="fill"></div><div class="notes"></div>`;
    stavesEl.appendChild(staff);
  }
}

function pollProgress(jobId){
  const staves = stavesEl.querySelectorAll(".staff");
  pollTimer = setInterval(async () => {
    let data;
    try{
      const r = await fetch(`/progress/${jobId}`);
      data = await r.json();
    }catch(e){ return; }

    // animate staves up to the number completed
    for (let i = 0; i < data.done && i < staves.length; i++){
      staves[i].classList.add("filling");
    }
    stageLabel.textContent = `Composing\u2026 phrase ${Math.min(data.done+1, data.total)} of ${data.total}`;

    if (data.status === "done"){
      clearInterval(pollTimer);
      stageLabel.textContent = "Done";
      renderResult(data.result);
      generateBtn.disabled = false;
    } else if (data.status === "error"){
      clearInterval(pollTimer);
      composeHint.className = "hint error";
      composeHint.textContent = "Generation failed: " + (data.error || "").split("\n")[0];
      generateBtn.disabled = false;
    }
  }, 500);
}

function renderResult(result){
  const staves = stavesEl.querySelectorAll(".staff");

  result.lines.forEach((line, idx) => {
    if (idx >= staves.length) return;
    const staff = staves[idx];
    staff.classList.remove("filling");
    staff.classList.add("done");
    const notesLayer = staff.querySelector(".notes");
    notesLayer.innerHTML = "";

    const h = staff.clientHeight;
    const w = staff.clientWidth;
    const n = line.notes.length || 1;
    const leftPad = 40, rightPad = 20;
    const span = w - leftPad - rightPad;

    line.notes.forEach((note, j) => {
      const sym = symbolForDuration(note.dur);
      const x = leftPad + (span * (j + 0.5) / n);
      const y = pitchToY(note.pitch, h);
      const img = document.createElement("img");
      img.className = "note-img";
      img.src = SYMBOL_BASE + sym.file;
      // scale the symbol to a sensible height on the staff, preserve aspect
      const targetH = h * 0.78;
      const scale = targetH / sym.h;
      img.style.height = targetH + "px";
      img.style.width = (sym.w * scale) + "px";
      img.style.left = x + "px";
      img.style.top = y + "px";
      notesLayer.appendChild(img);
    });
  });

  // if lilypond produced a real score image, show it under the staves
  if (result.score_png){
    const scoreImg = document.createElement("img");
    scoreImg.className = "score-img";
    scoreImg.src = `/score/${result.session_id}/${result.score_png}`;
    scoreImg.alt = "Generated notation";
    stavesEl.appendChild(scoreImg);
  }

  // wire up downloads + show results panel
  results.hidden = false;
  document.getElementById("dlXml").style.display = result.has_xml ? "" : "none";
}

/* ---------- audio render + play ---------- */
const renderBtn = document.getElementById("renderBtn");
const player = document.getElementById("player");

renderBtn.addEventListener("click", async () => {
  renderBtn.disabled = true;
  const original = renderBtn.textContent;
  renderBtn.textContent = "Rendering\u2026";
  try{
    const r = await fetch("/render_wav", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ instrument: currentInstrument })
    });
    const data = await r.json();
    if (data.error){
      composeHint.className = "hint error";
      composeHint.textContent = data.error;
    } else {
      // cache-bust so the player reloads the new render
      player.src = "/audio/wav?t=" + Date.now();
      player.load();
      if (data.method === "sine"){
        composeHint.className = "hint";
        composeHint.textContent = "Rendered with the built-in synth (no soundfont found). Add soundfont.sf2 for richer instruments.";
      } else {
        composeHint.className = "hint ok";
        composeHint.textContent = "Rendered with " + currentInstrument + ".";
      }
    }
  }catch(e){
    composeHint.className = "hint error";
    composeHint.textContent = "Render failed: " + e;
  }
  renderBtn.textContent = original;
  renderBtn.disabled = false;
});

/* ---------- voice upload ---------- */
const drop = document.getElementById("drop");
const vocalFile = document.getElementById("vocalFile");
const dropText = document.getElementById("dropText");
const voiceHint = document.getElementById("voiceHint");

drop.addEventListener("click", () => vocalFile.click());
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", e => {
  e.preventDefault();
  drop.classList.remove("over");
  if (e.dataTransfer.files.length) uploadVocal(e.dataTransfer.files[0]);
});
vocalFile.addEventListener("change", () => {
  if (vocalFile.files.length) uploadVocal(vocalFile.files[0]);
});

async function uploadVocal(file){
  dropText.textContent = "Uploading " + file.name + "\u2026";
  const fd = new FormData();
  fd.append("file", file);
  try{
    const r = await fetch("/upload_vocals", { method:"POST", body:fd });
    const data = await r.json();
    if (data.error){
      voiceHint.className = "hint error";
      voiceHint.textContent = data.error;
      dropText.textContent = "Drop a vocal file here, or click to choose";
    } else {
      dropText.textContent = file.name + " \u2713";
      voiceHint.className = "hint ok";
      voiceHint.textContent = "Vocal track saved for this session.";
    }
  }catch(e){
    voiceHint.className = "hint error";
    voiceHint.textContent = "Upload failed: " + e;
  }
}
