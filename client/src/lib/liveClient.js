import { GoogleGenAI, Modality } from '@google/genai';
import { editTextDecl, buildPrompt, todayString } from './tools';

export async function startLive({ outline, onEdit, onTranscript, onModelText, onClose, onError }) {
  const res = await fetch('/api/token', { method: 'POST' });
  if (!res.ok) throw new Error('Token server error. Is the server running on port 3001?');
  const { token } = await res.json();

  const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });
  let session;
  let closed = false;

  session = await ai.live.connect({
    model: import.meta.env.VITE_LIVE_MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      outputAudioTranscription: {},
      inputAudioTranscription: {},
      systemInstruction: buildPrompt(outline, todayString()),
      tools: [{ functionDeclarations: [editTextDecl] }],
    },
    callbacks: {
      onopen: () => console.log('Live session open'),
      onmessage: (msg) => {
        const heard = msg.serverContent?.inputTranscription?.text;
        if (heard) onTranscript(heard);

        if (msg.toolCall?.functionCalls?.length) {
          const functionResponses = msg.toolCall.functionCalls.map((fc) => ({
            id: fc.id,
            name: fc.name,
            response: onEdit(fc.args || {}),
          }));
          session.sendToolResponse({ functionResponses });
        }

        const said = msg.serverContent?.outputTranscription?.text;
        if (said) onModelText(said);
      },
      onerror: (e) => { console.error('Live error:', e); onError?.(e); },
      onclose: (e) => { closed = true; console.warn('Live closed:', e?.code, e?.reason); onClose?.(e); },
    },
  });

  return {
    sendAudio: (b64) => {
      if (closed) return;
      session.sendRealtimeInput({ audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } });
    },
    endAudio: () => !closed && session.sendRealtimeInput({ audioStreamEnd: true }),
    close: () => !closed && session.close(),
  };
}
