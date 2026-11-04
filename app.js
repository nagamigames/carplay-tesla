// Page d'affichage CarPlay v0 — parle au T2C avec son propre protocole (relevé dans son main.js).
// Messages du boîtier : en-tête Uint32 [taille, type] puis données.
//   1 = état complet (JSON), 3 = état de la liaison (JSON), 100 = image H.264 entière,
//   101/102/103 = image H.264 en morceaux (début / milieu / fin).
// Messages vers le boîtier : Int16 [taille des données, commande, ...].
const Q = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const canvas = $('screen');
let ws = null, worker = null, link = -1, frag = null, fragOff = 0, ping = 0, pong = 0;
let frameSize = { w: 0, h: 0 }, configSent = false, lastKeyAsk = 0;
const net = { frames: 0, bytes: 0, gapMax: 0, last: 0 };
let dec = {};
const phone = { bt: undefined, seen: undefined };

function log(s) {
  const d = document.createElement('div');
  d.textContent = new Date().toLocaleTimeString() + '  ' + s;
  $('log').prepend(d);
  while ($('log').childElementCount > 40) $('log').lastChild.remove();
  console.log(s);
}
function status(a, b = '') { $('st1').textContent = a; $('st2').textContent = b; $('status').style.display = a ? 'grid' : 'none'; }

function i16(...v) { return new Int16Array(v).buffer; }
function send(buf) { if (ws && ws.readyState === 1) ws.send(buf); }
const cmd = (c) => send(i16(2, 3, c));          // 0 = démarrer la vidéo, 8 = demander une image clé
const setting = (k, v) => send(i16(4, 7, k, v)); // 11 = mode (1 vidéo), 9 = fps (1 rapide), 2 = résolution

// Taille demandée au boîtier : celle de la zone d'affichage réelle (surchargeable : ?w=1183&h=920).
function wantedSize() {
  const k = Q.get('scale') === 'dpr' ? devicePixelRatio : 1;
  return { w: Number(Q.get('w')) || Math.round(innerWidth * k), h: Number(Q.get('h')) || Math.round(innerHeight * k) };
}

function hello() {
  const { w, h } = wantedSize();
  const lang = (navigator.language || 'fr').slice(0, 10);
  const ua = navigator.userAgent, i = ua.indexOf('Tesla'), tesla = i > 0 ? ua.slice(i) : 'null';
  const enc = new TextEncoder(), a = enc.encode(lang), b = enc.encode(tesla);
  const out = new Uint8Array(8 + a.length + 1 + b.length + 1);
  out.set(new Uint8Array(i16(a.length + b.length + 6, 2, w, h)), 0);
  out.set(a, 8); out.set(b, 8 + a.length + 1);
  send(out.buffer);
  sentSize = { w, h };
  log(`Bonjour envoyé : zone ${w}×${h}`);
}

function setLink(l) {
  if (l === link) return;
  log(`Liaison : ${link} → ${l}`);
  link = l;
  if (l > 1) { cmd(0); status(''); canvas.style.display = 'block'; worker.postMessage({ reset: true }); }
  else { canvas.style.display = 'none'; status(l === 1 ? 'iPhone détecté…' : 'En attente de l\'iPhone', 'Bluetooth de l\'iPhone allumé, près du boîtier'); }
}

function onJson(type, j) {
  if (type === 1) {
    log(`État : mode ${j.vid ? 'vidéo' : 'images'}, fps ${j.fps}, résolution ${j.pixel}, liaison ${j.link}, firmware ${j.SW || '?'}`);
    if (!configSent) {
      configSent = true;
      if (!j.vid) { log('→ passage en mode vidéo'); setting(11, 1); }
      if (j.fps === 0) { log('→ fréquence rapide'); setting(9, 1); }
    }
    if (typeof j.link === 'number') setLink(j.link);
  } else if (type === 3) {
    if (typeof j.link === 'number') setLink(j.link);
  } else if (type === 0 || type === 4) {
    if (j.pong !== undefined) pong = j.pong;
  }
  if ('bt' in j && j.bt !== phone.bt) { phone.bt = j.bt; log(`Bluetooth iPhone : ${j.bt ? 'connecté' : 'aucun'}`); }
  if ('phone' in j) phone.seen = j.phone;
}

function pushFrame(u8) {
  const now = performance.now();
  if (net.last) net.gapMax = Math.max(net.gapMax, now - net.last);
  net.last = now; net.frames++; net.bytes += u8.length;
  // Réaction : temps entre un appui et la première image qui arrive ensuite (aller-retour complet
  // page → boîtier → iPhone → boîtier → page). Fiable sur un écran immobile (accueil CarPlay).
  if (tapAt) { reactions.push(now - tapAt); if (reactions.length > 10) reactions.shift(); tapAt = 0; }
  worker.postMessage({ data: u8 }, [u8.buffer]);
}

function onMessage(ev) {
  const buf = ev.data;
  const hdr = new Uint32Array(buf, 0, 2);
  if (hdr[0] !== buf.byteLength - 8) { log('En-tête incohérent, reconnexion'); ws.close(); return; }
  const type = hdr[1], data = buf.slice(8);
  switch (type) {
    case 100: {
      const len = new Uint32Array(data, 0, 1)[0];
      if (len + 4 === data.byteLength) pushFrame(new Uint8Array(data.slice(4)));
      break;
    }
    case 101: {
      const len = new Uint32Array(data, 0, 1)[0];
      if (len > 4e6) { frag = null; break; }
      frag = new Uint8Array(len); frag.set(new Uint8Array(data, 4)); fragOff = data.byteLength - 4;
      break;
    }
    case 102: case 103: {
      if (!frag) break;
      const part = new Uint8Array(data);
      if (fragOff + part.length > frag.length + (type === 103 ? 8 : 0)) { log('Morceau hors limites'); frag = null; break; }
      frag.set(part.subarray(0, Math.min(part.length, frag.length - fragOff)), fragOff);
      fragOff += part.length;
      if (type === 103) { pushFrame(frag); frag = null; }
      break;
    }
    default: {
      if (type <= 5 && data.byteLength) {
        try { onJson(type, JSON.parse(new TextDecoder().decode(data))); } catch { /* données non JSON */ }
      }
    }
  }
}

// Sur le Mac (localhost) : on passe par le relais. Ailleurs (Tesla) : connexion directe au boîtier.
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const BOX = Q.get('box') || '192.168.3.1';
const WS_URL = LOCAL && !Q.has('box') ? `ws://${location.host}/tsl` : `wss://${BOX}/`;
let fails = 0;

function connect() {
  status('Connexion au boîtier…', LOCAL ? 'Le Mac doit être sur le Wi-Fi du T2C' : 'La Tesla doit être sur le Wi-Fi du T2C');
  ws = new WebSocket(WS_URL, 'tsl');
  ws.binaryType = 'arraybuffer';
  // Le navigateur peut rester bloqué sans jamais répondre (certificat, autorisation réseau local) : on coupe après 4 s.
  const sock = ws;
  const guard = setTimeout(() => { if (sock.readyState === 0) { log('Aucune réponse du boîtier en 4 s'); sock.close(); } }, 4000);
  ws.onopen = () => { clearTimeout(guard); fails = 0; $('unlock').hidden = true; log(LOCAL ? 'Relais local OK, appel du boîtier…' : 'Boîtier joint'); configSent = false; hello(); };
  ws.onmessage = onMessage;
  ws.onclose = (e) => {
    clearTimeout(guard);
    fails++;
    log(`Coupé (${e.code}${e.reason ? ' : ' + e.reason : ''}), nouvel essai dans 1 s`);
    setLink(-1);
    // Connexion directe refusée plusieurs fois : le navigateur n'a sans doute pas encore accepté le certificat du boîtier.
    if (!LOCAL && fails >= 2) { status('Le boîtier ne répond pas (essai ' + fails + ')', 'Si c\'est la première fois, autorise son certificat :'); $('unlock').hidden = false; }
    else status('Boîtier injoignable (essai ' + fails + ')', 'Nouvel essai…');
    setTimeout(connect, 1000);
  };
}

// Ping toutes les secondes (format du boîtier : Uint32 [0x000C0004, n]).
setInterval(() => { if (ws && ws.readyState === 1) send(new Uint32Array([786436, ping++]).buffer); }, 1000);

// L'image occupe le maximum de place SANS changer de format.
function fit() {
  if (!frameSize.w) return;
  const s = Math.min(innerWidth / frameSize.w, innerHeight / frameSize.h);
  canvas.style.width = Math.floor(frameSize.w * s) + 'px';
  canvas.style.height = Math.floor(frameSize.h * s) + 'px';
}
// Quand la zone change vraiment de format (plein écran ↔ mode navigateur), on renégocie la taille avec le boîtier.
let sentSize = null, resizeTimer = 0;
addEventListener('resize', () => {
  fit();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const w = wantedSize();
    if (!sentSize || Q.get('w')) return;
    const ratio = (w.w / w.h) / (sentSize.w / sentSize.h);
    if (Math.abs(ratio - 1) > 0.05 || Math.abs(w.w / sentSize.w - 1) > 0.15) {
      log(`Nouveau format ${w.w}×${w.h} → on renégocie avec le boîtier`);
      if (ws) ws.close();
    }
  }, 700);
});

// Toucher : coordonnées 0-1000 sur l'image réellement affichée. 0 appui, 2 glissé, 1 relâché.
// Les glissés sont regroupés : au plus un envoi par image affichée, toujours la position la plus récente
// (une souris envoie 120+ positions/s, de quoi engorger le boîtier et l'iPhone).
let down = false, pendingMove = null, tapAt = 0;
const reactions = [];
function coords(e) {
  const r = canvas.getBoundingClientRect();
  return [Math.round(Math.min(1000, Math.max(0, (e.clientX - r.left) * 1000 / r.width))),
          Math.round(Math.min(1000, Math.max(0, (e.clientY - r.top) * 1000 / r.height)))];
}
function touch(phase, [x, y]) { send(i16(6, 1, phase, x, y)); }
function flushMove() { if (pendingMove) { touch(2, pendingMove); pendingMove = null; } }
(function loop() { flushMove(); requestAnimationFrame(loop); })();
canvas.addEventListener('pointerdown', (e) => { down = true; canvas.setPointerCapture(e.pointerId); touch(0, coords(e)); tapAt = performance.now(); });
canvas.addEventListener('pointermove', (e) => { if (down) pendingMove = coords(e); });
canvas.addEventListener('pointerup', (e) => { if (down) { flushMove(); touch(1, coords(e)); } down = false; });
canvas.addEventListener('pointercancel', (e) => { if (down) { flushMove(); touch(1, coords(e)); } down = false; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

$('hudBtn').onclick = () => document.body.classList.toggle('on');
if (Q.has('debug')) document.body.classList.add('on');

function startWorker() {
  if (!('VideoDecoder' in window)) { status('Ce navigateur ne sait pas décoder la vidéo (WebCodecs absent)', 'Il faut une page sécurisée : https ou localhost'); return false; }
  worker = new Worker('decoder-worker.js');
  const off = canvas.transferControlToOffscreen();
  worker.postMessage({ canvas: off }, [off]);
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.log) log(m.log);
    if (m.size) { frameSize = m.size; fit(); log(`Image reçue : ${m.size.w}×${m.size.h}`); }
    if (m.needKey && performance.now() - lastKeyAsk > 1000) { lastKeyAsk = performance.now(); cmd(8); }
    if (m.stats) dec = m.stats;
  };
  return true;
}

setInterval(() => {
  const want = wantedSize();
  $('hud').textContent =
    `navigateur  Chrome ${(navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1] || '?'}  sécurisé ${isSecureContext ? 'oui' : 'non'}  cible ${WS_URL}\n` +
    `zone page   ${innerWidth}×${innerHeight} (dpr ${devicePixelRatio.toFixed(2)})\n` +
    `demandé     ${want.w}×${want.h}\n` +
    `reçu        ${frameSize.w}×${frameSize.h}  ${dec.codec || ''}\n` +
    `matériel    ${dec.hw || '?'}\n` +
    `images/s    reçues ${net.frames}  affichées ${dec.decoded ?? 0}  jetées ${dec.dropped ?? 0}\n` +
    `débit       ${(net.bytes * 8 / 1e6).toFixed(1)} Mbit/s\n` +
    `décodage    ${(dec.lastDecodeMs ?? 0).toFixed(1)} ms   file ${dec.queue ?? 0}\n` +
    `pire trou   ${net.gapMax.toFixed(0)} ms entre deux images\n` +
    `réaction    dernier ${reactions.length ? reactions.at(-1).toFixed(0) : '–'} ms   médiane ${reactions.length ? [...reactions].sort((a, b) => a - b)[reactions.length >> 1].toFixed(0) : '–'} ms (${reactions.length} appuis)\n` +
    `liaison     ${link}   ping ${ping} / pong ${pong}\n` +
    `iPhone      bluetooth ${phone.bt ? 'connecté' : 'aucun'}`;
  net.frames = 0; net.bytes = 0; net.gapMax = 0;
}, 1000);

if (!LOCAL && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => log('Mémoire hors ligne indisponible : ' + e.message));
if (startWorker()) connect();
