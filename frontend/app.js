/* ============================================================
   DrawPool app — demo state machine + ethers compatibility.
   - Shows representative demo data immediately (flagged "demo").
   - When window.DRAWPOOL_CONFIG + DRAWPOOL_ABI exist and a wallet
     connects, the SAME handlers run live against OPN testnet
     using the original contract interface.
   ============================================================ */
const DEC = 6;
const cfg = window.DRAWPOOL_CONFIG || null;
const ABIS = window.DRAWPOOL_ABI || null;
let provider, signer, account, usdc, pool, yieldSrc, rng;
let cad = 86400, lastDrawAt = 0, liveMode = false, prizeShown = 0, yieldRate = 0;

const $ = (id) => document.getElementById(id);
const fmt = (bn, d = 0) => Number(ethers.formatUnits(bn, DEC)).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const shortAddr = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const HEX = "0123456789abcdef";
const randHex = (n) => Array.from({ length: n }, () => HEX[Math.random() * 16 | 0]).join("");
const randAddr = () => "0x" + randHex(4) + "…" + randHex(4);
const randHash = () => "0x" + randHex(64);

function toast(m) {
  const t = $("toast"); t.textContent = m; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 4000);
}

/* ============================================================
   SOUND ENGINE — synthesized via Web Audio (no asset files).
   Signal flow:  voices → [dry + reverb send] → bus → limiter → out
   Lazy-initialized on first user gesture (Start/Award click).
   ============================================================ */
let actx = null, soundOn = true, sBus = null, sRev = null, sNoise = null;
function audio() {
  if (!soundOn) return null;
  if (!actx) {
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
    // master bus → soft limiter → destination
    const lim = actx.createDynamicsCompressor();
    lim.threshold.value = -6; lim.knee.value = 6; lim.ratio.value = 12; lim.attack.value = 0.003; lim.release.value = 0.14;
    sBus = actx.createGain(); sBus.gain.value = 0.9;
    sBus.connect(lim); lim.connect(actx.destination);
    // plate-ish reverb for polish
    const conv = actx.createConvolver(); conv.buffer = makeIR(2.2, 2.6);
    sRev = actx.createGain(); sRev.gain.value = 0.9;
    conv.connect(sRev); sRev.connect(sBus); sBus._conv = conv;
    // shared white-noise buffer
    const len = actx.sampleRate; sNoise = actx.createBuffer(1, len, actx.sampleRate);
    const d = sNoise.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  if (actx.state === "suspended") actx.resume();
  return actx;
}
function makeIR(sec, decay) {
  const rate = actx.sampleRate, len = rate * sec, buf = actx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
  return buf;
}
/* route a node: dry to bus + scaled send to reverb */
function route(node, wet) {
  node.connect(sBus);
  if (wet > 0) { const s = actx.createGain(); s.gain.value = wet; node.connect(s); s.connect(sBus._conv); }
}
/* short filtered-noise transient — a real mechanical "tick/clack", not a beep */
function click(t, { freq = 2000, q = 4, dur = 0.05, gain = 0.3, wet = 0.12 } = {}) {
  const a = audio(); if (!a) return;
  const src = a.createBufferSource(); src.buffer = sNoise; src.loop = true;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const bp = a.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = freq; bp.Q.value = q;
  const g = a.createGain(); g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bp).connect(g); route(g, wet); src.start(t); src.stop(t + dur + 0.02);
}
/* detuned-saw voice with ADSR + lowpass — warm musical tone for chords */
function voice(freq, t, dur, { gain = 0.18, attack = 0.012, release = 0.4, cutoff = 2600, wet = 0.35, pan = 0 } = {}) {
  const a = audio(); if (!a) return;
  const o1 = a.createOscillator(), o2 = a.createOscillator(), o3 = a.createOscillator();
  o1.type = o2.type = "sawtooth"; o3.type = "sine";
  o1.frequency.value = freq; o2.frequency.value = freq; o3.frequency.value = freq / 2;
  o1.detune.value = -9; o2.detune.value = 9;
  const lp = a.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.setValueAtTime(cutoff * 1.7, t);
  lp.frequency.exponentialRampToValueAtTime(cutoff, t + dur * 0.6); lp.Q.value = 0.7;
  const g = a.createGain(); g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.setValueAtTime(gain, t + Math.max(attack, dur - release));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const p = a.createStereoPanner ? a.createStereoPanner() : null; if (p) p.pan.value = pan;
  o1.connect(lp); o2.connect(lp); o3.connect(lp);
  if (p) { lp.connect(g).connect(p); route(p, wet); } else { lp.connect(g); route(g, wet); }
  [o1, o2, o3].forEach(o => { o.start(t); o.stop(t + dur + 0.05); });
}
/* FM bell — bright metallic shimmer / coin sparkle */
function bell(freq, t, dur, gain = 0.06, wet = 0.5, pan = 0) {
  const a = audio(); if (!a) return;
  const car = a.createOscillator(), mod = a.createOscillator(), mg = a.createGain(), g = a.createGain();
  car.type = "sine"; mod.type = "sine"; mod.frequency.value = freq * 2.01;
  mg.gain.setValueAtTime(freq * 3, t); mg.gain.exponentialRampToValueAtTime(1, t + dur);
  car.frequency.value = freq; mod.connect(mg); mg.connect(car.frequency);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const p = a.createStereoPanner ? a.createStereoPanner() : null; if (p) p.pan.value = pan;
  if (p) { car.connect(g).connect(p); route(p, wet); } else { car.connect(g); route(g, wet); }
  car.start(t); mod.start(t); car.stop(t + dur + 0.05); mod.stop(t + dur + 0.05);
}
/* pitch-dropping sine sub — body / impact */
function sub(t, f0, f1, dur, gain = 0.5, wet = 0.1) {
  const a = audio(); if (!a) return;
  const o = a.createOscillator(), g = a.createGain();
  o.type = "sine"; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); route(g, wet); o.start(t); o.stop(t + dur + 0.05);
}

/* deep mechanical "lock" when the pool commits to a block */
function sndCommit() {
  const a = audio(); if (!a) return; const t = a.currentTime;
  sub(t, 150, 52, 0.34, 0.5);
  click(t, { freq: 340, q: 1.4, dur: 0.16, gain: 0.4, wet: 0.18 });      // low thunk body
  click(t + 0.006, { freq: 1900, q: 7, dur: 0.05, gain: 0.16, wet: 0.1 }); // metallic top
  bell(640, t + 0.02, 0.4, 0.05, 0.5);                                     // subtle ring-out
}
/* decelerating mechanical reel — filtered-noise clacks that dull as it slows */
function sndReel(durMs) {
  const a = audio(); if (!a) return; const t0 = a.currentTime, T = durMs / 1000, N = 32;
  for (let i = 0; i < N; i++) {
    const p = i / (N - 1);
    const when = t0 + (1 - Math.pow(1 - p, 2.5)) * (T - 0.04); // ease-out spacing → slows down
    const freq = 2700 - p * 1500;                              // brightness falls as it decelerates
    click(when, { freq, q: 5, dur: 0.045, gain: 0.13 + p * 0.06, wet: 0.08 });
  }
}
/* polished casino win — sub impact + major arpeggio (detuned saws) + bell shimmer + coin shower */
function sndWin() {
  const a = audio(); if (!a) return; const t = a.currentTime;
  sub(t, 120, 46, 0.5, 0.55);                                  // impact
  click(t, { freq: 1100, q: 0.7, dur: 0.4, gain: 0.1, wet: 0.2 }); // riser whoosh
  const arp = [523.25, 659.25, 783.99, 1046.5];                // C5 E5 G5 C6
  arp.forEach((f, i) => {
    const tt = t + i * 0.085;
    voice(f, tt, 0.55, { gain: 0.15, cutoff: 3200, wet: 0.32, pan: (i - 1.5) * 0.3 });
    bell(f * 2, tt, 0.5, 0.05, 0.55, (i - 1.5) * 0.4);
  });
  const tc = t + arp.length * 0.085;                           // sustained C-major shimmer chord
  [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) =>
    voice(f, tc, 1.5, { gain: 0.085, attack: 0.05, release: 1.1, cutoff: 2600, wet: 0.5, pan: (i - 2) * 0.22 }));
  for (let i = 0; i < 18; i++) {                               // coin shower sparkles
    const tt = t + 0.15 + Math.random() * 1.3;
    bell(1500 + Math.random() * 1900, tt, 0.22, 0.045, 0.6, (Math.random() - 0.5) * 1.4);
  }
}

/* ---------------- tweaks bridge ---------------- */
window.applyTweaks = function (t) {
  const root = document.documentElement;
  root.dataset.intensity = t.intensity || "balanced";
  root.dataset.motion = t.reduceMotion ? "off" : "on";
  $("drip").style.display = t.yieldTicker ? "flex" : "none";
  $("fair").style.display = t.fairBlock ? "flex" : "none";
  soundOn = t.sound !== false;
};

const TWEAK_DEFAULTS = {
  intensity: "calm",
  sound: true,
  yieldTicker: false,
  fairBlock: false,
  reduceMotion: false,
};

function shouldExposeTweaks() {
  const params = new URLSearchParams(window.location.search);
  return window.location.protocol === "file:" ||
    ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname) ||
    params.get("tweaks") === "1";
}

function bootFallbackTweaks() {
  if (!shouldExposeTweaks() || window.__DRAWPOOL_TWEAKS_BOOTED || $("dpTweaksLaunch")) return;
  const style = document.createElement("style");
  style.textContent = `
    .dp-tweaks-launch{position:fixed;right:16px;bottom:16px;z-index:2147483645;height:32px;padding:0 12px;border:0;border-radius:999px;background:rgba(250,249,247,.9);color:#29261b;font:600 11px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:.08em;text-transform:uppercase;box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 12px 32px rgba(0,0,0,.16);-webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%)}
    .dp-tweaks-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:280px;padding:14px;border-radius:14px;background:rgba(250,249,247,.92);color:#29261b;font:11.5px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif;box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 12px 40px rgba(0,0,0,.18);-webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%)}
    .dp-tweaks-panel[hidden]{display:none}
    .dp-tweaks-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
    .dp-tweaks-head b{font-size:12px;letter-spacing:.01em}
    .dp-tweaks-close{border:0;background:transparent;color:rgba(41,38,27,.55);font-size:13px}
    .dp-tweaks-group{display:grid;gap:8px;margin-top:10px}
    .dp-tweaks-group strong{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:rgba(41,38,27,.45)}
    .dp-tweaks-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .dp-tweaks-radio{display:flex;gap:6px}
    .dp-tweaks-radio button{border:0;border-radius:999px;padding:6px 10px;background:rgba(0,0,0,.06);color:inherit;font:inherit}
    .dp-tweaks-radio button[data-on="1"]{background:#29261b;color:#fff}
    .dp-tweaks-row input{accent-color:#7c5cff}
  `;
  document.head.appendChild(style);

  const launch = document.createElement("button");
  launch.id = "dpTweaksLaunch";
  launch.className = "dp-tweaks-launch";
  launch.type = "button";
  launch.textContent = "Tweaks";

  const panel = document.createElement("div");
  panel.id = "dpTweaksPanel";
  panel.className = "dp-tweaks-panel";
  panel.hidden = true;

  const state = { ...TWEAK_DEFAULTS };
  const redraw = () => {
    panel.innerHTML = `
      <div class="dp-tweaks-head"><b>Tweaks</b><button type="button" class="dp-tweaks-close" id="dpTweaksClose">✕</button></div>
      <div class="dp-tweaks-group">
        <strong>Gambling energy</strong>
        <div class="dp-tweaks-row">
          <span>Intensity</span>
          <div class="dp-tweaks-radio">
            ${["calm", "balanced", "hype"].map((v) => `<button type="button" data-k="intensity" data-v="${v}" data-on="${state.intensity === v ? "1" : "0"}">${v}</button>`).join("")}
          </div>
        </div>
      </div>
      <div class="dp-tweaks-group">
        <strong>Readouts</strong>
        ${[
          ["sound", "Draw sound"],
          ["yieldTicker", "Live yield ticker"],
          ["fairBlock", "Provably fair block"],
          ["reduceMotion", "Reduce motion"],
        ].map(([k, label]) => `
          <label class="dp-tweaks-row">
            <span>${label}</span>
            <input type="checkbox" data-k="${k}" ${state[k] ? "checked" : ""} />
          </label>`).join("")}
      </div>
    `;
    $("dpTweaksClose").onclick = () => {
      panel.hidden = true;
      launch.hidden = false;
    };
    panel.querySelectorAll("[data-k='intensity']").forEach((btn) => {
      btn.onclick = () => {
        state.intensity = btn.dataset.v;
        window.applyTweaks(state);
        redraw();
      };
    });
    panel.querySelectorAll("input[data-k]").forEach((input) => {
      input.onchange = () => {
        state[input.dataset.k] = input.checked;
        window.applyTweaks(state);
      };
    });
  };

  launch.onclick = () => {
    launch.hidden = true;
    panel.hidden = false;
  };

  redraw();
  document.body.appendChild(launch);
  document.body.appendChild(panel);
  window.applyTweaks(state);
  window.__DRAWPOOL_TWEAKS_BOOTED = true;
}

/* ---------------- jackpot ticking ---------------- */
function setPrize(v) {
  $("prize").textContent = v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  prizeShown = v;
}
function animatePrize(to) {
  if (document.hidden || document.documentElement.dataset.motion === "off") { setPrize(to); return; }
  const from = prizeShown, start = performance.now(), dur = 800;
  (function step(now) {
    const p = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - p, 3);
    setPrize(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(step); else prizeShown = to;
  })(start);
}
/* continuous micro-drip so the jackpot is visibly alive */
function startDrip() {
  setInterval(() => {
    if (document.hidden || drawRunning) return;
    setPrize(prizeShown + yieldRate);
    $("dripRate").textContent = "+" + yieldRate.toFixed(4);
  }, 1000);
}

/* ---------------- donut (participant shares) ---------------- */
const SHADES = ["#7c5cff", "#9a7dff", "#6a45e0", "#b29bff", "#5b34d6", "#8268f0"];
function renderDonut(parts) {
  // parts: [{name, bal, you}], sorted desc. "You" is ALWAYS surfaced as its
  // own gold segment regardless of rank; the rest fill top-N + an Others bucket.
  const total = parts.reduce((s, p) => s + p.bal, 0) || 1;
  const you = parts.find((p) => p.you);
  const others = parts.filter((p) => !p.you);
  const topN = others.slice(0, 5);
  const tail = others.slice(5);
  const segs = [];
  if (you) segs.push({ name: "You", bal: you.bal, you: true, color: "var(--gold)" });
  topN.forEach((p, i) => segs.push({ name: p.name, bal: p.bal, color: SHADES[i % SHADES.length] }));
  if (tail.length) segs.push({ name: "Others (" + tail.length + ")", bal: tail.reduce((s, p) => s + p.bal, 0), color: "#3a3a46" });

  const C = 2 * Math.PI * 60, gap = 3;
  let acc = 0, circles = "";
  segs.forEach((s) => {
    const f = s.bal / total, arc = Math.max(0, f * C - gap);
    circles += `<circle class="seg" cx="76" cy="76" r="60" fill="none" stroke="${s.color}" stroke-width="${s.you ? 20 : 16}"
      stroke-dasharray="${arc} ${C - arc}" stroke-dashoffset="${-acc * C}"></circle>`;
    acc += f;
  });
  $("donutSvg").innerHTML = `<circle cx="76" cy="76" r="60" fill="none" stroke="var(--surface-3)" stroke-width="16"></circle>` + circles;

  const youShare = you ? (you.bal / total * 100) : 0;
  $("donutPct").textContent = youShare.toFixed(1) + "%";
  $("legend").innerHTML = segs.map((s) => `
    <div class="lrow ${s.you ? "you" : ""}">
      <span class="sw" style="background:${s.color}"></span>
      <span class="nm">${s.you ? "You" : s.name}</span>
      <span class="pc">${(s.bal / total * 100).toFixed(1)}%</span>
    </div>`).join("");
  return youShare;
}

/* ---------------- countdown ---------------- */
function fmtClock(s) {
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor(s % 3600 / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${ss}`;
}
function paintCountdown(left) {
  const clk = $("clk"), C = 754;
  clk.classList.toggle("soon", left > 0 && left <= 120);
  if (left <= 0) {
    $("cdT").textContent = "READY"; clk.classList.add("ready");
    $("cdRing").style.strokeDashoffset = 0; $("cdRing").style.stroke = "var(--green)"; return;
  }
  clk.classList.remove("ready");
  $("cdRing").style.stroke = left <= 120 ? "var(--amber)" : "var(--accent)";
  const frac = Math.max(0, Math.min(1, left / cad));
  $("cdRing").style.strokeDashoffset = C * (1 - frac);
  $("cdT").textContent = fmtClock(left);
}

/* ============================================================
   SLOT REEL — the draw "spin". Visual spectacle anchored to a
   real, finalized block hash (serious + provable, not a casino).
   ============================================================ */
let drawRunning = false, hashScrambler = null, committedBlock = 0;

function buildReel(participants, winnerName) {
  const inner = $("reelInner");
  const CELLS = 44, WIN_AT = 38, CELL_H = 48;
  let html = "";
  const pickName = () => participants[Math.random() * participants.length | 0].name;
  for (let i = 0; i < CELLS; i++) {
    const isWin = i === WIN_AT;
    const nm = isWin ? winnerName : pickName();
    html += `<div class="cell ${isWin ? "win" : ""}">${nm}<span class="tk">#${randHex(3)}</span></div>`;
  }
  inner.innerHTML = html;
  inner.style.transition = "none";
  inner.style.transform = "translateY(0)";
  return { WIN_AT, CELL_H };
}

/* fill the reel with random names + start a gentle looping scroll while
   we "await finality" — so the reel is never empty between Start and Award */
function fillReelIdle(participants) {
  const inner = $("reelInner"), reel = $("reel");
  const pickName = () => participants[Math.random() * participants.length | 0].name;
  let html = "";
  for (let i = 0; i < 24; i++) html += `<div class="cell">${pickName()}<span class="tk">#${randHex(3)}</span></div>`;
  inner.innerHTML = html + html; // duplicate for seamless loop
  inner.style.transition = "none";
  inner.style.transform = "translateY(0)";
  reel.classList.add("idle-spin");
}

function commitPhase() {
  if (drawRunning) return;
  drawRunning = true;
  $("reelIdle").style.display = "none";
  fillReelIdle((!liveMode ? demo.participants : [{ name: randAddr() }, { name: randAddr() }, { name: randAddr() }, { name: randAddr() }]));
  $("startBtn").disabled = true; $("awardBtn").disabled = false;
  // step state
  $("st1").classList.add("on", "done"); $("st2").classList.add("on"); $("st3").classList.remove("on");
  $("runHint").textContent = "Pool locked. Committed to a future OPN block — waiting for instant finality.";
  // commit data
  committedBlock = (liveMode ? 0 : 4820000 + (Math.random() * 9000 | 0));
  $("cBlock").textContent = "#" + committedBlock.toLocaleString("en-US");
  const status = $("cStatus"); status.className = "status live";
  $("cStatusT").textContent = "Awaiting finality…";
  // scramble the hash while "unfinalized"
  $("cHash").classList.remove("locked");
  clearInterval(hashScrambler);
  hashScrambler = setInterval(() => { $("cHash").textContent = randHash(); }, 70);
  sndCommit();
  toast("Draw committed — block " + committedBlock.toLocaleString("en-US"));
}

function awardPhase(participants) {
  if (!drawRunning) { toast("Start the draw first"); return; }
  // pick weighted winner (honest: odds ∝ balance)
  const total = participants.reduce((s, p) => s + p.bal, 0);
  let r = Math.random() * total, idx = 0;
  for (let i = 0; i < participants.length; i++) { r -= participants[i].bal; if (r <= 0) { idx = i; break; } }
  const winner = participants[idx];

  // freeze the hash — block is final, hash can't be rewritten
  clearInterval(hashScrambler);
  const finalHash = randHash();
  $("cHash").textContent = finalHash;
  $("cHash").classList.add("locked");
  $("cStatusT").textContent = "Finalized · entropy locked";
  $("cStatus").className = "status win";
  $("st2").classList.add("done"); $("st3").classList.add("on");

  // spin the reel
  const reel = $("reel"); reel.classList.remove("idle-spin"); reel.classList.add("spinning");
  const { WIN_AT, CELL_H } = buildReel(participants, winner.name);
  const target = 70 - WIN_AT * CELL_H; // centre winner cell on the win-line
  const hype = document.documentElement.dataset.intensity === "hype";
  const calm = document.documentElement.dataset.intensity === "calm";
  const dur = calm ? 2600 : hype ? 4200 : 3400;
  const inner = $("reelInner");
  // force reflow so the transition reliably triggers (independent of rAF/visibility)
  inner.getBoundingClientRect();
  setTimeout(() => {
    inner.style.transition = `transform ${dur}ms cubic-bezier(.12,.62,.12,1)`;
    inner.style.transform = `translateY(${target}px)`;
    sndReel(dur);
  }, 20);
  setTimeout(() => {
    reel.classList.remove("spinning");
    $("winline").classList.add("locked");
    onDrawSettled(winner, finalHash);
  }, dur + 120);
}

function onDrawSettled(winner, hash) {
  confetti();
  sndWin();
  toast("🏆 " + winner.name + " won " + prizeShown.toLocaleString("en-US", { maximumFractionDigits: 2 }) + " tUSDC");
  if (!liveMode) demoSettle(winner, hash);
  drawRunning = false;
  setTimeout(() => {
    $("winline").classList.remove("locked");
    $("reel").classList.remove("idle-spin");
    $("reelInner").style.transition = "none";
    $("reelInner").style.transform = "translateY(0)";
    $("reelInner").innerHTML = "";
    $("reelIdle").style.display = "grid";
    $("reel").querySelector(".winline").classList.remove("locked");
    $("st1").classList.remove("on"); $("st2").classList.remove("on", "done"); $("st3").classList.remove("on");
    $("st1").classList.remove("done");
    $("cStatus").className = "status"; $("cStatusT").textContent = "Idle — pool open";
    $("cHash").classList.remove("locked"); $("cHash").textContent = "—";
    $("cBlock").textContent = "—";
    $("startBtn").disabled = false; $("awardBtn").disabled = true;
    $("runHint").textContent = "Draws are permissionless — any player can run one when the timer hits zero.";
  }, 5200);
}

/* ---------------- confetti ---------------- */
/* ---------------- confetti (casino-grade) ---------------- */
let confettiRAF = null;
function darken(hex, f) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return `rgb(${r * f | 0},${g * f | 0},${b * f | 0})`;
}
function confetti() {
  if (document.documentElement.dataset.motion === "off") return;
  const c = $("confetti"), x = c.getContext("2d");
  const DPR = Math.min(devicePixelRatio || 1, 2), W = innerWidth, H = innerHeight;
  c.width = W * DPR; c.height = H * DPR; c.style.width = W + "px"; c.style.height = H + "px";
  x.setTransform(DPR, 0, 0, DPR, 0, 0);
  const hype = document.documentElement.dataset.intensity === "hype";
  const PAL = ["#7c5cff", "#a78bfa", "#c9b6ff", "#e9b949", "#f5cf6a", "#ffffff", "#46d369"];
  const P = [];
  const TAU = Math.PI * 2;
  function emit(ox, oy, n, angDeg, spreadDeg, power) {
    const base = angDeg * Math.PI / 180, spread = spreadDeg * Math.PI / 180;
    for (let i = 0; i < n; i++) {
      const a = base + (Math.random() - .5) * spread;
      const v = power * (.55 + Math.random() * .85);
      const ribbon = Math.random() < .28, circle = !ribbon && Math.random() < .22;
      const col = PAL[Math.random() * PAL.length | 0];
      P.push({
        x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        w: ribbon ? 4 + Math.random() * 3 : 6 + Math.random() * 6,
        h: ribbon ? 11 + Math.random() * 9 : 6 + Math.random() * 6,
        col, col2: darken(col, .55), ribbon, circle,
        tilt: Math.random() * TAU, tiltV: (Math.random() - .5) * .22,
        wob: Math.random() * TAU, wobV: .07 + Math.random() * .1,
        drag: .015 + Math.random() * .012, g: .26 + Math.random() * .12,
        life: 1, decay: .0045 + Math.random() * .004, swing: .4 + Math.random() * .9
      });
    }
  }
  const N = hype ? 1.5 : 1;
  // two side cannons firing inward + a centre pop above the orb
  emit(0, H * .98, Math.round(90 * N), -64, 46, 26);
  emit(W, H * .98, Math.round(90 * N), -116, 46, 26);
  emit(W / 2, H * .42, Math.round(70 * N), -90, 130, 13);
  let last = performance.now();
  cancelAnimationFrame(confettiRAF);
  (function loop(now) {
    const dt = Math.min(2.2, (now - last) / 16.67); last = now;
    x.clearRect(0, 0, W, H);
    let alive = 0;
    for (const p of P) {
      if (p.life <= 0) continue; alive++;
      p.vy += p.g * dt;
      p.vx *= (1 - p.drag * dt); p.vy *= (1 - p.drag * dt);
      p.vx += Math.sin(p.wob) * p.swing * dt * .12; // air flutter
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.tilt += p.tiltV * dt; p.wob += p.wobV * dt;
      p.life -= p.decay * dt;
      const flip = Math.cos(p.wob); // -1..1 → simulates a flat piece flipping in 3D
      x.save();
      x.translate(p.x, p.y); x.rotate(p.tilt); x.scale(1, Math.max(.12, Math.abs(flip)));
      x.globalAlpha = Math.max(0, Math.min(1, p.life * 1.4));
      x.fillStyle = flip >= 0 ? p.col : p.col2;
      if (p.circle) { x.beginPath(); x.arc(0, 0, p.w / 2, 0, TAU); x.fill(); }
      else if (p.ribbon) { x.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); }
      else { x.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); }
      x.restore();
    }
    if (alive > 0) confettiRAF = requestAnimationFrame(loop);
    else x.clearRect(0, 0, W, H);
  })(last);
}

/* ============================================================
   DEMO MODE
   ============================================================ */
const demo = {
  participants: [
    { name: "You", bal: 2000, you: true },
    { name: "0x9c3d…1e7a", bal: 8800 },
    { name: "0x1af4…77c0", bal: 6450 },
    { name: "0x55cf…7fb3", bal: 5200 },
    { name: "0xbda5…197e", bal: 4100 },
    { name: "0x77e2…0c41", bal: 3300 },
    { name: "0x2d9a…ff03", bal: 2600 },
    { name: "0x4b81…9ad2", bal: 1900 },
    { name: "0x0fc7…3e55", bal: 1500 },
    { name: "0xa612…b8d0", bal: 1100 },
    { name: "0x8e30…7712", bal: 900 },
    { name: "0xc91f…44ab", bal: 700 }
  ],
  prize: 312.84,
  paid: 3184,
  draws: 12,
  history: [
    { id: 12, w: "0x9c3d…1e7a", p: 312.84, t: "20 May", hash: "0x" + randHex(8), fresh: true },
    { id: 11, w: "0x1af4…77c0", p: 298.10, t: "19 May", hash: "0x" + randHex(8) },
    { id: 10, w: "0x55cf…7fb3", p: 271.55, t: "18 May", hash: "0x" + randHex(8) },
    { id: 9, w: "0xbda5…197e", p: 266.02, t: "17 May", hash: "0x" + randHex(8) }
  ],
  countdown: 2 * 3600 + 14 * 60 + 33
};

function renderDemo() {
  const total = demo.participants.reduce((s, p) => s + p.bal, 0);
  $("mTotal").textContent = total.toLocaleString("en-US");
  $("mPart").textContent = demo.participants.length;
  $("mPaid").textContent = demo.paid.toLocaleString("en-US");
  $("mDraws").textContent = demo.draws;

  yieldRate = 0.0042;
  $("dripRate").textContent = "+" + yieldRate.toFixed(4);
  animatePrize(demo.prize);

  const you = demo.participants.find(p => p.you);
  $("uBal").textContent = you.bal.toLocaleString("en-US") + " tUSDC";
  $("uWallet").textContent = "6,000 tUSDC";
  const share = renderDonut([...demo.participants].sort((a, b) => b.bal - a.bal));
  $("uOdds").textContent = share.toFixed(1) + "%";

  cad = 24 * 3600;
  paintCountdown(demo.countdown);
  renderWinners(demo.history);
  $("startBtn").disabled = false; $("awardBtn").disabled = true;

  // live demo loops
  startDrip();
  setInterval(() => {
    if (drawRunning) return;
    if (demo.countdown > 0) demo.countdown--;
    paintCountdown(demo.countdown);
  }, 1000);
}

function renderWinners(rows) {
  $("wlist").innerHTML = rows.length ? rows.map(r => `
    <tr class="${r.fresh ? "fresh" : ""}">
      <td><span class="id">#${r.id}</span></td>
      <td>${r.fresh ? '<span class="freshdot"></span>' : ""}${r.w}</td>
      <td class="r"><span class="amt">+${typeof r.p === "number" ? r.p.toFixed(2) : r.p}</span></td>
      <td class="r"><a class="hashlink" title="${r.hash}">${(r.hash || "").slice(0, 10)}…</a></td>
      <td class="r"><span class="when">${r.t}</span></td>
    </tr>`).join("")
    : '<tr><td colspan="5" class="empty">No draws settled yet — be the first to spin it.</td></tr>';
}

function demoSettle(winner, hash) {
  demo.draws++;
  demo.paid += Math.round(prizeShown);
  demo.history.forEach(h => h.fresh = false);
  demo.history.unshift({ id: demo.draws, w: winner.name, p: prizeShown, t: "now", hash, fresh: true });
  demo.history = demo.history.slice(0, 8);
  // winner's balance compounds (savings momentum)
  winner.bal += Math.round(prizeShown);
  demo.prize = 0; setPrize(0);
  demo.countdown = cad;
  $("mDraws").textContent = demo.draws;
  $("mPaid").textContent = demo.paid.toLocaleString("en-US");
  const total = demo.participants.reduce((s, p) => s + p.bal, 0);
  $("mTotal").textContent = total.toLocaleString("en-US");
  const share = renderDonut([...demo.participants].sort((a, b) => b.bal - a.bal));
  $("uOdds").textContent = share.toFixed(1) + "%";
  const you = demo.participants.find(p => p.you);
  $("uBal").textContent = you.bal.toLocaleString("en-US") + " tUSDC";
  renderWinners(demo.history);
}

/* ============================================================
   LIVE MODE (ethers) — preserves original contract interface
   ============================================================ */
async function ensureNetwork() {
  const want = "0x" + (984).toString(16);
  const cur = await window.ethereum.request({ method: "eth_chainId" });
  if (cur === want) return;
  try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] }); }
  catch (e) {
    if (e.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain", params: [{
          chainId: want, chainName: "OPN Testnet", nativeCurrency: { name: "OPN", symbol: "OPN", decimals: 18 },
          rpcUrls: [(cfg && cfg.rpc) || "https://testnet-rpc.iopn.tech"], blockExplorerUrls: ["https://testnet.opnscan.io"]
        }]
      });
    } else throw e;
  }
}
async function connect() {
  if (!window.ethereum) { toast("No EVM wallet found — install MetaMask."); return; }
  if (!cfg || !ABIS) { toast("Demo mode — run deploy.js to generate config.js + abi.js for live play."); return; }
  await ensureNetwork();
  provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  signer = await provider.getSigner(); account = await signer.getAddress();
  const c = cfg.contracts;
  usdc = new ethers.Contract(c.MockUSDC, ABIS.MockUSDC, signer);
  yieldSrc = new ethers.Contract(c.SponsoredYieldSource, ABIS.SponsoredYieldSource, signer);
  rng = new ethers.Contract(c.FinalityRandomness, ABIS.FinalityRandomness, signer);
  pool = new ethers.Contract(c.DrawPool, ABIS.DrawPool, signer);
  cad = Number(await pool.drawInterval()); liveMode = true;
  $("demoFlag").style.display = "none"; $("connect").textContent = shortAddr(account);
  $("addrLine").textContent = "POOL " + c.DrawPool.toUpperCase();
  $("explorerLink").href = cfg.explorer + "/address/" + c.DrawPool;
  await refresh(); setInterval(() => { if (liveMode) paintCountdown((lastDrawAt + cad) - Math.floor(Date.now() / 1000)); }, 1000);
}
async function refresh() {
  if (!pool) return;
  const [total, parts, drawCount, prize, bal, odds, wbal, nextAt, active, hLen] = await Promise.all([
    pool.totalDeposited(), pool.participantCount(), pool.drawCount(), pool.currentPrize(),
    pool.balanceOf(account), pool.oddsBps(account), usdc.balanceOf(account), pool.nextDrawAt(),
    pool.drawActive(), pool.historyLength()]);
  $("mTotal").textContent = fmt(total); $("mPart").textContent = parts.toString(); $("mDraws").textContent = drawCount.toString();
  animatePrize(Number(ethers.formatUnits(prize, DEC)));
  $("uBal").textContent = fmt(bal) + " tUSDC";
  const oddsPct = Number(odds) / 100; $("uOdds").textContent = oddsPct.toFixed(2) + "%";
  $("uWallet").textContent = fmt(wbal) + " tUSDC";
  $("donutPct").textContent = oddsPct.toFixed(1) + "%";
  // single-segment donut for the connected user vs rest of pool
  renderDonut([{ name: "You", bal: Number(ethers.formatUnits(bal, DEC)), you: true },
    { name: "Rest of pool", bal: Math.max(0, Number(ethers.formatUnits(total, DEC)) - Number(ethers.formatUnits(bal, DEC))) }]);
  lastDrawAt = Number(nextAt) - cad;
  $("st1").classList.toggle("on", active); $("st2").classList.toggle("on", active); $("st3").classList.toggle("on", !active);
  $("startBtn").disabled = active; $("awardBtn").disabled = !active;
  $("runHint").textContent = active ? "Draw is live — once the committed block finalizes, anyone can award the prize." : "Draws are permissionless — any player can run one when the timer hits zero.";
  const n = Number(hLen); let rows = [], paid = 0n;
  for (let i = n - 1; i >= 0 && i > n - 7; i--) { const d = await pool.history(i); paid += d.prize; rows.push({ id: d.id, w: shortAddr(d.winner), p: Number(ethers.formatUnits(d.prize, DEC)), t: new Date(Number(d.startedAt) * 1000).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }), hash: (d.randomness && d.randomness !== 0n) ? ("0x" + d.randomness.toString(16).padStart(64, "0")) : "", fresh: i === n - 1 }); }
  if (n > 6) { for (let i = n - 7; i >= 0; i--) { const d = await pool.history(i); paid += d.prize; } }
  $("mPaid").textContent = fmt(paid);
  renderWinners(rows);
  paintCountdown((lastDrawAt + cad) - Math.floor(Date.now() / 1000));
}
async function tx(p, msg, onOk) {
  try { toast(msg + "…"); const t = await p; await t.wait(); toast(msg + " ✓"); if (onOk) onOk(); await refresh(); }
  catch (e) { console.error(e); toast((e.shortMessage || e.message || "Transaction failed").slice(0, 90)); }
}
function parseAmt() { const v = $("amt").value.trim(); if (!v || isNaN(v)) { toast("Enter an amount"); return null; } return ethers.parseUnits(v, DEC); }

/* ---------------- event bindings ---------------- */
$("connect").onclick = connect;
const needWallet = () => toast("Connect your wallet first");
$("heroDeposit").onclick = () => { if (!liveMode) { document.querySelector(".cols").scrollIntoView({ behavior: "smooth", block: "center" }); $("amt").focus(); return; } $("amt").focus(); };
$("heroFaucet").onclick = () => liveMode ? tx(usdc.faucet(), "Claiming faucet") : toast("Demo mode — faucet is live once contracts are wired.");
$("faucetBtn").onclick = () => liveMode ? tx(usdc.faucet(), "Claiming faucet") : toast("Demo mode — faucet is live once contracts are wired.");
$("maxBtn").onclick = async () => { if (!liveMode) { $("amt").value = "6000"; return; } const b = await usdc.balanceOf(account); $("amt").value = ethers.formatUnits(b, DEC); };
document.querySelectorAll(".preset button").forEach(b => b.onclick = () => { $("amt").value = b.dataset.v; });

$("depositBtn").onclick = async () => {
  if (!liveMode) { toast("Demo mode — connect a wallet to deposit on testnet."); return; }
  const a = parseAmt(); if (!a) return;
  const allow = await usdc.allowance(account, cfg.contracts.DrawPool); if (allow < a) await tx(usdc.approve(cfg.contracts.DrawPool, a), "Approving");
  await tx(pool.deposit(a), "Depositing", () => { $("amt").value = ""; });
};
$("withdrawBtn").onclick = () => { if (!liveMode) { toast("Demo mode — connect a wallet to withdraw."); return; } const a = parseAmt(); if (!a) return; tx(pool.withdraw(a), "Withdrawing", () => { $("amt").value = ""; }); };

$("startBtn").onclick = () => {
  if (liveMode) return tx(pool.startDraw(), "Starting draw");
  commitPhase();
};
$("awardBtn").onclick = () => {
  if (liveMode) return tx(pool.award(), "Awarding prize", () => confetti());
  awardPhase([...demo.participants].sort((a, b) => b.bal - a.bal));
};

/* ---------------- boot ---------------- */
renderDemo();
window.addEventListener("load", () => setTimeout(bootFallbackTweaks, 1500), { once: true });
if (window.ethereum && cfg && ABIS) { window.ethereum.on?.("accountsChanged", () => location.reload()); window.ethereum.on?.("chainChanged", () => location.reload()); }
addEventListener("resize", () => { const c = $("confetti"); c.width = innerWidth; c.height = innerHeight; });
