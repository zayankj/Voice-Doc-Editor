// Cuts the continuous microphone stream into separate spoken commands.
// A command starts when you start speaking and ends after a pause.
// Everything runs in the browser: no audio is sent anywhere until a command is finished.

const CHUNK_MS = 128; // one microphone chunk = 2048 samples at 16 kHz

export function createSegmenter({
  silenceMs = 1500, // a pause this long ends a command (shorter = faster, but may cut you off mid-sentence)
  minSpeechMs = 500, // sounds shorter than this are ignored (coughs, clicks)
  maxSegmentMs = 30000, // very long speech is cut after this long
  preRollMs = 400, // audio kept from just before you started speaking, so the first word is not lost
  tailMs = 400, // silence kept at the end of the clip
  minLevel = 0.012, // sounds quieter than this are never speech. Raise it if room noise triggers it, lower it if quiet speech is missed
  onSpeechStart,
  onSegment, // called with the list of audio chunks of one finished command
  // Optional, for voice streaming (lib/voiceStream.js). They only REPORT what happens here; nothing above or below
  // depends on them, so the pause, the tail and the cutting into commands are exactly the same with or without them.
  onSegmentChunk, // (chunk, loud): a chunk was added to the command being spoken (the first ones: see onSpeechStart)
  onSegmentEnd, // ({ kept, sent }): the command ended; kept = how many of its chunks the clip has, sent = onSegment is called
  // (chunks): the command has reached the minimum voiced audio (minSpeechMs) - the SAME count that decides `enough`
  // below, so it is reported exactly for the commands that will be sent (never for a cough or a click). Once per
  // command; chunks = a copy of all its chunks so far (the pre-roll included).
  onSpeechConfirmed,
} = {}) {
  const preRollChunks = Math.ceil(preRollMs / CHUNK_MS);
  const silenceChunks = Math.ceil(silenceMs / CHUNK_MS);
  const minVoiced = Math.ceil(minSpeechMs / CHUNK_MS);
  const maxChunks = Math.ceil(maxSegmentMs / CHUNK_MS);
  const tailChunks = Math.ceil(tailMs / CHUNK_MS);

  let noise = 0.004; // running estimate of the background level of the room
  let speaking = false;
  let preRoll = [];
  let seg = [];
  let voiced = 0;
  let trailingSilent = 0;

  const isLoud = (rms) => rms > Math.max(minLevel, noise * 3);

  function finish() {
    const keep = seg.length - Math.max(0, trailingSilent - tailChunks);
    const clip = seg.slice(0, keep);
    const enough = voiced >= minVoiced;
    speaking = false;
    seg = [];
    voiced = 0;
    trailingSilent = 0;
    preRoll = [];
    onSegmentEnd?.({ kept: clip.length, sent: enough });
    if (enough) onSegment?.(clip);
  }

  return {
    // chunk: base64 audio, rms: loudness of that chunk
    push(chunk, rms) {
      const loud = isLoud(rms);

      if (!speaking) {
        if (!loud) {
          noise = Math.min(0.008, noise * 0.95 + rms * 0.05); // adapt to the room
          preRoll.push(chunk);
          if (preRoll.length > preRollChunks) preRoll.shift();
          return;
        }
        speaking = true;
        seg = [...preRoll, chunk];
        preRoll = [];
        voiced = 1;
        trailingSilent = 0;
        onSpeechStart?.(seg.slice()); // (the chunks the command starts with: the pre-roll and this one; a copy)
        if (voiced === minVoiced) onSpeechConfirmed?.(seg.slice()); // (only when the minimum is a single chunk)
        return;
      }

      seg.push(chunk);
      onSegmentChunk?.(chunk, loud);
      if (loud) {
        voiced++;
        trailingSilent = 0;
        if (voiced === minVoiced) onSpeechConfirmed?.(seg.slice()); // reported once: voiced only ever goes up by 1
      } else {
        trailingSilent++;
      }
      if (trailingSilent >= silenceChunks || seg.length >= maxChunks) finish();
    },

    // Called when the mic is stopped: a command that is still being spoken is sent, not lost
    flush() {
      if (speaking) finish();
    },
  };
}