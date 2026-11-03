// Captures the mic as 16 kHz mono PCM, returns a stop() function.
export async function startCapture(onChunk) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule('/pcm-worklet.js');

  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-processor');
  const mute = ctx.createGain();
  mute.gain.value = 0; // keeps the graph running without echoing the mic
  node.port.onmessage = (e) => onChunk(floatToBase64Pcm(e.data));
  src.connect(node).connect(mute).connect(ctx.destination);

  return () => {
    node.disconnect();
    src.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    ctx.close();
  };
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
