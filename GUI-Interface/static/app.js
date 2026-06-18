/* ============================================================
   TEXT-TO-TUNE  frontend
   - gated steps (Compose -> Voice -> DJ); Voice skippable
   - fake logarithmic progress (~10 min); lightweight staff "draws in",
     then detailed OSMD notation (from the MusicXML) appears
   - DJ deck: server-rendered WAV playback (real FluidR3_GM.sf2, no CDN),
     separate sliders for song tempo/vol + metronome tempo/vol (independent)
   ============================================================ */
document.documentElement.style.setProperty("--bg-image", `url("${window.T2T.bgUrl}")`);

const $  = (s)=>document.querySelector(s);
const $$ = (s)=>document.querySelectorAll(s);

const state = {
  unlocked:{ compose:true, voice:false, dj:false },
  result:null, program:0, tempo:120, metroOn:false, metroTempo:120,
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
const composeNext=$("#composeNext");
const scoreHost=$("#scoreHost"), loadStaves=$("#loadStaves"), osmdMount=$("#osmdMount");

let pollTimer=null, progTimer=null, progStart=0, progDone=false;

generateBtn.addEventListener("click",async()=>{
  const lyrics=lyricsEl.value.trim();
  composeHint.className="hint"; composeHint.textContent="";
  if(!lyrics){ composeHint.className="hint error"; composeHint.textContent="Type at least one line first."; return; }
  const lines=lyrics.split("\n").filter(l=>l.trim());
  resetScoreStage(lines.length);
  scoreStage.hidden=false; composeNext.hidden=true; generateBtn.disabled=true;
  stageLabel.textContent="COMPOSING";
  startFakeProgress();
  try{
    const r=await fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({lyrics})});
    const d=await r.json();
    if(d.error){ stopFakeProgress(); composeHint.className="hint error"; composeHint.textContent=d.error; generateBtn.disabled=false; return; }
    pollProgress(d.job_id);
  }catch(e){ stopFakeProgress(); composeHint.className="hint error"; composeHint.textContent="Server unreachable: "+e; generateBtn.disabled=false; }
});

function resetScoreStage(n){
  scoreHost.classList.remove("done");
  osmdMount.innerHTML=""; osmdMount.style.display="none";
  loadStaves.style.display="";
  buildLoadStaves(n);
  applyProgress(0);
}

// lightweight 5-line staves drawn with divs; these are what "draw in"
function buildLoadStaves(n){
  loadStaves.innerHTML="";
  for(let i=0;i<n;i++){
    const st=document.createElement("div"); st.className="lstaff";
    st.innerHTML="<i></i><i></i><i></i><i></i><i></i>";
    loadStaves.appendChild(st);
  }
}

/* ---------- fake logarithmic progress (~10 min) ---------- */
const FAKE_TARGET_SECONDS=600, FAKE_CEIL=0.93;
function fakeFrac(elapsed){ const tau=FAKE_TARGET_SECONDS/3.0; return FAKE_CEIL*(1-Math.exp(-elapsed/tau)); }
function startFakeProgress(){
  progStart=performance.now(); progDone=false;
  if(progTimer) clearInterval(progTimer);
  progTimer=setInterval(()=>{ if(progDone) return;
    applyProgress(fakeFrac((performance.now()-progStart)/1000)); },120);
}
function stopFakeProgress(){ if(progTimer){ clearInterval(progTimer); progTimer=null; } }

// progress 0..1 -> reveal the loading staff left-to-right via clip-path
function applyProgress(frac){
  frac=Math.max(0,Math.min(1,frac));
  const rightInset=((1-frac)*100).toFixed(2)+"%";
  loadStaves.style.setProperty("--reveal-right", rightInset);
  loadStaves.style.setProperty("--reveal-edge", (frac*100).toFixed(2)+"%");
}

function pollProgress(jobId){
  if(pollTimer) clearInterval(pollTimer);
  pollTimer=setInterval(async()=>{
    let d; try{ d=await(await fetch(`/progress/${jobId}`)).json(); }catch(e){ return; }
    if(d.status==="done"){
      clearInterval(pollTimer); progDone=true; stopFakeProgress();
      rushToDone(()=>renderResult(d.result));
      generateBtn.disabled=false;
    }else if(d.status==="error"){
      clearInterval(pollTimer); progDone=true; stopFakeProgress();
      composeHint.className="hint error"; composeHint.textContent="Failed: "+(d.error||"");
      generateBtn.disabled=false;
    }
  },500);
}

// finish the bar quickly, then run callback
function rushToDone(cb){
  let f=1-(parseFloat(loadStaves.style.getPropertyValue("--reveal-right"))||0)/100;
  const step=()=>{ f+=0.06; applyProgress(f);
    if(f<1){ requestAnimationFrame(step); }
    else { scoreHost.classList.add("done"); stageLabel.textContent="MELODY READY"; etaEl.textContent=""; cb(); } };
  step();
}

/* ---------- OSMD notation (detailed, from the MusicXML) ---------- */
const OSMD = window.opensheetmusicdisplay ? window.opensheetmusicdisplay.OpenSheetMusicDisplay : null;
let osmd=null;

async function renderResult(result){
  state.result=result;
  unlock("voice"); unlock("dj");          // Voice optional -> DJ available now
  composeNext.hidden=false;
  composeHint.className="hint"; composeHint.textContent="";   // no syllable/clean message

  if(OSMD && result.has_xml){
    try{
      const xml=await (await fetch("/musicxml_raw?t="+Date.now())).text();
      // hide loading staves, show OSMD mount
      loadStaves.style.display="none"; osmdMount.style.display="";
      osmdMount.innerHTML="";
      osmd=new OSMD(osmdMount,{
        backend:"svg", autoResize:true,
        drawTitle:false, drawSubtitle:false, drawComposer:false, drawCredits:false,
        drawingParameters:"default",
      });
      // light notes on the dark UI, but keep the background TRANSPARENT
      // (don't use darkMode:true, which paints a solid black page background).
      try{
        osmd.setOptions({defaultColorMusic:"#dee2ff"});
        osmd.EngravingRules.PageBackgroundColor = "";   // transparent
        osmd.EngravingRules.StaffLineWidth = 0.16;       // a touch heavier for readability
      }catch(e){}
      await osmd.load(xml);
      osmd.render();
      osmdMount.classList.add("fade-in");
      return;
    }catch(e){ /* fall through to keeping the loading staves visible */ }
  }
  // fallback if OSMD unavailable: leave the drawn-in staves as-is (better than blank)
}

/* ---------- voice (optional, skippable, multiple files) ---------- */
const drop=$("#drop"), vocalFile=$("#vocalFile"), dropText=$("#dropText"),
      voiceHint=$("#voiceHint"), voiceList=$("#voiceList");
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
}

/* ---------- DJ deck ---------- */
const djInstrument=$("#djInstrument"),
      bpm=$("#bpm"), bpmOut=$("#bpmOut"),
      songVol=$("#songVol"), songVolOut=$("#songVolOut"),
      metroBpm=$("#metroBpm"), metroBpmOut=$("#metroBpmOut"),
      metroVol=$("#metroVol"), metroVolOut=$("#metroVolOut"),
      playBtn=$("#playBtn"), stopBtn=$("#stopBtn"),
      metroToggle=$("#metroToggle"),
      modePlayback=$("#modePlayback"), modeEdit=$("#modeEdit"),
      playbackView=$("#playbackView"), editView=$("#editView"),
      trackPickWrap=$("#trackPickWrap"), trackPick=$("#trackPick"),
      rollCanvas=$("#rollCanvas"), djHint=$("#djHint");

window.T2T.instruments.forEach(inst=>{
  const o=document.createElement("option"); o.value=inst.p; o.textContent=inst.n;
  djInstrument.appendChild(o);
});

const audioEl=new Audio();
audioEl.preload="auto"; audioEl.volume=0.9;
let audioReady=false, rendering=false, needRender=true;

async function renderServerAudio(){
  if(!state.result) return false;
  if(rendering) return false;
  rendering=true; audioReady=false;
  djHint.className="hint"; djHint.textContent="Rendering audio\u2026";
  try{
    const r=await fetch("/render_wav",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({program:state.program, tempo:state.tempo})});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||"render failed");
    await new Promise((res,rej)=>{
      audioEl.src=d.url; audioEl.oncanplaythrough=()=>res(); audioEl.onerror=()=>rej(new Error("audio load failed"));
      audioEl.load(); setTimeout(res,4000);
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
  const was=!audioEl.paused; stopPlayback(); await renderServerAudio(); if(was) startPlayback();
});

// SONG tempo (re-renders the WAV)
bpm.addEventListener("input",()=>{ state.tempo=+bpm.value; bpmOut.textContent=state.tempo; needRender=true; });
bpm.addEventListener("change",async()=>{ const was=!audioEl.paused; stopPlayback(); await renderServerAudio(); if(was) startPlayback(); });
// SONG volume (instant, no re-render)
songVol.addEventListener("input",()=>{ songVolOut.textContent=songVol.value; audioEl.volume=(+songVol.value)/100; });
// METRONOME tempo (independent; browser clicks, no re-render)
metroBpm.addEventListener("input",()=>{ state.metroTempo=+metroBpm.value; metroBpmOut.textContent=state.metroTempo;
  if(state.metroOn && !audioEl.paused){ stopMetro(); startMetro(); } });
// METRONOME volume
metroVol.addEventListener("input",()=>{ metroVolOut.textContent=metroVol.value; });
// METRONOME on/off
metroToggle.addEventListener("click",()=>{
  state.metroOn=!state.metroOn;
  metroToggle.classList.toggle("on",state.metroOn);
  metroToggle.textContent=state.metroOn?"ON":"OFF";
  if(!audioEl.paused){ state.metroOn?startMetro():stopMetro(); }
});

modePlayback.addEventListener("click",()=>setMode("playback"));
modeEdit.addEventListener("click",()=>setMode("edit"));
function setMode(m){
  modePlayback.classList.toggle("is-active",m==="playback");
  modeEdit.classList.toggle("is-active",m==="edit");
  playbackView.hidden=(m!=="playback"); editView.hidden=(m==="playback");
}
function refreshTrackPicker(vocals){
  trackPick.innerHTML="<option value='melody'>Melody</option>"+
    (vocals||[]).map(f=>`<option value="vocal:${f}">${f}</option>`).join("");
  trackPickWrap.hidden=false;
}

let deckReady=false;
async function onEnterDeck(){
  if(state.result) unlock("dj");
  bpmOut.textContent=state.tempo; metroBpmOut.textContent=state.metroTempo;
  songVolOut.textContent=songVol.value; metroVolOut.textContent=metroVol.value;
  sizeCanvas(); drawRollStatic();
  if(!deckReady){ deckReady=true; await renderServerAudio(); }
  else if(needRender){ await renderServerAudio(); }
}
window.addEventListener("resize",()=>{ if(deckReady){ sizeCanvas(); if(audioEl.paused) drawRollStatic(); }});

/* ----- falling-note roll synced to the <audio> element ----- */
const cx=()=>rollCanvas.getContext("2d");
const MIN_PITCH=21, MAX_PITCH=108, LOOKAHEAD=2.5;
let rafId=null;
function sizeCanvas(){
  const dpr=window.devicePixelRatio||1, w=rollCanvas.clientWidth, h=rollCanvas.clientHeight;
  rollCanvas.width=w*dpr; rollCanvas.height=h*dpr; cx().setTransform(dpr,0,0,dpr,0,0);
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
  const ratio=120/state.tempo;
  return (state.result?state.result.flat_notes:[]).map(n=>({pitch:n.pitch,start:n.start*ratio,dur:Math.max(0.05,n.dur*ratio)}));
}
function startPlayback(){
  if(!state.result){ djHint.className="hint error"; djHint.textContent="Compose a melody first."; return; }
  if(!audioReady){ renderServerAudio().then(ok=>{ if(ok) startPlayback(); }); return; }
  audioEl.currentTime=0; audioEl.play();
  playBtn.innerHTML="&#10073;&#10073;";
  if(state.metroOn) startMetro();
  loopRoll();
}
function stopPlayback(){
  audioEl.pause(); audioEl.currentTime=0; playBtn.innerHTML="&#9654;";
  if(rafId) cancelAnimationFrame(rafId);
  stopMetro(); drawRollStatic();
}
audioEl.addEventListener("ended",stopPlayback);
playBtn.addEventListener("click",()=>{ if(audioEl.paused) startPlayback(); else stopPlayback(); });
stopBtn.addEventListener("click",stopPlayback);
function loopRoll(){
  const c=cx(), w=rollCanvas.clientWidth, h=rollCanvas.clientHeight;
  const now=audioEl.currentTime;
  c.clearRect(0,0,w,h); drawRollStatic();
  scaledNotes().forEach(n=>{
    const tTo=n.start-now;
    if(tTo>LOOKAHEAD||tTo< -n.dur) return;
    const x=pitchToX(n.pitch,w), noteW=Math.max(8,w/(MAX_PITCH-MIN_PITCH)-2);
    const y=h-(tTo/LOOKAHEAD)*h, noteH=Math.max(10,(n.dur/LOOKAHEAD)*h);
    const grad=c.createLinearGradient(0,y-noteH,0,y);
    grad.addColorStop(0,"#4456f8"); grad.addColorStop(1,"#8f38e8");
    c.fillStyle=grad; c.shadowColor="rgba(143,56,232,0.6)"; c.shadowBlur=12;
    roundRect(c,x-noteW/2,y-noteH,noteW,noteH,3); c.fill(); c.shadowBlur=0;
  });
  if(!audioEl.paused) rafId=requestAnimationFrame(loopRoll);
}
function roundRect(c,x,y,w,h,r){ c.beginPath(); c.moveTo(x+r,y);
  c.arcTo(x+w,y,x+w,y+h,r); c.arcTo(x+w,y+h,x,y+h,r); c.arcTo(x,y+h,x,y,r); c.arcTo(x,y,x+w,y,r); c.closePath(); }

/* ----- metronome: independent tempo, Web Audio clicks during playback ----- */
let metroCtx=null, metroTimer=null, metroNext=0, metroIdx=0;
function startMetro(){
  if(!state.metroOn) return;
  if(!metroCtx) metroCtx=new (window.AudioContext||window.webkitAudioContext)();
  if(metroCtx.state==="suspended") metroCtx.resume();
  metroIdx=0; metroNext=metroCtx.currentTime+0.05;
  if(metroTimer) clearInterval(metroTimer);
  metroTimer=setInterval(()=>{
    if(audioEl.paused) return;
    const beat=60/state.metroTempo, ahead=metroCtx.currentTime+0.2;
    while(metroNext<ahead){ click(metroNext, metroIdx%4===0); metroNext+=beat; metroIdx++; }
  },40);
}
function stopMetro(){ if(metroTimer){ clearInterval(metroTimer); metroTimer=null; } }
function click(at,accent){
  const o=metroCtx.createOscillator(), g=metroCtx.createGain();
  o.frequency.value=accent?1600:1000;
  const vol=(+metroVol.value)/100*0.5*(accent?1.25:1);
  g.gain.setValueAtTime(vol,at); g.gain.exponentialRampToValueAtTime(0.0001,at+0.05);
  o.connect(g); g.connect(metroCtx.destination); o.start(at); o.stop(at+0.06);
}

/* ----- downloads (re-render server-side; include metronome if toggled) ----- */
function metroQuery(){
  return `&metro=${state.metroOn?1:0}&metro_tempo=${state.metroTempo}&metro_vol=${metroVol.value}`;
}
function wireDownload(el,kind){
  el.addEventListener("click",async()=>{
    if(!state.result){ djHint.className="hint error"; djHint.textContent="Compose a melody first."; return; }
    el.classList.add("busy"); const orig=el.textContent; el.textContent="\u2026";
    try{
      const url=`/download/${kind}?program=${state.program}&tempo=${state.tempo}`+(kind==="xml"?"":metroQuery());
      const r=await fetch(url);
      if(!r.ok) throw new Error(await r.text());
      const blob=await r.blob();
      const a=document.createElement("a");
      a.href=URL.createObjectURL(blob);
      a.download="text_to_tune."+(kind==="xml"?"musicxml":kind);
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
      djHint.className="hint ok"; djHint.textContent=kind.toUpperCase()+" downloaded"+(state.metroOn&&kind!=="xml"?" (with metronome).":".");
    }catch(e){ djHint.className="hint error"; djHint.textContent="Download failed: "+e.message; }
    el.classList.remove("busy"); el.textContent=orig;
  });
}
wireDownload($("#dlMidi"),"midi");
wireDownload($("#dlXml"),"xml");
wireDownload($("#dlWav"),"wav");
