import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const pager = await ai.models.list();
for await (const m of pager) {
  if (m.supportedActions?.includes('bidiGenerateContent')) {
    console.log(m.name.replace('models/', ''));
  }
}