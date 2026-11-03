// Lets the user choose the reading voice and speed. The first voice in the list is the recommended one.
export default function VoiceSettings({ voices, voiceName, onVoice, rate, onRate }) {
  if (!voices.length) return null;
  return (
    <div className="voice-settings">
      <label>
        Reading voice
        <select value={voiceName} onChange={(e) => onVoice(e.target.value)}>
          {voices.map((v, i) => (
            <option key={v.name} value={v.name}>
              {i === 0 ? '★ ' : ''}{v.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Speed
        <select value={rate} onChange={(e) => onRate(Number(e.target.value))}>
          <option value={0.85}>Slow</option>
          <option value={0.95}>Normal</option>
          <option value={1.1}>Fast</option>
        </select>
      </label>
    </div>
  );
}