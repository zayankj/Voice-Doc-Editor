// Turns the 16 kHz microphone chunks (base64 PCM) into one WAV file (base64) that the model can listen to.
const SAMPLE_RATE = 16000;

const b64ToBytes = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const bytesToB64 = (bytes) => {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  return btoa(bin);
};

// Returns { base64, seconds }
export function pcmChunksToWav(chunks) {
  const parts = chunks.map(b64ToBytes);
  const dataLen = parts.reduce((n, p) => n + p.length, 0);

  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  write(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true); // size of this block
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per sample
  view.setUint16(34, 16, true); // bits per sample
  write(36, 'data');
  view.setUint32(40, dataLen, true);

  const bytes = new Uint8Array(buf);
  let offset = 44;
  for (const p of parts) {
    bytes.set(p, offset);
    offset += p.length;
  }

  return { base64: bytesToB64(bytes), seconds: dataLen / (SAMPLE_RATE * 2) };
}