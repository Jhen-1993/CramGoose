# CramGoose 個人 AI Relay（Cloudflare Worker）

這個 Worker 是 GitHub Pages 版溫書鵝的 AI 安全層。它支援 GPT（OpenAI API）或 Claude（Anthropic API），並把 API Key 保留在 Cloudflare **Secret**；網頁與 GitHub 都不會保存 API Key。

## 需要填的變數

在 `wrangler.jsonc` 或 Cloudflare 的 **Settings → Variables and Secrets** 設定：

| 名稱 | 類型 | GPT 範例 | Claude 範例 |
|---|---|---|---|
| `AI_PROVIDER` | Text | `openai` | `anthropic` |
| `AI_MODEL` | Text | 你的 OpenAI 帳號可用的文字＋圖片模型 | 你的 Anthropic 帳號可用的 Claude 模型 |
| `ALLOWED_ORIGIN` | Text | `https://jhen-1993.github.io` | 同左 |
| `OPENAI_API_KEY` | **Secret** | OpenAI API Key | 不填 |
| `ANTHROPIC_API_KEY` | **Secret** | 不填 | Anthropic API Key |
| `RELAY_ACCESS_TOKEN` | **Secret** | 自訂一串長密碼 | 自訂一串長密碼 |

`ALLOWED_ORIGIN` 是你的 GitHub Pages 網站的「網域」，不包含 repo 名稱。例如網站是 `https://jhen-1993.github.io/CramGoose/`，仍填 `https://jhen-1993.github.io`。

## 部署方式

1. 將整個專案上傳 GitHub（`Jhen-1993/CramGoose`）；本資料夾（`cramgoose-ai-relay-worker`）必須保留在 repo 內。
2. 在 Cloudflare **Workers & Pages** 建立 Worker，連接這個 GitHub repo。
3. 將 Root directory 設成 `cramgoose-ai-relay-worker`，Build command 留白，Deploy command 填 `npm run deploy`。
4. 先部署一次，再進入 Worker 的 **Settings → Variables and Secrets**，新增上表中的 Text 變數與 Secret。
5. 新增或更換 Secret 後，到 **Deployments** 將最新版本 Promote 到 100%。
6. 到 **Domains** 複製 Production Worker URL，例如 `https://cramgoose-ai-relay.<你的帳號>.workers.dev`。
7. 回到溫書鵝網頁的「個人 AI Relay 設定」，選擇 GPT／Claude、貼上 URL 和同一組 `RELAY_ACCESS_TOKEN`，按「測試並儲存 Relay」。

## 本機測試

複製 `dev_vars.example` 為 `.dev.vars`（不要提交到 git），填入自己的金鑰後執行：

```
npx wrangler dev
```

## 安全與費用

- API Key 只放在 Cloudflare Secret，絕對不要貼進 `index.html`、GitHub 或 Relay 存取密碼欄。
- `RELAY_ACCESS_TOKEN` 是保護你的 Worker 的自訂密碼，不是 OpenAI 或 Anthropic 的 API Key。
- AI 功能包含筆記統整、標示重點、出題、批改、圖片／掃描 PDF OCR，皆會使用你選擇的 API 帳號計費。
- ChatGPT Plus 與 Claude Pro／訂閱通常不等於 API 點數；是否可呼叫 API 以各 API 帳號的餘額與權限為準。
