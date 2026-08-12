# 讀書鵝 StudyGoose — GitHub Pages 個人 AI Relay 版

這是以你提供的 `files (1)/index.html` 改好的 GitHub 版本。原本瀏覽器直接向 Claude API 送出 API Key 的設計已移除，改為由 Cloudflare Worker 代送請求。

## 上傳 GitHub

1. 在 GitHub repo **根目錄**放置本資料夾中的 `index.html`。
2. 同時保留 `studygoose-ai-relay-worker` 資料夾，供 Cloudflare 從 GitHub 部署 Worker。
3. GitHub Pages 的 Source 選擇 `main` branch 與 `/ (root)`。
4. 依照 [`studygoose-ai-relay-worker/README.md`](studygoose-ai-relay-worker/README.md) 部署自己的 Cloudflare Worker。

## 第一次使用

進入 GitHub Pages 的讀書鵝後，展開「個人 AI Relay 設定」：

1. 選擇你的 Relay 使用 GPT 或 Claude。
2. 貼上 Cloudflare 的 Production Worker URL。
3. 輸入你在 Cloudflare 設定的 `RELAY_ACCESS_TOKEN`。
4. 按「測試並儲存 Relay」。

設定只會存在目前瀏覽器的 localStorage；API Key 不會寫進 GitHub 網頁。若朋友也想用 AI，應部署自己的 Worker、使用自己的 API Key 與 Relay 存取密碼。

## 與 Claude Artifact 的關係

你原本的 `讀書鵝StudyGoose.html` 是給 Claude Artifact 使用的版本，請繼續保留它。這個 GitHub 版是獨立版本；兩者不會互相覆蓋，也不會自動同步資料。

## 成本提醒

GitHub 版的 AI 功能使用 OpenAI API 或 Anthropic API 的 API 額度。ChatGPT Plus 或 Claude 訂閱本身通常不含這些 API 額度。
