/* ============================================================
   TEXT-TO-TUNE  frontend
   - gated steps (Compose -> Voice -> DJ), Voice skippable
   - fake logarithmic progress (~10 min target), staff draws in (VexFlow),
     then notes fade onto that same staff
   - DJ deck plays server-rendered WAV (real FluidR3_GM.sf2, no CDN)
   ============================================================ */
document.documentElement.style.setProperty("--bg-image", `url("${window.T2T.bgUrl}")`);

const $  = (s)=>document.querySelector(s);
const $$ = (s)=>document.querySelectorAll(s);

const state = {
  unlocked:{ compose:true, voice:false, dj:false },
  result:null, program:0, tempo:120, metroOn:false,
};

/* ---------- gated navigation ---------- */
function gotoStep(step){
  if(!state.unlocked[step]) return;
  $$(".step").forEach(s=>s.classList.toggle("is-active", s.dataset.step===step));
  $$(".stage-panel").forEach(p=>p.classList.toggle("is-active", p.dataset.panel===step));
  if(step==="dj") onEnterDeck();
}
function unlock(step){
  state.unlocked[step]=true;
  const el=[...$$(".step")].find(s=>s.dataset.step===step);
  if(el){ el.classList.remove("is-locked"); el.disabled=false; }
}
$$(".step").forEach(s=>s.addEventListener("click",()=>gotoStep(s.dataset.step)));
$$("[data-go]").forEach(b=>b.addEventListener("click",()=>gotoStep(b.dataset.go)));

/* ---------- line-numbered editor (split only on Enter) ---------- */
const lyricsEl=$("#lyrics"), gutter=$("#gutter");
function refreshGutter(){
  const n=lyricsEl.value.split("\n").length||1;
  gutter.innerHTML=Array.from({length:n},(_,i)=>`<span>${i+1}</span>`).join("");
}
lyricsEl.addEventListener("input",refreshGutter);
lyricsEl.addEventListener("scroll",()=>{ gutter.scrollTop=lyricsEl.scrollTop; });
refreshGutter();

/* ---------- compose ---------- */
const generateBtn=$("#generateBtn"), composeHint=$("#composeHint");
const scoreStage=$("#scoreStage"), stageLabel=$("#stageLabel"), etaEl=$("#eta");
const composeNext=$("#composeNext"), toVoiceBtn=$("#toVoiceBtn");
const vfHost=$("#vfHost"), vfMount=$("#vfMount"), vfReveal=$("#vfReveal"),
      scoreFallback=$("#scoreFallback");

let pollTimer=null, progTimer=null, progStart=0, progDone=false;

generateBtn.addEventListener("click",async()=>{
  const lyrics=lyricsEl.value.trim();
  composeHint.className="hint"; composeHint.textContent="";
  if(!lyrics){ composeHint.className="hint error"; composeHint.textContent="Type at least one line first."; return; }
  const lines=lyrics.split("\n").filter(l=>l.trim());
  resetScoreStage(lines.length);
  scoreStage.hidden=false; composeNext.hidden=true; generateBtn.disabled=true;
  stageLabel.textContent="COMPOSING";
  startFakeProgress();                       // begin the log curve immediately
  try{
    const r=await fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({lyrics})});
    const d=await r.json();
    if(d.error){ stopFakeProgress(); composeHint.className="hint error"; composeHint.textContent=d.error; generateBtn.disabled=false; return; }
    pollProgress(d.job_id);
  }catch(e){ stopFakeProgress(); composeHint.className="hint error"; composeHint.textContent="Server unreachable: "+e; generateBtn.disabled=false; }
});

function resetScoreStage(n){
  vfHost.classList.remove("done","notes-in");
  vfMount.innerHTML=""; scoreFallback.hidden=true; scoreFallback.removeAttribute("src");
  vfReveal.style.width="100%";
  // draw the empty staves now (these are what "draw in" as progress runs)
  drawStaves(n, false);
}

/* ---------- fake logarithmic progress (~10 min target) ----------
   progress eases toward a ceiling and slows as it approaches it (it never
   reaches 100% on its own); when the real job finishes we rush it to 100%. */
const FAKE_TARGET_SECONDS=600;   // ~10 minutes tentative
const FAKE_CEIL=0.93;            // never auto-exceed this until done
function fakeFrac(elapsed){
  // 1 - exp(-t/tau): fast then slowing. tau chosen so ~10 min ~= ceil.
  const tau=FAKE_TARGET_SECONDS/3.0;     // at 3*tau (~10 min) -> ~0.95 of ceil
  return FAKE_CEIL*(1-Math.exp(-elapsed/tau));
}
function startFakeProgress(){
  progStart=performance.now(); progDone=false;
  if(progTimer) clearInterval(progTimer);
  progTimer=setInterval(()=>{
    if(progDone) return;
    const elapsed=(performance.now()-progStart)/1000;
    const frac=fakeFrac(elapsed);
    applyProgress(frac);
    const remain=Math.max(0, FAKE_TARGET_SECONDS-elapsed);
    etaEl.textContent="~"+fmtTime(remain)+" left";
  },120);
}
function stopFakeProgress(){ if(progTimer){ clearInterval(progTimer); progTimer=null; } }
function fmtTime(s){ s=Math.round(s); const m=Math.floor(s/60), ss=s%60; return m>0?`${m}m ${ss}s`:`${ss}s`; }

// progress 0..1 -> reveal the staff left-to-right
function applyProgress(frac){
  frac=Math.max(0,Math.min(1,frac));
  vfReveal.style.width=((1-frac)*100).toFixed(2)+"%";
}

function pollProgress(jobId){
  if(pollTimer) clearInterval(pollTimer);
  pollTimer=setInterval(async()=>{
    let d; try{ d=await(await fetch(`/progress/${jobId}`)).json(); }catch(e){ return; }
    if(d.status==="done"){
      clearInterval(pollTimer); progDone=true; stopFakeProgress();
      rushToDone(()=>{ renderResult(d.result); });
      generateBtn.disabled=false;
    }else if(d.status==="error"){
      clearInterval(pollTimer); progDone=true; stopFakeProgress();
      composeHint.className="hint error"; composeHint.textContent="Failed: "+(d.error||"");
      generateBtn.disabled=false;
    }
  },500);
}

// when the real job lands, quickly finish the bar then run the callback
function rushToDone(cb){
  let f=1-(parseFloat(vfReveal.style.width)||0)/100;   // current fraction
  const step=()=>{
    f+=0.06;
    applyProgress(f);
    if(f<1){ requestAnimationFrame(step); }
    else { vfHost.classList.add("done"); etaEl.textContent="done"; stageLabel.textContent="MELODY READY"; cb(); }
  };
  step();
}

/* ---------- VexFlow notation ----------
   We draw the staves (empty) during loading; the reveal curtain makes them
   appear to draw in. On done we (re)draw with notes, which start hidden and
   fade in (the "notes land on the staff" effect). Falls back to PNG if VexFlow
   isn't available. */
const VF = (window.Vex && window.Vex.Flow) ? window.Vex.Flow : null;
let lastLines=null;

function midiToVexKey(pitch){
  const names=["c","c#","d","d#","e","f","f#","g","g#","a","a#","b"];
  const oct=Math.floor(pitch/12)-1;
  return names[pitch%12]+"/"+oct;
}
function durToVex(beats){
  if(beats>=4) return "w";
  if(beats>=2) return "h";
  if(beats>=1) return "q";
  if(beats>=0.5) return "8";
  return "16";
}

// draw n empty staves (loading) or, if lines given, staves with notes
function drawStaves(n, withNotes){
  if(!VF){ vfMount.innerHTML=""; return; }   // no VexFlow -> rely on fallback
  vfMount.innerHTML="";
  const width=vfMount.clientWidth||1000;
  const perStaff=96, padTop=10;
  const renderer=new VF.Renderer(vfMount, VF.Renderer.Backends.SVG);
  renderer.resize(width, padTop+perStaff*n+24);
  const ctx=renderer.getContext();
  ctx.setFillStyle("#dee2ff"); ctx.setStrokeStyle("#b4bae0");

  const lines = withNotes && lastLines ? lastLines : Array.from({length:n},()=>null);
  lines.forEach((line,i)=>{
    const y=padTop+i*perStaff;
    const stave=new VF.Stave(8, y, width-16);
    if(i===0) stave.addClef("treble").addTimeSignature("4/4");
    stave.setContext(ctx).draw();
    if(withNotes && line && line.notes && line.notes.length){
      try{
        const notes=line.notes.map((nt,j)=>{
          const sn=new VF.StaveNote({clef:"treble", keys:[midiToVexKey(nt.pitch)], duration:durToVex(nt.dur)});
          if([1,3,6,8,10].includes(((nt.pitch%12)+12)%12)){
            sn.addModifier(new VF.Accidental("#"), 0);
          }
          const syl=(line.syllables && line.syllables[j])?line.syllables[j]:"";
          if(syl){
            const an=new VF.Annotation(syl);
            an.setVerticalJustification(VF.Annotation.VerticalJustify.BOTTOM);
            sn.addModifier(an, 0);
          }
          return sn;
        });
        const voice=new VF.Voice({num_beats:4, beat_value:4}).setStrict(false);
        voice.addTickables(notes);
        new VF.Formatter().joinVoices([voice]).format([voice], width-90);
        // wrap the note drawing in an SVG group so we can fade it in via CSS
        const group=ctx.openGroup();
        group.classList.add("vf-notes");
        voice.draw(ctx, stave);
        ctx.closeGroup();
      }catch(e){ /* a phrase that won't format just shows its empty staff */ }
    }
  });
}

function renderResult(result){
  state.result=result;
  lastLines=result.lines;

  if(VF){
    // redraw the staves WITH notes (hidden via CSS), then fade them in
    drawStaves(result.lines.length, true);
    // force reflow then reveal notes
    requestAnimationFrame(()=>{ vfHost.classList.add("notes-in"); });
  }else if(result.score_png){
    // fallback: themed PNG
    const img=new Image(); img.className="score-fallback"; img.alt="";
    img.onload=()=>{ vfMount.innerHTML=""; scoreFallback.replaceWith(img); };
    img.src=`/score/${result.session_id}/${result.score_png}?t=${Date.now()}`;
    scoreFallback.replaceWith(img);
  }

  unlock("voice");
  composeNext.hidden=false;
  const oov=result.lines.reduce((a,l)=>a+l.oov_flags.filter(Boolean).length,0);
  composeHint.className="hint ok";
  composeHint.textContent=oov?`${oov} unknown syllable(s) used a neutral fallback.`:"Composed cleanly.";
}

/* ---------- voice (optional, skippable, multiple files) ---------- */
const drop=$("#drop"), vocalFile=$("#vocalFile"), dropText=$("#dropText"),
      voiceHint=$("#voiceHint"), voiceList=$("#voiceList"),
      toDjBtn=$("#toDjBtn"), skipVoiceBtn=$("#skipVoiceBtn");
drop.addEventListener("click",()=>vocalFile.click());
drop.addEventListener("dragover",e=>{e.preventDefault();drop.classList.add("over");});
drop.addEventListener("dragleave",()=>drop.classList.remove("over"));
drop.addEventListener("drop",e=>{e.preventDefault();drop.classList.remove("over");
  [...e.dataTransfer.files].forEach(uploadVocal);});
vocalFile.addEventListener("change",()=>{[...vocalFile.files].forEach(uploadVocal);});
async function uploadVocal(file){
  dropText.textContent="Uploading "+file.name+"\u2026";
  const fd=new FormData(); fd.append("file",file);
  try{
    const d=await(await fetch("/upload_vocals",{method:"POST",body:fd})).json();
    if(d.error){ voiceHint.className="hint error"; voiceHint.textContent=d.error; }
    else{
      voiceList.innerHTML=d.all.map(f=>`<li>${f}</li>`).join("");
      voiceHint.className="hint ok"; voiceHint.textContent=d.all.length+" track(s) added.";
      dropText.textContent="Drop audio files here, or click to choose";
      refreshTrackPicker(d.all);
    }
  }catch(e){ voiceHint.className="hint error"; voiceHint.textContent="Upload failed: "+e; }
  if(state.result) unlock("dj");
}
// both Skip and Continue just need DJ unlocked (melody exists)
function maybeUnlockDJ(){ if(state.result) unlock("dj"); }

/* ---------- DJ deck (server-rendered audio, no CDN) ---------- */
const djInstrument=$("#djInstrument"), bpm=$("#bpm"), bpmOut=$("#bpmOut"),
      playBtn=$("#playBtn"), stopBtn=$("#stopBtn"),
      metroToggle=$("#metroToggle"), metroVol=$("#metroVol"),
      modePlayback=$("#modePlayback"), modeEdit=$("#modeEdit"),
      playbackView=$("#playbackView"), editView=$("#editView"),
      trackPickWrap=$("#trackPickWrap"), trackPick=$("#trackPick"),
      rollCanvas=$("#rollCanvas"), djHint=$("#djHint");

window.T2T.instruments.forEach(inst=>{
  const o=document.createElement("option"); o.value=inst.p; o.textContent=inst.n;
  djInstrument.appendChild(o);
});

// the <audio> element that plays the server-rendered WAV
const audioEl=new Audio();
audioEl.preload="auto";
let audioReady=false, rendering=false, needRender=true;

async function renderServerAudio(){
  if(!state.result){ return false; }
  if(rendering) return false;
  rendering=true; audioReady=false;
  djHint.className="hint"; djHint.textContent="Rendering audio\u2026";
  try{
    const r=await fetch("/render_wav",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({program:state.program, tempo:state.tempo})});
    const d=await r.json();
    if(!r.ok||d.error){ throw new Error(d.error||"render failed"); }
    await new Promise((res,rej)=>{
      audioEl.src=d.url;
      audioEl.oncanplaythrough=()=>res();
      audioEl.onerror=()=>rej(new Error("audio load failed"));
      audioEl.load();
      setTimeout(res, 4000);                 // don't hang forever
    });
    audioReady=true; needRender=false;
    djHint.className="hint"; djHint.textContent = d.method==="sine"
      ? "Playing a basic synth (soundfont not found on server)." : "";
    return true;
  }catch(e){ djHint.className="hint error"; djHint.textContent="Audio render failed: "+e.message; return false; }
  finally{ rendering=false; }
}

djInstrument.addEventListener("change",async()=>{
  state.program=+djInstrument.value; needRender=true;
  const wasPlaying=!audioEl.paused; stopPlayback();
  await renderServerAudio();
  if(wasPlaying) startPlayback();
});
bpm.addEventListener("input",()=>{ state.tempo=+bpm.value; bpmOut.textContent=state.tempo+" BPM"; needRender=true; });
let bpmDebounce=null;
bpm.addEventListener("change",async()=>{
  const wasPlaying=!audioEl.paused; stopPlayback();
  await renderServerAudio();
  if(wasPlaying) startPlayback();
});
metroToggle.addEventListener("click",()=>{
  state.metroOn=!state.metroOn;
  metroToggle.classList.toggle("on",state.metroOn);
  metroToggle.textContent=state.metroOn?"ON":"OFF";
});

modePlayback.addEventListener("click",()=>setMode("playback"));
modeEdit.addEventListener("click",()=>setMode("edit"));
function setMode(m){
  modePlayback.classList.toggle("is-active",m==="playback");
  modeEdit.classList.toggle("is-active",m==="edit");
  playbackView.hidden=(m!=="playback");
  editView.hidden=(m==="playback");
}

function refreshTrackPicker(vocals){
  trackPick.innerHTML="<option value='melody'>Melody</option>"+
    (vocals||[]).map(f=>`<option value="vocal:${f}">${f}</option>`).join("");
  trackPickWrap.hidden=false;
}

let deckReady=false;
async function onEnterDeck(){
  maybeUnlockDJ();
  bpmOut.textContent=state.tempo+" BPM";
  sizeCanvas(); drawRollStatic();
  if(!deckReady){ deckReady=true; await renderServerAudio(); }
  else if(needRender){ await renderServerAudio(); }
}
window.addEventListener("resize",()=>{ if(deckReady){ sizeCanvas(); if(audioEl.paused) drawRollStatic(); }});

/* ----- falling-note piano roll synced to the <audio> element ----- */
const cx=()=>rollCanvas.getContext("2d");
const MIN_PITCH=21, MAX_PITCH=108, LOOKAHEAD=2.5;
let rafId=null;

function sizeCanvas(){
  const dpr=window.devicePixelRatio||1;
  const w=rollCanvas.clientWidth, h=rollCanvas.clientHeight;
  rollCanvas.width=w*dpr; rollCanvas.height=h*dpr;
  cx().setTransform(dpr,0,0,dpr,0,0);
}
function pitchToX(p,w){ return ((p-MIN_PITCH)/(MAX_PITCH-MIN_PITCH))*w; }
function drawRollStatic(){
  const c=cx(), w=rollCanvas.clientWidth, h=rollCanvas.clientHeight;
  c.clearRect(0,0,w,h);
  c.strokeStyle="rgba(120,130,170,0.10)"; c.lineWidth=1;
  for(let p=MIN_PITCH;p<=MAX_PITCH;p++){ if(p%12===0){ const x=pitchToX(p,w); c.beginPath(); c.moveTo(x,0); c.lineTo(x,h); c.stroke(); } }
  for(let i=0;i<6;i++){ const y=h*i/6; c.beginPath(); c.moveTo(0,y); c.lineTo(w,y); c.stroke(); }
  if(!state.result){ c.fillStyle="rgba(154,162,189,0.5)"; c.font="16px 'Chivo Mono', monospace";
    c.textAlign="center"; c.fillText("Compose a melody to see it play here.",w/2,h/2); }
}

function scaledNotes(){
  // base notes are at tempo 120; the server WAV is rendered at state.tempo,
  // so audioEl.currentTime maps to note times scaled by 120/tempo.
  const ratio=120/state.tempo;
  return (state.result?state.result.flat_notes:[]).map(n=>({
    pitch:n.pitch, start:n.start*ratio, dur:Math.max(0.05,n.dur*ratio),
  }));
}

function startPlayback(){
  if(!state.result){ djHint.className="hint error"; djHint.textContent="Compose a melody first."; return; }
  if(!audioReady){ renderServerAudio().then(ok=>{ if(ok) startPlayback(); }); return; }
  audioEl.currentTime=0; audioEl.play();
  playBtn.innerHTML="&#10073;&#10073;";
  startMetro();
  loopRoll();
}
function stopPlayback(){
  audioEl.pause(); audioEl.currentTime=0;
  playBtn.innerHTML="&#9654;";
  if(rafId) cancelAnimationFrame(rafId);
  stopMetro();
  drawRollStatic();
}
audioEl.addEventListener("ended",()=>{ stopPlayback(); });
playBtn.addEventListener("click",()=>{ if(audioEl.paused) startPlayback(); else stopPlayback(); });
stopBtn.addEventListener("click",stopPlayback);

function loopRoll(){
  const c=cx(), w=rollCanvas.clientWidth, h=rollCanvas.clientHeight;
  const now=audioEl.currentTime;
  c.clearRect(0,0,w,h); drawRollStatic();
  scaledNotes().forEach(n=>{
    const tTo=n.start-now;
    if(tTo>LOOKAHEAD||tTo< -n.dur) return;
    const x=pitchToX(n.pitch,w);
    const noteW=Math.max(8,w/(MAX_PITCH-MIN_PITCH)-2);
    const y=h-(tTo/LOOKAHEAD)*h;
    const noteH=Math.max(10,(n.dur/LOOKAHEAD)*h);
    const grad=c.createLinearGradient(0,y-noteH,0,y);
    grad.addColorStop(0,"#4456f8"); grad.addColorStop(1,"#8f38e8");
    c.fillStyle=grad; c.shadowColor="rgba(143,56,232,0.6)"; c.shadowBlur=12;
    roundRect(c,x-noteW/2,y-noteH,noteW,noteH,3); c.fill(); c.shadowBlur=0;
  });
  if(!audioEl.paused) rafId=requestAnimationFrame(loopRoll);
}
function roundRect(c,x,y,w,h,r){ c.beginPath(); c.moveTo(x+r,y);
  c.arcTo(x+w,y,x+w,y+h,r); c.arcTo(x+w,y+h,x,y+h,r);
  c.arcTo(x,y+h,x,y,r); c.arcTo(x,y,x+w,y,r); c.closePath(); }

/* ----- metronome (Web Audio clicks synced to the audio element) ----- */
let metroCtx=null, metroTimer=null, metroNextBeat=0, metroBeatIdx=0;
function startMetro(){
  if(!state.metroOn) return;
  if(!metroCtx) metroCtx=new (window.AudioContext||window.webkitAudioContext)();
  if(metroCtx.state==="suspended") metroCtx.resume();
  metroBeatIdx=0; metroNextBeat=metroCtx.currentTime+0.05;
  const beat=60/state.tempo;
  if(metroTimer) clearInterval(metroTimer);
  metroTimer=setInterval(()=>{
    if(audioEl.paused){ return; }
    const ahead=metroCtx.currentTime+0.2;
    while(metroNextBeat<ahead){
      click(metroNextBeat, metroBeatIdx%4===0);
      metroNextBeat+=beat; metroBeatIdx++;
    }
  },40);
}
function stopMetro(){ if(metroTimer){ clearInterval(metroTimer); metroTimer=null; } }
function click(at, accent){
  const o=metroCtx.createOscillator(), g=metroCtx.createGain();
  o.frequency.value=accent?1600:1000;
  const vol=(+metroVol.value)/100*0.5*(accent?1.25:1);
  g.gain.setValueAtTime(vol, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at+0.05);
  o.connect(g); g.connect(metroCtx.destination);
  o.start(at); o.stop(at+0.06);
}

/* ----- downloads (re-render server-side with current program+tempo) ----- */
function wireDownload(el,kind){
  el.addEventListener("click",async()=>{
    if(!state.result){ djHint.className="hint error"; djHint.textContent="Compose a melody first."; return; }
    el.classList.add("busy"); const orig=el.textContent; el.textContent="\u2026";
    try{
      const url=`/download/${kind}?program=${state.program}&tempo=${state.tempo}`;
      const r=await fetch(url);
      if(!r.ok){ throw new Error(await r.text()); }
      const blob=await r.blob();
      const a=document.createElement("a");
      a.href=URL.createObjectURL(blob);
      a.download="text_to_tune."+(kind==="xml"?"musicxml":kind);
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(a.href);
      djHint.className="hint ok"; djHint.textContent=kind.toUpperCase()+" downloaded.";
    }catch(e){ djHint.className="hint error"; djHint.textContent="Download failed: "+e.message; }
    el.classList.remove("busy"); el.textContent=orig;
  });
}
wireDownload($("#dlMidi"),"midi");
wireDownload($("#dlXml"),"xml");
wireDownload($("#dlWav"),"wav");
