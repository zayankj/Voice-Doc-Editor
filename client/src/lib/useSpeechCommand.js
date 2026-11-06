import { useRef, useState, useCallback } from 'react';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export function useSpeechCommand({ lang = 'en-IN', onResult, onError }) {
  const recRef = useRef(null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const supported = Boolean(SR);

  const start = useCallback(() => {
    if (!SR || recRef.current) return;
    const rec = new SR();
    rec.lang = lang;            // 'en-IN', 'hi-IN', 'kn-IN', 'ur-IN' ...
    rec.continuous = false;     // stops by itself after one sentence
    rec.interimResults = true;  // shows live text while speaking
    rec.maxAlternatives = 1;

    let finalText = '';
    rec.onresult = (e) => {
      let interimText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interimText += t;
      }
      setInterim(finalText + interimText);
    };
    rec.onerror = (e) => {
      // 'no-speech' and 'aborted' are normal, not real errors
      if (e.error !== 'no-speech' && e.error !== 'aborted') onError?.(e.error);
    };
    rec.onend = () => {
      recRef.current = null;
      setListening(false);
      setInterim('');
      const text = finalText.trim();
      if (text.length >= 3) onResult?.(text);   // ignore noise / empty results
    };

    recRef.current = rec;
    setListening(true);
    rec.start();
  }, [lang, onResult, onError]);

  const stop = useCallback(() => recRef.current?.stop(), []);

  return { supported, listening, interim, start, stop };
}