// Turns the microphone off when nobody has SPOKEN for a while (a mic left on by accident).
// It does not judge sound itself: "speech" is what lib/vad.js already decides (its loudness check with the room-noise
// estimate, and its 500 ms minimum of voiced audio). So there is only one voice detector in the app.
//   - a sound that never becomes a command (a cough, a click, a door) does NOT count as speech
//   - while a command is being spoken, every loud chunk counts, so a long sentence never turns the mic off
//   - short pauses while speaking do not matter: the clock only runs out after this long without speech
//   - while a command is still being processed, the clock is held (counting starts again after it is done)
//   - the clock starts with the first microphone chunk, so a slow permission prompt or start-up is not counted

// Change this one value to change the time limit
export const MIC_IDLE_TIMEOUT_MS = 25000;

export function createMicIdle({ timeoutMs = MIC_IDLE_TIMEOUT_MS, now = () => Date.now() } = {}) {
  let last = 0; // when speech was last heard; 0 = the microphone has not delivered any audio yet
  let confirmed = false; // the command being spoken has passed vad.js's minimum speech

  return {
    // every microphone chunk. busy = a command is waiting or being processed. Returns true when the mic should stop.
    tick(busy = false) {
      const t = now();
      if (!last || busy) {
        last = t;
        return false;
      }
      return t - last >= timeoutMs;
    },
    // vad.js onSpeechConfirmed: real speech (not a short noise)
    speechConfirmed() {
      confirmed = true;
      last = now();
    },
    // vad.js onSegmentChunk: a loud chunk of a command that is real speech
    chunk(loud) {
      if (confirmed && loud) last = now();
    },
    // vad.js onSegmentEnd: sent = it was a command (not a short noise)
    segmentEnd(sent) {
      if (sent) last = now();
      confirmed = false;
    },
  };
}
