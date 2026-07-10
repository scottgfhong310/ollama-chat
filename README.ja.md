# ollama-chat

> 版本 v1.0｜最後更新 2026-07-11

[English](README.md) | [繁體中文](README.zh-Hant.md) | [日本語]

ローカル [Ollama](https://ollama.com) モデルのためのフルビューポート Web チャット UI。
**project（フォルダ）→ subject（1 会話＝1 JSON ファイル）→ プロンプト索引** で会話を整理します。
ストリーミング返信、markdown レンダリング（marked + DOMPurify）、3 言語 UI（zh-Hant / en / ja）、
light/dark テーマ。軽量 Express バックエンド（Ollama プロキシ＋会話ストレージ）。
[nodeapp WebApp ファミリー](https://github.com/scottgfhong310/nodeapp-webapp-family)の一員です。

GitHub Pages には非対応（Node バックエンドが必要）。

## 機能

- **ストリーミングチャット**：インストール済みの任意の Ollama モデル（サイズ付きモデル選択；停止ボタンは Ollama 側まで生成を中止）。
- **project / subject ライブラリ**：1 会話＝1 JSON ファイル（`chats/<project>/<subject>.json`）——プレーンファイルのみ、DB もレジストリも不要。
- **プロンプト索引**：subject 内のすべてのユーザー発言をスライドインパネルに一覧表示；クリックでそのやり取りへスクロール。
- **自動命名**：subject を開かずに入力すると、最初の一文から命名され `inbox` に保存。
- **Markdown 返信**：fenced code にコピーボタン付き；データ内容は翻訳・改変しない。
- **名前変更／移動**：サイドレールから subject の改名や別 project への移動（名前＝パス；移動先が既存の場合は拒否、上書きしない）。
- **エクスポート**：任意の subject を Markdown（`<subject>-yyyyMMddHHmmss.md`）に。
- **ディープリンク**：`?project=<p>&subject=<s>` で会話を直接開く。
- 3 言語 i18n、CSS 変数テーマ（デフォルト dark）、ファミリー共通サイドツールレール。

## インストールと実行

```bash
npm install
cp .env.example .env        # Ollama が別マシンの場合は OLLAMA_BASE_URL を変更
node app.js                 # → http://localhost:3000/apps/ollama-chat/
```

Node.js ≥ 18 と起動中の Ollama（`ollama serve`）、および 1 つ以上の pull 済みモデルが必要です。

## 構成

```
app.js                          # Express エントリ：port 3000；/ → 302 /apps/ollama-chat/
routes/ollama-chat.js           # Ollama プロキシ＋会話ストレージ API
public/apps/ollama-chat/        # フロントエンド（/apps/ollama-chat/ で提供）
├─ index.html · ollama-chat.css · ollama-chat.js · ollama-chat-lib.js
├─ materialize-dark.css · side-tool.css · thinking-dot.css   # ファミリー共有アセット
├─ i18n.js · locales/{zh-Hant,en,ja}.js
public/upload/ollama-chat/chats/    # 会話データ（コミットしない）
```

## API

| Method | Path | 説明 |
|---|---|---|
| GET | `/api/ollama-chat/models` | Ollama `/api/tags` のプロキシ → `{ ok, models }` |
| POST | `/api/ollama-chat/chat` | Ollama `/api/chat` のプロキシ（NDJSON ストリームをそのまま通過；エラー時は `{ ok:false, error }`） |
| GET | `/api/ollama-chat/tree` | `chats/` をスキャン → `{ ok, projects: [{ name, subjects }] }` |
| GET | `/api/ollama-chat/subject?project=&name=` | subject を 1 件読む → `{ ok, chat }` |
| POST | `/api/ollama-chat/subject` | `{ project, name, chat }`——ファイル全体を上書き保存 |
| POST | `/api/ollama-chat/rename` | `{ project, name, newProject, newName }`——名前変更／別 project へ移動（移動先が存在する場合は 409） |
| POST | `/api/ollama-chat/delete` | `{ project, name }`——ファイルを `chats/.bak/` へ移動 |

成功時の `/chat` ストリーム（Ollama の NDJSON をそのまま通す）を除き、
すべてのエンドポイントはファミリー共通の `{ ok }` エンベロープを使用します。

## データ構造

```jsonc
// chats/<project>/<subject>.json — 1 会話
{
  "model": "qwen2.5:latest",        // 最後に使用したモデル
  "createdAt": "20260711000000",    // yyyyMMddHHmmss（サーバーで正規化）
  "updatedAt": "20260711000102",    // 保存のたびにサーバーが刻印
  "messages": [
    { "role": "user",      "content": "…", "ts": "20260711000000" },
    { "role": "assistant", "content": "…", "ts": "20260711000012", "model": "qwen2.5:latest" }
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
      "subjects": [
        { "name": "…", "updatedAt": "20260711000102", "model": "qwen2.5:latest", "messageCount": 4 }
      ]
    }
  ]
}
```

## コアライブラリ（`OllamaChatLib`）

純ロジック・DOM 非依存（`window.OllamaChatLib`、依存ゼロ）：

```js
const chat = OllamaChatLib.newChat('qwen2.5:latest');
chat.messages.push(OllamaChatLib.userMessage('こんにちは'));
await OllamaChatLib.chatStream({
  model: chat.model,
  messages: chat.messages,
  onChunk: (delta, full) => render(full)
});                                       // → { content, stats, aborted }
OllamaChatLib.promptIndex(chat.messages); // → [{ index, ts, text }]
await OllamaChatLib.saveSubject('inbox', 'hello', chat);
```

## License

[MIT](LICENSE) © 2026 [Scott G.F. Hong](https://github.com/scottgfhong310)
