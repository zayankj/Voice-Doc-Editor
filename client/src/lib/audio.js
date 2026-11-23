// Captures the mic as 16 kHz mono PCM. onChunk(base64Pcm, loudness) is called about 8 times a second.
// Returns a stop() function that is safe to call more than once.
export async function startCapture(onChunk) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  // (Stage 1) the microphone is already on here: if anything below fails, everything is released again (the browser
  // must not keep recording), then the error goes to the caller as before
  let ctx = null;
  let src = null;
  let node = null;
  let mute = null;
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.audioWorklet.addModule('/pcm-worklet.js');

    src = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'pcm-processor');
    mute = ctx.createGain();
    mute.gain.value = 0; // keeps the graph running without echoing the mic
    node.port.onmessage = (e) => onChunk(floatToBase64Pcm(e.data), rmsOf(e.data));
    src.connect(node).connect(mute).connect(ctx.destination);
  } catch (err) {
    try { if (node) node.port.onmessage = null; } catch { /* releasing anyway */ }
    for (const n of [node, src, mute]) { try { n?.disconnect(); } catch { /* releasing anyway */ } }
    stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* releasing anyway */ } });
    try { if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {}); } catch { /* releasing anyway */ }
    throw err;
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    node.port.onmessage = null;
    node.disconnect();
    src.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    if (ctx.state !== 'closed') ctx.close().catch(() => {});
  };
}

function rmsOf(f32) {
  let sum = 0;
  for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
  return Math.sqrt(sum / f32.length);
}

function floatToBase64Pcm(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(i16.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}