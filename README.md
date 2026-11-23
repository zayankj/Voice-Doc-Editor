# Voice Doc Editor

**Voice Doc Editor** is an AI-powered hospital document editing application that helps healthcare professionals create and edit hospital documents using voice commands, text instructions, and file uploads.

The application integrates Google Gemini AI to understand natural-language instructions and perform structured document editing operations.

## Key Features

### AI-Powered Document Editing
- Edit documents using natural-language instructions.
- Add, update, replace, and delete document content.
- Perform targeted edits within specific sections.
- Apply multiple editing operations through a single instruction.

### Voice-Based Editing
- Start and stop microphone recording with a single button.
- Automatically detect speech and process commands.
- Edit documents using spoken instructions.
- Support multilingual voice interactions.
- Read document content aloud.

### Department-Based Templates
- Dedicated templates for different hospital departments.
- Discharge Summary.
- Reception.
- Emergency.
- Structured document fields for different workflows.

### File Uploads
- Upload PDF documents.
- Upload Word documents.
- Attach images for AI-assisted editing.
- Use uploaded documents as context for editing.

### Document Management
- Rich-text editing with TipTap.
- View editing history.
- Highlight modified content.
- Undo and redo changes.
- Confirmation before removing existing medicines.
- Protection against outdated AI responses when documents change during processing.

## Technology Stack

| Layer | Technologies |
|---|---|
| Frontend | React 18, Vite, JavaScript |
| Rich Text Editor | TipTap |
| Backend | Node.js |
| AI Integration | Google Gemini API |
| Gateway | Node.js |
| Testing | Automated unit and browser tests |

## Project Structure

```text
voice-doc-editor/
│
├── .claude/
│
├── client/
│   ├── src/
│   ├── tests/
│   ├── public/
│   └── package.json
│
├── gateway/
│   ├── src/
│   ├── tests/
│   └── package.json
│
├── server/
│   ├── src/
│   ├── tests/
│   └── package.json
│
├── .gitignore
└── README.md
```

### Application Components

**1. Client**

Responsible for the frontend interface, document editing, voice recording, file uploads, templates, and document history.

**2. Gateway**

Acts as a security layer between the frontend and backend. Handles request validation, access checks, and rate limiting.

**3. Server**

Handles AI integration, Gemini requests, instruction processing, structured editing operations, and document-related backend functionality.

## Installation and Setup

### Prerequisites

- Node.js
- npm
- Git
- Google Gemini API key

### 1. Clone the Repository

```bash
git clone YOUR_REPOSITORY_URL
cd voice-doc-editor
```

### 2. Install Dependencies

Install dependencies separately for each component.

**Client**
```bash
cd client
npm install
```

**Gateway**
```bash
cd ../gateway
npm install
```

**Server**
```bash
cd ../server
npm install
```

### 3. Configure Environment Variables

Create the required `.env` files in the appropriate directories.

Configure the environment variables required by your application, including:

- Gemini API credentials.
- Gateway access credentials.
- Backend configuration.
- Client API endpoint.
- Voice model configuration.

Refer to the existing environment configuration and project setup.

**Security:** Never commit API keys, access keys, or other sensitive credentials to the repository.

## Running the Application

Run each component in a separate terminal.

**Terminal 1 – Server**
```bash
cd server
npm run dev
```

**Terminal 2 – Gateway**
```bash
cd gateway
npm run dev
```

**Terminal 3 – Client**
```bash
cd client
npm run dev
```

Open the local URL provided by Vite in your browser.

> Use the actual npm scripts configured in each component's `package.json`.

## How It Works

1. The user opens the application and selects a hospital document or department template.
2. The user provides an instruction through voice, text, or an uploaded file.
3. The client sends the request through the Gateway.
4. The backend communicates with Gemini AI to understand the instruction.
5. Gemini returns structured document-editing operations.
6. The application validates and applies the operations.
7. Changes are highlighted and recorded in the editing history.
8. Users can review changes and use Undo or Redo when needed.

## Testing

Run tests using the scripts configured in each component's `package.json`.

```bash
npm test
```

To create a production build of the frontend:

```bash
cd client
npm run build
```

## Security and Data Protection

- Store API keys and credentials in environment variables.
- Keep backend secrets out of frontend code.
- Validate incoming requests through the Gateway.
- Apply request validation and rate limiting.
- Avoid logging sensitive patient information.
- Use dummy patient data during development and testing.

## Important Notice

This application is designed to assist hospital staff with document creation and editing. AI-generated changes must be reviewed by authorized healthcare professionals before being used in official patient records.

The application does not replace clinical judgment or professional medical review.

## License

License information to be added.