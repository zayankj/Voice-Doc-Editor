# Voice Doc Editor (Word-style)

1. Server:  cd server && cp .env.example .env (add GEMINI_API_KEY) && npm i && npm start
2. Client:  cd client && cp .env.example .env (set VITE_LIVE_MODEL) && npm i && npm run dev
3. Open http://localhost:5173 -> "Open .docx" -> tap the mic -> say e.g. "change the discharge date to today's date"
