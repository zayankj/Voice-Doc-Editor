import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';

const app = express();
app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { apiVersion: 'v1alpha' },
});

// Issues a short-lived, single-use token so the real API key never reaches the browser.
app.post('/api/token', async (_req, res) => {
  try {
    const now = Date.now();
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
      },
    });
    res.json({ token: token.name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not create token' });
  }
});

app.listen(process.env.PORT || 3001, () => console.log('Token server running'));
