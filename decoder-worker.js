// Décodage H.264 par la puce graphique (WebCodecs) + dessin immédiat dans un OffscreenCanvas.
// Différences avec le lecteur du T2C : faible latence activée, vraies images clés / delta,
// canvas redimensionné seulement quand la résolution change, codec lu dans le flux.
let canvas = null, ctx = null, decoder = null, codec = null;
let waitingKey = true, ts = 0;
let stats = { decoded: 0, dropped: 0, lastDecodeMs: 0, w: 0, h: 0, hw: '?', codec: '' };
const inflight = new Map(); // timestamp -> performance.now() à l'entrée

function nalTypes(d) {
  const t = [];
  for (let i = 0; i + 3 < d.length; i++) {
    if (d[i] === 0 && d[i + 1] === 0 && (d[i + 2] === 1 || (d[i + 2] === 0 && d[i + 3] === 1))) {
      const s = d[i + 2] === 1 ? i + 3 : i + 4;
      if (s < d.length) t.push({ type: d[s] & 31, at: s });
      i = s;
    }
  }
  return t;
}

function hex(n) { return n.toString(16).padStart(2, '0'); }

async function configure(spsAt, data) {
  const c = 'avc1.' + hex(data[spsAt + 1]) + hex(data[spsAt + 2]) + hex(data[spsAt + 3]);
  if (c === codec && decoder && decoder.state === 'configured') return;
  if (decoder) try { decoder.close(); } catch {}
  codec = c; stats.codec = c;
  decoder = new VideoDecoder({ output: onFrame, error: (e) => { postMessage({ log: 'Erreur décodeur : ' + e.message }); waitingKey = true; codec = null; } });
  const base = { codec: c, optimizeForLatency: true };
  let cfg = { ...base, hardwareAcceleration: 'prefer-hardware' };
  try {
    const s = await VideoDecoder.isConfigSupported(cfg);
    if (!s.supported) { cfg = base; stats.hw = 'non (logiciel)'; } else stats.hw = 'oui';
  } catch { cfg = base; stats.hw = 'inconnu'; }
  decoder.configure(cfg);
  postMessage({ log: `Décodeur prêt : ${c}, matériel ${stats.hw}` });
}

function onFrame(frame) {
  const t0 = inflight.get(frame.timestamp);
  inflight.delete(frame.timestamp);
  if (t0 !== undefined) stats.lastDecodeMs = performance.now() - t0;
  const w = frame.displayWidth, h = frame.displayHeight;
  if (w !== canvas.width || h !== canvas.height) {
    canvas.width = w; canvas.height = h; stats.w = w; stats.h = h;
    postMessage({ size: { w, h } });
  }
  ctx.drawImage(frame, 0, 0);
  frame.close();
  stats.decoded++;
}

async function decode(data) {
  const nals = nalTypes(data);
  const sps = nals.find((n) => n.type === 7);
  const isKey = nals.some((n) => n.type === 5 || n.type === 7);
  if (sps) await configure(sps.at, data);
  if (waitingKey) {
    if (!isKey) { stats.dropped++; postMessage({ needKey: true }); return; }
    waitingKey = false;
  }
  if (!decoder || decoder.state !== 'configured') return;
  // Le décodeur prend du retard : on jette les images intermédiaires jusqu'à la prochaine clé.
  if (decoder.decodeQueueSize > 3 && !isKey) { stats.dropped++; waitingKey = true; postMessage({ needKey: true }); return; }
  ts += 16667;
  inflight.set(ts, performance.now());
  if (inflight.size > 60) inflight.delete(inflight.keys().next().value);
  decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: ts, data }));
}

// Les images passent une par une, dans l'ordre, même pendant la (re)configuration du décodeur.
let chain = Promise.resolve();
onmessage = (e) => {
  const m = e.data;
  if (m.canvas) { canvas = m.canvas; ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }); }
  else if (m.data) chain = chain.then(() => decode(m.data)).catch((err) => postMessage({ log: 'Décodage : ' + err.message }));
  else if (m.reset) { waitingKey = true; if (ctx) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height); } }
};
setInterval(() => { postMessage({ stats: { ...stats, queue: decoder ? decoder.decodeQueueSize : 0 } }); stats.decoded = 0; stats.dropped = 0; }, 1000);
