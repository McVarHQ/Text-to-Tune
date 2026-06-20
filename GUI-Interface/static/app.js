/* ============================================================
   TEXT-TO-TUNE  frontend
   - gated steps (Compose -> Voice -> DJ); Voice skippable
   - fake log progress; blank staves draw in, then a RIGHT->LEFT wipe
     develops the real OSMD notation in place (the "coin trick")
   - DJ deck: server-rendered WAV playback; full media controls;
     scrollable + zoomable time-axis piano roll
   ============================================================ */
document.documentElement.style.setProperty("--bg-image", `url("${window.T2T.bgUrl}")`);

const $  = (s)=>document.querySelector(s);
const $$ = (s)=>document.querySelectorAll(s);
const fmt=(t)=>{ if(!isFinite(t)||t<0)t=0; const m=Math.floor(t/60),s=Math.floor(t%60); return m+":"+String(s).padStart(2,"0"); };

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

/* ---------- editor gutter (split only on Enter) ---------- */
const lyricsEl=$("#lyrics"), gutter=$("#gutter");
function refreshGutter(){ const n=lyricsEl.value.split("\n").length||1;
  gutter.innerHTML=Array.from({length:n},(_,i)=>`<span>${i+1}</span>`).join(""); }
lyricsEl.addEventListener("input",refreshGutter);
lyricsEl.addEventListener("scroll",()=>{ gutter.scrollTop=lyricsEl.scrollTop; });
refreshGutter();

/* ---------- compose ---------- */
const generateBtn=$("#generateBtn"), composeHint=$("#composeHint");
const scoreStage=$("#scoreStage"), stageLabel=$("#stageLabel"), etaEl=$("#eta");
const composeNext=$("#composeNext");
const scoreHost=$("#scoreHost"), loadStaves=$("#loadStaves"), osmdMount=$("#osmdMount"), wipeEdge=$("#wipeEdge"), osmdBg=$("#osmdBg");
const expandScore=$("#expandScore"), scoreModal=$("#scoreModal"), scoreModalBody=$("#scoreModalBody"), closeScore=$("#closeScore");

let pollTimer=null, progTimer=null, progStart=0, progDone=false;

generateBtn.addEventListener("click",async()=>{
  const lyrics=lyricsEl.value.trim();
  composeHint.className="hint"; composeHint.textContent="";
  if(!lyrics){ composeHint.className="hint error"; composeHint.textContent="Type at least one line first."; return; }
  const lines=lyrics.split("\n").filter(l=>l.trim());
  scoreStage.hidden=false; composeNext.hidden=true; generateBtn.disabled=true;
  stageLabel.textContent="COMPOSING";
  resetScoreStage(lines.length);     // renders the empty OSMD staff (needs the panel visible for width)
  startFakeProgress();
  try{
    const r=await fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({lyrics})});
    const d=await r.json();
    if(d.error){ stopFakeProgress(); composeHint.className="hint error"; composeHint.textContent=d.error; generateBtn.disabled=false; return; }
    pollProgress(d.job_id);
  }catch(e){ stopFakeProgress(); composeHint.className="hint error"; composeHint.textContent="Server unreachable: "+e; generateBtn.disabled=false; }
});

function resetScoreStage(n){
  scoreHost.classList.remove("done","wiping");
  scoreHost.style.minHeight="";
  osmdMount.innerHTML=""; osmdMount.style.removeProperty("--wipe-left");
  osmdBg.innerHTML=""; osmdBg.hidden=true;
  loadStaves.style.display=""; loadStaves.style.opacity="1"; loadStaves.style.minHeight="";
  expandScore.hidden=true;
  renderLoadingStaff(n);             // real OSMD empty staff (loading bar)
  applyProgress(0);
  wipeEdge.style.left="100%";
}
/* ---- LOADING BAR = a REAL OSMD staff with N empty systems (no notes) ----
   Rendered the instant Compose is pressed, with the SAME OSMD options as the
   final score, then revealed logarithmically while the model runs. Because it's
   real OSMD, the staff looks identical to the finished sheet. */
let loadOsmd=null;

function buildEmptyXML(n){
  n=Math.max(1, n|0);
  // same ♩=120 tempo mark the engine writes, so the first staff sits at the same height
  const tempo='<direction placement="above"><direction-type>'
    +'<metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome>'
    +'</direction-type><sound tempo="120"/></direction>';
  let m="";
  for(let i=1;i<=n;i++){
    const brk = i>1 ? '<print new-system="yes"/>' : '';
    const attr = i===1
      ? '<attributes><divisions>1</divisions><key><fifths>0</fifths></key>'
       +'<time><beats>4</beats><beat-type>4</beat-type></time>'
       +'<clef><sign>G</sign><line>2</line></clef></attributes>' : '';
    const tmp = i===1 ? tempo : '';
    // a whole note + a lyric per system: rendered transparent, but reserves the SAME
    // note + lyric-line vertical space as the final score, so the rows line up
    m += `<measure number="${i}">${brk}${attr}${tmp}`
       + `<note><pitch><step>B</step><octave>4</octave></pitch><duration>4</duration><type>whole</type>`
       + `<lyric number="1"><syllabic>single</syllabic><text>o</text></lyric></note>`
       + `</measure>`;
  }
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" '
    + '"http://www.musicxml.org/dtds/partwise.dtd">'
    + '<score-partwise version="3.1"><part-list><score-part id="P1"><part-name></part-name>'
    + '</score-part></part-list><part id="P1">'+m+'</part></score-partwise>';
}

async function renderLoadingStaff(n){
  const base=loadStaves.querySelector(".load-base");
  const bright=loadStaves.querySelector(".load-bright");
  if(!OSMD || !base || !bright){ buildLoadStavesFallback(n); return; }
  base.innerHTML=""; bright.innerHTML="";
  loadStaves.style.minHeight=(n*74+36)+"px";              // reserve height so it shows instantly
  try{
    loadOsmd=new OSMD(bright,{
      backend:"svg", autoResize:true,
      drawTitle:false, drawSubtitle:false, drawComposer:false, drawCredits:false,
      drawPartNames:false, drawPartAbbreviations:false,
      newSystemFromXML:true, stretchLastSystemLine:true,
      drawingParameters:"compacttight",
    });
    try{ loadOsmd.setOptions({defaultColorMusic:"#00000000"});     // notes/clef/timesig invisible
      loadOsmd.EngravingRules.PageBackgroundColor="";
      loadOsmd.EngravingRules.StaffLineColor="#141019";            // staff lines visible (independent of music color)
      loadOsmd.EngravingRules.StaffLineWidth=0.14;
      loadOsmd.EngravingRules.RenderMultipleRestMeasures=false;
    }catch(e){}
    await loadOsmd.load(buildEmptyXML(n));
    loadOsmd.zoom=0.95;
    loadOsmd.render();
    hideTextGlyphs(bright);                                 // hide painted lyric/tempo text; KEEP the space it reserved
    const svg=bright.querySelector("svg");
    if(svg){
      const h=svg.getBoundingClientRect().height;
      if(h>8) loadStaves.style.minHeight=(h+40)+"px";
      base.appendChild(svg.cloneNode(true));               // clone (inherits the hidden text)
    }
  }catch(e){ buildLoadStavesFallback(n); }
}

// Hide the rendered text glyphs (lyrics, tempo, measure numbers) WITHOUT removing the
// vertical space they reserved during layout. This is the key difference from coloring
// lyrics transparent, which OSMD optimizes away (space and all).
function hideTextGlyphs(container){
  try{ container.querySelectorAll("svg text").forEach(t=>{ t.style.visibility="hidden"; }); }catch(e){}
}

// fallback only if OSMD failed to load from the CDN: plain CSS staff lines
function buildLoadStavesFallback(n){
  const base=loadStaves.querySelector(".load-base");
  const bright=loadStaves.querySelector(".load-bright");
  if(base) base.innerHTML="";
  const host=bright||loadStaves; host.innerHTML="";
  loadStaves.style.minHeight="";
  for(let i=0;i<n;i++){ const st=document.createElement("div"); st.className="lstaff";
    st.innerHTML="<i></i><i></i><i></i><i></i><i></i>"; host.appendChild(st); }
}

/* fake logarithmic progress (~10 min) */
const FAKE_TARGET_SECONDS=600, FAKE_CEIL=0.93;
function fakeFrac(e){ const tau=FAKE_TARGET_SECONDS/3.0; return FAKE_CEIL*(1-Math.exp(-e/tau)); }
function startFakeProgress(){ progStart=performance.now(); progDone=false;
  if(progTimer) clearInterval(progTimer);
  progTimer=setInterval(()=>{ if(progDone) return; applyProgress(fakeFrac((performance.now()-progStart)/1000)); },120); }
function stopFakeProgress(){ if(progTimer){ clearInterval(progTimer); progTimer=null; } }
// loading reveal: blank staves draw in L->R
function applyProgress(frac){ frac=Math.max(0,Math.min(1,frac));
  loadStaves.style.setProperty("--reveal-right", ((1-frac)*100).toFixed(2)+"%");
  loadStaves.style.setProperty("--reveal-edge", (frac*100).toFixed(2)+"%"); }

function pollProgress(jobId){
  if(pollTimer) clearInterval(pollTimer);
  pollTimer=setInterval(async()=>{
    let d; try{ d=await(await fetch(`/progress/${jobId}`)).json(); }catch(e){ return; }
    if(d.status==="done"){ clearInterval(pollTimer); progDone=true; stopFakeProgress();
      // set result FIRST so OSMD (and the deck) have the data, then animate
      renderResult(d.result);
      finishLoadingThenWipe(prepareOsmd);
      generateBtn.disabled=false;
    }else if(d.status==="error"){ clearInterval(pollTimer); progDone=true; stopFakeProgress();
      composeHint.className="hint error"; composeHint.textContent="Failed: "+(d.error||""); generateBtn.disabled=false; }
  },500);
}

// 1) finish the blank-staff draw-in, 2) render OSMD hidden, 3) wipe R->L to reveal it
function finishLoadingThenWipe(prepOsmd){
  let f=1-(parseFloat(loadStaves.style.getPropertyValue("--reveal-right"))||0)/100;
  const fill=()=>{ f+=0.06; applyProgress(f);
    if(f<1){ requestAnimationFrame(fill); }
    else { stageLabel.textContent="MELODY READY"; etaEl.textContent="";
      // render OSMD now (hidden behind the wipe), crossfade the background, then sweep
      prepOsmd().then(()=>setTimeout(startWipe,380)).catch(()=>startWipe()); } };
  fill();
}

// the coin trick: sweep a glowing edge from RIGHT to LEFT; behind it the OSMD
// notation is revealed (clip opens from the right), replacing the blank staves.
function startWipe(){
  scoreHost.classList.add("wiping");
  loadStaves.style.display="none";              // background (osmdBg) has faded in over it
  let left=100;                                  // start fully clipped (hidden)
  osmdMount.style.setProperty("--wipe-left", left+"%");
  wipeEdge.style.left=left+"%";
  const sweep=()=>{
    left-=2.2;
    if(left<=0){ left=0;
      osmdMount.style.setProperty("--wipe-left","0%"); wipeEdge.style.left="0%";
      scoreHost.classList.remove("wiping"); scoreHost.classList.add("done");
      scoreHost.style.minHeight="";              // let .done max-height + scroll take over
      loadStaves.style.display="none";           // loading staff no longer needed
      osmdBg.hidden=true;                         // notes now have their own staff lines
      expandScore.hidden=false;                  // allow full-screen view
      return;
    }
    osmdMount.style.setProperty("--wipe-left", left+"%");
    wipeEdge.style.left=left+"%";
    requestAnimationFrame(sweep);
  };
  requestAnimationFrame(sweep);
}

/* ---------- OSMD: detailed BLACK notation from the MusicXML ---------- */
const OSMD = window.opensheetmusicdisplay ? window.opensheetmusicdisplay.OpenSheetMusicDisplay : null;
let osmd=null, lastXml=null, osmdModal=null;

async function prepareOsmd(){
  if(!(OSMD && state.result && state.result.has_xml)) return Promise.reject();
  const xml=await (await fetch("/musicxml_raw?t="+Date.now())).text();
  lastXml=xml;
  osmdMount.innerHTML="";
  osmd=new OSMD(osmdMount,{
    backend:"svg", autoResize:true,
    drawTitle:false, drawSubtitle:false, drawComposer:false, drawCredits:false,
    drawPartNames:false, drawPartAbbreviations:false,     // kill "Instr. <hash>"
    newSystemFromXML:true,                                // one system per phrase (we mark breaks)
    stretchLastSystemLine:true,                           // #2: justify the LAST line to full width too
    drawingParameters:"compacttight",                     // tighter so more fits the box
  });
  try{
    osmd.setOptions({defaultColorMusic:"#141019"});       // BLACK notes on the light panel
    osmd.EngravingRules.PageBackgroundColor="";           // transparent
    osmd.EngravingRules.StaffLineWidth=0.14;
  }catch(e){}
  await osmd.load(xml);
  osmd.zoom=0.95;                                          // #4: bigger/taller notes (fills same width)
  osmd.render();
  await renderStaffOnlyBackground(xml);                    // blank staff = SAME xml, notes/lyrics transparent
  // crossfade: the exact staff lines (osmdBg, z1) fade in over the loading staff (z0),
  // so the rows settle smoothly instead of snapping to a different layout
  osmdBg.style.opacity="0";
  requestAnimationFrame(()=>{ osmdBg.style.opacity="1"; });
  sizeScoreToNotation();
}

// GUARANTEED alignment: render the SAME MusicXML again, but with notes + lyrics
// transparent and only the staff lines visible. Identical XML -> identical layout
// (tempo line, lyric spacing, stem heights all match), so the notes reveal over a
// blank staff that lines up exactly.
let osmdBgInst=null;
async function renderStaffOnlyBackground(xml){
  if(!OSMD){ osmdBg.hidden=true; return; }
  osmdBg.innerHTML=""; osmdBg.hidden=false;
  try{
    osmdBgInst=new OSMD(osmdBg,{
      backend:"svg", autoResize:true,
      drawTitle:false, drawSubtitle:false, drawComposer:false, drawCredits:false,
      drawPartNames:false, drawPartAbbreviations:false,
      newSystemFromXML:true, stretchLastSystemLine:true,
      drawingParameters:"compacttight",
    });
    osmdBgInst.setOptions({ defaultColorMusic:"#00000000" });  // notes/clef/timesig invisible; lyrics laid out then hidden
    osmdBgInst.EngravingRules.PageBackgroundColor="";
    osmdBgInst.EngravingRules.StaffLineColor="#141019";   // keep staff lines (independent of music color)
    osmdBgInst.EngravingRules.StaffLineWidth=0.14;
    await osmdBgInst.load(xml);
    osmdBgInst.zoom=0.95;
    osmdBgInst.render();
    hideTextGlyphs(osmdBg);                                // hide lyric/tempo/number text, keep the reserved space
  }catch(e){ osmdBg.hidden=true; }
}

function sizeScoreToNotation(){
  try{
    const svg=osmdMount.querySelector("svg");
    if(!svg) return;
    const h=svg.getBoundingClientRect().height || osmdMount.scrollHeight;
    if(h>8) scoreHost.style.minHeight=h+"px";   // panel tall enough for the notes + background
  }catch(e){}
}

function renderResult(result){
  state.result=result;
  unlock("voice"); unlock("dj");
  composeNext.hidden=false;
  composeHint.className="hint"; composeHint.textContent="";
}

/* ---------- fullscreen score modal ---------- */
async function openScoreModal(){
  if(!(OSMD && lastXml)){ // nothing to show
    return;
  }
  scoreModal.hidden=false;
  scoreModalBody.innerHTML="";
  try{
    osmdModal=new OSMD(scoreModalBody,{
      backend:"svg", autoResize:true,
      drawTitle:false, drawSubtitle:false, drawComposer:false, drawCredits:false,
      drawPartNames:false, drawPartAbbreviations:false, newSystemFromXML:true,
      drawingParameters:"default",
    });
    try{ osmdModal.setOptions({defaultColorMusic:"#141019"});
      osmdModal.EngravingRules.PageBackgroundColor=""; osmdModal.EngravingRules.StaffLineWidth=0.14; }catch(e){}
    await osmdModal.load(lastXml);
    osmdModal.render();
  }catch(e){
    // fallback: clone the inline score if a fresh render fails
    scoreModalBody.innerHTML=osmdMount.innerHTML;
  }
}
function closeScoreModal(){ scoreModal.hidden=true; scoreModalBody.innerHTML=""; }
expandScore.addEventListener("click",openScoreModal);
closeScore.addEventListener("click",closeScoreModal);
scoreModal.addEventListener("click",(e)=>{ if(e.target===scoreModal) closeScoreModal(); });
document.addEventListener("keydown",(e)=>{ if(e.key==="Escape" && !scoreModal.hidden) closeScoreModal(); });

/* ---------- voice (optional, skippable, multiple) ---------- */
const drop=$("#drop"), vocalFile=$("#vocalFile"), dropText=$("#dropText"),
      voiceHint=$("#voiceHint"), voiceList=$("#voiceList");
drop.addEventListener("click",()=>vocalFile.click());
drop.addEventListener("dragover",e=>{e.preventDefault();drop.classList.add("over");});
drop.addEventListener("dragleave",()=>drop.classList.remove("over"));
drop.addEventListener("drop",e=>{e.preventDefault();drop.classList.remove("over");[...e.dataTransfer.files].forEach(uploadVocal);});
vocalFile.addEventListener("change",()=>{[...vocalFile.files].forEach(uploadVocal);});
async function uploadVocal(file){
  dropText.textContent="Uploading "+file.name+"\u2026";
  const fd=new FormData(); fd.append("file",file);
  try{ const d=await(await fetch("/upload_vocals",{method:"POST",body:fd})).json();
    if(d.error){ voiceHint.className="hint error"; voiceHint.textContent=d.error; }
    else{ voiceList.innerHTML=d.all.map(f=>`<li>${f}</li>`).join("");
      voiceHint.className="hint ok"; voiceHint.textContent=d.all.length+" track(s) added.";
      dropText.textContent="Drop audio files here, or click to choose"; refreshTrackPicker(d.all); }
  }catch(e){ voiceHint.className="hint error"; voiceHint.textContent="Upload failed: "+e; }
}

/* ---------- DJ deck ---------- */
const djInstrument=$("#djInstrument"),
      bpm=$("#bpm"), bpmOut=$("#bpmOut"), songVol=$("#songVol"), songVolOut=$("#songVolOut"),
      metroBpm=$("#metroBpm"), metroBpmOut=$("#metroBpmOut"), metroVol=$("#metroVol"), metroVolOut=$("#metroVolOut"),
      playBtn=$("#playBtn"), stopBtn=$("#stopBtn"), restartBtn=$("#restartBtn"),
      back10Btn=$("#back10Btn"), fwd10Btn=$("#fwd10Btn"),
      seek=$("#seek"), curTime=$("#curTime"), durTime=$("#durTime"),
      metroToggle=$("#metroToggle"),
      modePlayback=$("#modePlayback"), modeEdit=$("#modeEdit"),
      playbackView=$("#playbackView"), editView=$("#editView"),
      trackPickWrap=$("#trackPickWrap"), trackPick=$("#trackPick"),
      rollCanvas=$("#rollCanvas"), djHint=$("#djHint");

window.T2T.instruments.forEach(inst=>{ const o=document.createElement("option");
  o.value=inst.p; o.textContent=inst.n; djInstrument.appendChild(o); });

const audioEl=new Audio(); audioEl.preload="auto"; audioEl.volume=0.9;
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
    await new Promise((res,rej)=>{ audioEl.src=d.url;
      audioEl.oncanplaythrough=()=>res(); audioEl.onerror=()=>rej(new Error("audio load failed"));
      audioEl.load(); setTimeout(res,4000); });
    audioReady=true; needRender=false;
    djHint.className="hint"; djHint.textContent = d.method==="sine" ? "Playing a basic synth (soundfont not found on server)." : "";
    return true;
  }catch(e){ djHint.className="hint error"; djHint.textContent="Audio render failed: "+e.message; return false; }
  finally{ rendering=false; }
}

djInstrument.addEventListener("change",async()=>{ state.program=+djInstrument.value; needRender=true;
  const was=!audioEl.paused; stopPlayback(); await renderServerAudio(); if(was) startPlayback(); });
bpm.addEventListener("input",()=>{ state.tempo=+bpm.value; bpmOut.textContent=state.tempo; needRender=true; });
bpm.addEventListener("change",async()=>{ const was=!audioEl.paused; stopPlayback(); await renderServerAudio(); if(was) startPlayback(); });
songVol.addEventListener("input",()=>{ songVolOut.textContent=songVol.value; audioEl.volume=(+songVol.value)/100; });
metroBpm.addEventListener("input",()=>{ state.metroTempo=+metroBpm.value; metroBpmOut.textContent=state.metroTempo;
  if(state.metroOn && !audioEl.paused){ stopMetro(); startMetro(); } });
metroVol.addEventListener("input",()=>{ metroVolOut.textContent=metroVol.value; });
metroToggle.addEventListener("click",()=>{ state.metroOn=!state.metroOn;
  metroToggle.classList.toggle("on",state.metroOn); metroToggle.textContent=state.metroOn?"ON":"OFF";
  if(!audioEl.paused){ state.metroOn?startMetro():stopMetro(); } });

modePlayback.addEventListener("click",()=>setMode("playback"));
modeEdit.addEventListener("click",()=>setMode("edit"));
function setMode(m){ modePlayback.classList.toggle("is-active",m==="playback");
  modeEdit.classList.toggle("is-active",m==="edit");
  playbackView.hidden=(m!=="playback"); editView.hidden=(m==="playback"); }
function refreshTrackPicker(vocals){ trackPick.innerHTML="<option value='melody'>Melody</option>"+
  (vocals||[]).map(f=>`<option value="vocal:${f}">${f}</option>`).join(""); trackPickWrap.hidden=false; }

let deckReady=false;
async function onEnterDeck(){
  if(state.result) unlock("dj");
  bpmOut.textContent=state.tempo; metroBpmOut.textContent=state.metroTempo;
  songVolOut.textContent=songVol.value; metroVolOut.textContent=metroVol.value;
  sizeCanvas(); drawRoll();
  if(!deckReady){ deckReady=true; await renderServerAudio(); }
  else if(needRender){ await renderServerAudio(); }
}
window.addEventListener("resize",()=>{ if(deckReady){ sizeCanvas(); drawRoll(); }});

/* ----- media controls (with a 1-bar metronome count-in) ----- */
let countIn={active:false, t0:0, dur:0};
function cancelCountIn(){ countIn.active=false; }

// virtual song time: negative during the count-in bar, then the audio clock.
function songTime(){
  if(countIn.active){
    const el=(performance.now()-countIn.t0)/1000;
    if(el>=countIn.dur){                 // count-in finished -> start the song
      countIn.active=false;
      audioEl.currentTime=0; audioEl.play();
      if(state.metroOn) startMetro();
      return 0;
    }
    return el-countIn.dur;                // -bar .. 0  (gives the lead-in space)
  }
  return audioEl.currentTime||0;
}

function startPlayback(){
  if(!state.result){ djHint.className="hint error"; djHint.textContent="Compose a melody first."; return; }
  if(!audioReady){ renderServerAudio().then(ok=>{ if(ok) startPlayback(); }); return; }
  // 1-bar count-in (4 clicks) at the song tempo, THEN the song begins
  const bar=4*(60/state.tempo);
  countIn.active=true; countIn.t0=performance.now(); countIn.dur=bar;
  playCountIn(bar);
  playBtn.innerHTML="&#10073;&#10073;";
  loopRoll();
}
function playCountIn(bar){
  try{
    if(!metroCtx) metroCtx=new (window.AudioContext||window.webkitAudioContext)();
    if(metroCtx.state==="suspended") metroCtx.resume();
    const beat=bar/4, t0=metroCtx.currentTime+0.03;
    for(let i=0;i<4;i++){ click(t0+i*beat, i===0); }   // count-in is always audible
  }catch(e){}
}
function stopPlayback(){ cancelCountIn(); audioEl.pause(); audioEl.currentTime=0; playBtn.innerHTML="&#9654;";
  if(rafId) cancelAnimationFrame(rafId); stopMetro(); syncSeek(); drawRoll(); }
function pausePlayback(){ cancelCountIn(); audioEl.pause(); playBtn.innerHTML="&#9654;"; if(rafId) cancelAnimationFrame(rafId); stopMetro(); }
audioEl.addEventListener("ended",()=>{ playBtn.innerHTML="&#9654;"; if(rafId) cancelAnimationFrame(rafId); stopMetro(); syncSeek(); drawRoll(); });
audioEl.addEventListener("loadedmetadata",syncSeek);
audioEl.addEventListener("timeupdate",syncSeek);

playBtn.addEventListener("click",()=>{ if(audioEl.paused && !countIn.active) startPlayback(); else pausePlayback(); });
stopBtn.addEventListener("click",stopPlayback);
restartBtn.addEventListener("click",()=>{ cancelCountIn(); audioEl.currentTime=0; if(audioEl.paused) drawRoll(); });
back10Btn.addEventListener("click",()=>seekBy(-10));
fwd10Btn.addEventListener("click",()=>seekBy(10));
function seekBy(d){ cancelCountIn(); const dur=audioEl.duration||0; audioEl.currentTime=Math.max(0,Math.min(dur, audioEl.currentTime+d)); if(audioEl.paused) drawRoll(); }
seek.addEventListener("input",()=>{ cancelCountIn(); const dur=audioEl.duration||0; audioEl.currentTime=(+seek.value/1000)*dur; if(audioEl.paused) drawRoll(); });
function syncSeek(){ const dur=audioEl.duration||0, cur=audioEl.currentTime||0;
  const pct=dur?cur/dur*100:0; seek.value=dur?Math.round(cur/dur*1000):0;
  seek.style.setProperty("--seek", pct.toFixed(1)+"%");
  curTime.textContent=fmt(cur); durTime.textContent=fmt(dur); }

/* ----- scrollable + zoomable time-axis roll -----
   Y axis = time. Bottom edge = the keyboard (the "now" line). Notes above are
   upcoming. Scroll wheel seeks; ctrl+wheel zooms (changes seconds-on-screen). */
const cx=()=>rollCanvas.getContext("2d");
const MIN_PITCH=21, MAX_PITCH=108;
let zoomSeconds=2.5;                 // seconds visible above the keyboard
const ZOOM_MIN=0.8, ZOOM_MAX=12;
let rafId=null;

function sizeCanvas(){ const dpr=window.devicePixelRatio||1, w=rollCanvas.clientWidth, h=rollCanvas.clientHeight;
  rollCanvas.width=w*dpr; rollCanvas.height=h*dpr; cx().setTransform(dpr,0,0,dpr,0,0); }
function pitchToX(p,w){ return ((p-MIN_PITCH)/(MAX_PITCH-MIN_PITCH))*w; }
function scaledNotes(){ const ratio=120/state.tempo;
  return (state.result?state.result.flat_notes:[]).map(n=>({pitch:n.pitch,start:n.start*ratio,dur:Math.max(0.05,n.dur*ratio)})); }

function drawRoll(){
  const c=cx(), w=rollCanvas.clientWidth, h=rollCanvas.clientHeight;
  const now=songTime();
  // #6: opaque BLACK graph
  c.fillStyle="#05060a"; c.fillRect(0,0,w,h);
  // vertical pitch octave lines
  c.strokeStyle="rgba(180,186,224,0.10)"; c.lineWidth=1;
  for(let p=MIN_PITCH;p<=MAX_PITCH;p++){ if(p%12===0){ const x=pitchToX(p,w); c.beginPath(); c.moveTo(x,0); c.lineTo(x,h); c.stroke(); } }

  // time grid: faint beat lines + brighter measure lines with measure numbers
  const barDur=4*(60/state.tempo), beatDur=barDur/4, tEnd=now+zoomSeconds;
  for(let k=Math.floor(now/beatDur); k*beatDur<=tEnd; k++){
    const t=k*beatDur, y=h-(t-now)/zoomSeconds*h;
    c.strokeStyle="rgba(180,186,224,0.06)"; c.lineWidth=1;
    c.beginPath(); c.moveTo(0,y); c.lineTo(w,y); c.stroke();
  }
  c.font="13px 'Chivo Mono', monospace"; c.textAlign="left";
  for(let m=Math.floor(now/barDur); m*barDur<=tEnd; m++){
    const t=m*barDur; if(t<-1e-6) continue;
    const y=h-(t-now)/zoomSeconds*h, num=m+1;
    c.strokeStyle="rgba(200,205,235,0.20)"; c.lineWidth=1;
    c.beginPath(); c.moveTo(0,y); c.lineTo(w,y); c.stroke();
    c.fillStyle="rgba(220,224,245,0.55)"; c.fillText(String(num), 8, y-5);
    if(num===1) c.fillText("4/4", 42, y-5);          // time signature, like the reference
  }
  // the "now" line at the keyboard
  c.strokeStyle="rgba(143,56,232,0.85)"; c.lineWidth=2; c.beginPath(); c.moveTo(0,h-1); c.lineTo(w,h-1); c.stroke();

  // notes
  scaledNotes().forEach(n=>{
    const tTo=n.start-now; if(tTo>zoomSeconds||tTo< -n.dur) return;
    const x=pitchToX(n.pitch,w), noteW=Math.max(8,w/(MAX_PITCH-MIN_PITCH)-2);
    const y=h-(tTo/zoomSeconds)*h, noteH=Math.max(8,(n.dur/zoomSeconds)*h);
    const grad=c.createLinearGradient(0,y-noteH,0,y);
    grad.addColorStop(0,"#5566ff"); grad.addColorStop(1,"#a24bf0");
    c.fillStyle=grad; c.shadowColor="rgba(143,56,232,0.6)"; c.shadowBlur=12;
    roundRect(c,x-noteW/2,y-noteH,noteW,noteH,3); c.fill(); c.shadowBlur=0;
  });

  // key / tempo annotation, bottom-right (like the reference)
  c.fillStyle="rgba(210,214,238,0.5)"; c.font="13px 'Chivo Mono', monospace"; c.textAlign="right";
  c.fillText("C major "+state.tempo+" bpm", w-10, h-9);

  if(!state.result){ c.fillStyle="rgba(220,224,245,0.65)"; c.font="16px 'Chivo Mono', monospace";
    c.textAlign="center"; c.fillText("Compose a melody to see it play here.",w/2,h/2); }
}
function loopRoll(){ drawRoll(); if(countIn.active || !audioEl.paused) rafId=requestAnimationFrame(loopRoll); }
function roundRect(c,x,y,w,h,r){ c.beginPath(); c.moveTo(x+r,y);
  c.arcTo(x+w,y,x+w,y+h,r); c.arcTo(x+w,y+h,x,y+h,r); c.arcTo(x,y+h,x,y,r); c.arcTo(x,y,x+w,y,r); c.closePath(); }

// wheel: scroll = seek; ctrl/⌘+wheel = zoom (within bounds)
rollCanvas.addEventListener("wheel",(e)=>{
  e.preventDefault();
  if(e.ctrlKey||e.metaKey){
    const f=e.deltaY>0?1.1:0.9;
    zoomSeconds=Math.max(ZOOM_MIN,Math.min(ZOOM_MAX, zoomSeconds*f));
  }else{
    const dur=audioEl.duration||0;
    const delta=(e.deltaY/100)*(zoomSeconds*0.4);   // scroll up = forward in time
    audioEl.currentTime=Math.max(0,Math.min(dur, audioEl.currentTime+delta));
  }
  drawRoll();
},{passive:false});

/* ----- metronome (independent tempo, Web Audio clicks during playback) ----- */
let metroCtx=null, metroTimer=null, metroNext=0, metroIdx=0;
function startMetro(){ if(!state.metroOn) return;
  if(!metroCtx) metroCtx=new (window.AudioContext||window.webkitAudioContext)();
  if(metroCtx.state==="suspended") metroCtx.resume();
  metroIdx=0; metroNext=metroCtx.currentTime+0.05;
  if(metroTimer) clearInterval(metroTimer);
  metroTimer=setInterval(()=>{ if(audioEl.paused) return;
    const beat=60/state.metroTempo, ahead=metroCtx.currentTime+0.2;
    while(metroNext<ahead){ click(metroNext, metroIdx%4===0); metroNext+=beat; metroIdx++; } },40); }
function stopMetro(){ if(metroTimer){ clearInterval(metroTimer); metroTimer=null; } }
function click(at,accent){ const o=metroCtx.createOscillator(), g=metroCtx.createGain();
  o.frequency.value=accent?1600:1000; const vol=(+metroVol.value)/100*0.5*(accent?1.25:1);
  g.gain.setValueAtTime(vol,at); g.gain.exponentialRampToValueAtTime(0.0001,at+0.05);
  o.connect(g); g.connect(metroCtx.destination); o.start(at); o.stop(at+0.06); }

/* ----- downloads (include metronome if toggled) ----- */
function metroQuery(){ return `&metro=${state.metroOn?1:0}&metro_tempo=${state.metroTempo}&metro_vol=${metroVol.value}`; }
function wireDownload(el,kind){
  el.addEventListener("click",async()=>{
    if(!state.result){ djHint.className="hint error"; djHint.textContent="Compose a melody first."; return; }
    el.classList.add("busy"); const orig=el.textContent; el.textContent="\u2026";
    try{ const url=`/download/${kind}?program=${state.program}&tempo=${state.tempo}`+(kind==="xml"?"":metroQuery());
      const r=await fetch(url); if(!r.ok) throw new Error(await r.text());
      const blob=await r.blob(); const a=document.createElement("a");
      a.href=URL.createObjectURL(blob); a.download="text_to_tune."+(kind==="xml"?"musicxml":kind);
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
      djHint.className="hint ok"; djHint.textContent=kind.toUpperCase()+" downloaded"+(state.metroOn&&kind!=="xml"?" (with metronome).":".");
    }catch(e){ djHint.className="hint error"; djHint.textContent="Download failed: "+e.message; }
    el.classList.remove("busy"); el.textContent=orig;
  });
}
wireDownload($("#dlMidi"),"midi");
wireDownload($("#dlXml"),"xml");
wireDownload($("#dlWav"),"wav");
