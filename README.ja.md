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
- **プロンプトのテンプレート**：会話をまたぐグローバルなテンプレート集（単一の `prompts.json`）——現在の入力を保存、クリックで入力欄のカーソル位置に挿入、削除はバックアップ付き。
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
| GET | `/api/ollama-chat/prompts` | テンプレート集を読む → `{ ok, prompts }` |
| POST | `/api/ollama-chat/prompts` | `{ prompts: [...] }`——リスト全体を上書き（上書き前に旧ファイルをバックアップ） |

成功時の `/chat` ストリーム（Ollama の NDJSON をそのまま通す）を除き、
すべてのエンドポイントはファミリー共通の `{ ok }` エンベロープを使用します。

## データ構造

```jsonc
// chats/<project>/<subject>.json — 1 会話。
// messages[] は 1 件＝1 turn（リクエストとその応答のペア）——配列位置ではなく uid で連結。
// serial は作成時に一度だけ割り当てられ、以後リナンバーされない。前の turn を隠しても
// エクスポートや参照の番号は安定して保たれる。
{
  "model": "qwen2.5:latest",        // 最後に使用したモデル
  "createdAt": "20260711000000",    // yyyyMMddHHmmss（サーバーで正規化）
  "updatedAt": "20260711000102",    // 保存のたびにサーバーが刻印
  "messages": [
    {
      "uid": "b3f1...",              // 安定 id——request↔response のペアキー、DOM のアンカーにも使用
      "serial": 1,                   // 1 始まり、作成時に一度だけ割り当て・再利用/再採番なし
      "role": "user",
      "content": "…",
      "ts": "20260711000000",
      "hidden": true,                // 任意項目、true のときのみ存在——下記「プロンプトの非表示」参照
      "response": {                  // 応答待ち、または中断で内容が空のときは null
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

### プロンプトの非表示

どの turn もプロンプト一覧パネルから非表示にできる——非表示にすると、その turn（リクエストと
応答の両方）はメイン会話画面からも同時に消える。データ自体はファイルに残るが、**次回以降
Ollama に送るコンテキストにも Markdown エクスポートにも含まれない**——つまり「非表示」は
見た目を隠すだけでなく、そのやり取りがなかったことにする、という意味になる。

```jsonc
// prompts.json — グローバルなプロンプトテンプレート集
{
  "prompts": [
    { "content": "以下を日本語に翻訳してください：\n\n", "ts": "20260711073309", "title": "任意の表示名" }
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
        { "name": "…", "updatedAt": "20260711000102", "model": "qwen2.5:latest", "turnCount": 4 }
      ]
    }
  ]
}
```

## コアライブラリ（`OllamaChatLib`）

純ロジック・DOM 非依存（`window.OllamaChatLib`、依存ゼロ）：

```js
const chat = OllamaChatLib.newChat('qwen2.5:latest');
const turn = OllamaChatLib.newTurn('こんにちは', chat.messages.length + 1);
chat.messages.push(turn);
await OllamaChatLib.chatStream({
  model: chat.model,
  messages: OllamaChatLib.flattenForApi(chat.messages),   // turns → フラットな [{role,content}]（Ollama 用）
  onChunk: (delta, full) => render(full)
});                                       // → { content, stats, aborted }
turn.response = OllamaChatLib.newResponse('こんにちは！', chat.model);
OllamaChatLib.promptIndex(chat.messages); // → [{ uid, serial, ts, text, hidden }]
await OllamaChatLib.saveSubject('inbox', 'hello', chat);
```

## License

[MIT](LICENSE) © 2026 [Scott G.F. Hong](https://github.com/scottgfhong310)
