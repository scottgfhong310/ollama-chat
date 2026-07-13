# ollama-chat

> 版本 v1.3｜最後更新 2026-07-13

[English] | [繁體中文](README.zh-Hant.md) | [日本語](README.ja.md)

A full-viewport web chat UI for local [Ollama](https://ollama.com) models, organised as
**project (folder) → subject (one conversation = one JSON file) → prompt index**.
Streaming replies, markdown rendering (marked + DOMPurify), trilingual UI (zh-Hant / en / ja),
light/dark theme. Lightweight Express backend (Ollama proxy + conversation storage).
Part of the [nodeapp WebApp family](https://github.com/scottgfhong310/nodeapp-webapp-family).

Not compatible with GitHub Pages (requires the Node backend).

## Features

- **Streaming chat** with any locally installed Ollama model (model picker with sizes; stop button aborts generation all the way up to Ollama).
- **Project / subject library**: every conversation is one JSON file under `chats/<project>/<subject>.json` — plain files, no database, no registry to drift. Both project and subject have a stable `uid`, stored in a marker/JSON file alongside them. A collapse-all button sits next to the library header (expanding is still a per-project action).
- **Prompt index**: every user prompt in a subject is listed in a slide-in panel; clicking one scrolls to that exchange.
- **Prompt templates**: a global, cross-conversation template library (single `prompts.json`); save the current input as a template, click a template to insert it at the input cursor, delete with backup.
- **Auto-naming**: typing without opening a subject creates one named from your first prompt, stored under `inbox`. In the "New chat" dialog, the Subject field can also be left blank — once you send the first message, Ollama generates a short title in the background and the conversation is renamed to it.
- **Markdown replies** with fenced-code copy buttons; user content is never translated or altered.
- **Rename / move**: retitle a subject or move it to another project from the side rail (name = path; refuses to overwrite an existing target).
- **Export** any subject as Markdown (`<subject>-yyyyMMddHHmmss.md`).
- **Deep links**: `?uid=<subject uid>` opens a conversation directly and stays valid across
  renames/moves; the legacy `?project=<p>&subject=<s>` form still opens and auto-upgrades to `?uid=`.
- i18n (zh-Hant / en / ja), CSS-variable theming (default dark), family side-tool rail.

## Install & run

```bash
npm install
cp .env.example .env        # adjust OLLAMA_BASE_URL if Ollama runs elsewhere
node app.js                 # → http://localhost:3000/apps/ollama-chat/
```

Requires Node.js ≥ 18 and a running Ollama (`ollama serve`) with at least one model pulled.

## Layout

```
app.js                          # Express entry: port 3000; / → 302 /apps/ollama-chat/
routes/ollama-chat.js           # Ollama proxy + conversation storage API
public/apps/ollama-chat/        # frontend (served at /apps/ollama-chat/)
├─ index.html · ollama-chat.css · ollama-chat.js · ollama-chat-lib.js
├─ materialize-dark.css · side-tool.css · thinking-dot.css   # family shared assets
├─ i18n.js · locales/{zh-Hant,en,ja}.js
public/upload/ollama-chat/chats/    # conversations (not committed)
```

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/ollama-chat/models` | Proxy of Ollama `/api/tags` → `{ ok, models }` |
| POST | `/api/ollama-chat/chat` | Proxy of Ollama `/api/chat` (streaming NDJSON pass-through; errors return `{ ok:false, error }`) |
| POST | `/api/ollama-chat/title` | `{ model, prompt }` — non-streaming call that generates a short conversation title → `{ ok, title }` (20s timeout) |
| GET | `/api/ollama-chat/tree` | Scan `chats/` → `{ ok, projects: [{ name, uid, subjects }] }` |
| GET | `/api/ollama-chat/subject?project=&name=` | Read one subject → `{ ok, chat, project, name }` |
| GET | `/api/ollama-chat/subject?uid=` | Locate a subject by uid (immune to rename/move) → `{ ok, chat, project, name }` |
| POST | `/api/ollama-chat/subject` | `{ project, name, chat }` — write (overwrite) one subject |
| POST | `/api/ollama-chat/rename` | `{ project, name, newProject, newName }` — rename / move to another project (409 if target exists) |
| POST | `/api/ollama-chat/delete` | `{ project, name }` — move the file to `chats/.bak/` |
| GET | `/api/ollama-chat/prompts` | Read the template library → `{ ok, prompts }` |
| POST | `/api/ollama-chat/prompts` | `{ prompts: [...] }` — overwrite the whole list (backs up the old file first) |

All endpoints use the family `{ ok }` envelope except the successful `/chat` stream,
which passes Ollama's NDJSON chunks through verbatim.

## Data structures

```jsonc
// chats/<project>/<subject>.json — one conversation.
// messages[] holds one entry per turn — a request paired with its (optional) response,
// linked by uid rather than by array position. serial is assigned once, at creation, and
// never renumbered, so exports/citations stay stable even if earlier turns are later hidden.
{
  "uid": "a37a1b05-...",             // stable conversation id (rename-stable); ?uid= deep links use it
  "model": "qwen2.5:latest",        // last used model
  "createdAt": "20260711000000",    // yyyyMMddHHmmss (server-normalised)
  "updatedAt": "20260711000102",    // stamped by the server on every save
  "messages": [
    {
      "uid": "b3f1...",              // stable id — the request↔response pairing key, and the DOM anchor
      "serial": 1,                   // 1-based, assigned once, never reused/renumbered
      "role": "user",
      "content": "…",
      "ts": "20260711000000",
      "hidden": true,                // optional; only present when true — see "Prompt visibility" below
      "response": {                  // null while awaiting a reply, or if generation was aborted with no output
        "uid": "9c2a...",
        "role": "assistant",
        "content": "…",
        "ts": "20260711000012",
        "model": "qwen2.5:latest"
      }
    }
  ]
}
```

### Prompt visibility

Any turn can be hidden from the prompt-list panel — hiding also collapses that turn (both the
request and its reply) out of the main chat view; it still exists in the file and is excluded
from the context sent to Ollama on the next turn and from Markdown export, i.e. "hidden" means
the exchange is treated as if it never happened, not just visually tucked away.

```jsonc
// prompts.json — global prompt template library
{
  "prompts": [
    { "content": "Translate the following into …\n\n", "ts": "20260711073309", "title": "optional display name" }
  ]
}
```

```jsonc
// GET /api/ollama-chat/tree →
{
  "ok": true,
  "projects": [
    {
      "name": "inbox",
      "uid": "988b699d-...",           // stable project id (marker file chats/inbox/.project.json); data model only, no deep link yet
      "subjects": [
        { "name": "…", "updatedAt": "20260711000102", "model": "qwen2.5:latest", "turnCount": 4 }
      ]
    }
  ]
}
```

## Core library (`OllamaChatLib`)

Pure logic, no DOM (`window.OllamaChatLib`, zero dependencies):

```js
const chat = OllamaChatLib.newChat('qwen2.5:latest');
const turn = OllamaChatLib.newTurn('Hello', chat.messages.length + 1);
chat.messages.push(turn);
await OllamaChatLib.chatStream({
  model: chat.model,
  messages: OllamaChatLib.flattenForApi(chat.messages),   // turns → flat [{role,content}] for Ollama
  onChunk: (delta, full) => render(full)
});                                       // → { content, stats, aborted }
turn.response = OllamaChatLib.newResponse('Hi there!', chat.model);
OllamaChatLib.promptIndex(chat.messages); // → [{ uid, serial, ts, text, hidden }]
await OllamaChatLib.saveSubject('inbox', 'hello', chat);
```

## License

[MIT](LICENSE) © 2026 [Scott G.F. Hong](https://github.com/scottgfhong310)
