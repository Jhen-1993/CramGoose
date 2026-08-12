# 溫書鵝 CramGoose — GitHub Pages 個人 AI Relay 版
## 第一次使用

進入 GitHub Pages 的溫書鵝後，展開「個人 AI Relay 設定」：

1. 選擇你的 Relay 使用 GPT 或 Claude。
2. 貼上 Cloudflare 的 Production Worker URL。
3. 輸入你在 Cloudflare 設定的 `RELAY_ACCESS_TOKEN`。
4. 按「測試並儲存 Relay」。

設定只會存在目前瀏覽器的 localStorage；API Key 不會寫進 GitHub 網頁。若朋友也想用 AI，應部署自己的 Worker、使用自己的 API Key 與 Relay 存取密碼。

## 成本提醒

GitHub 版的 AI 功能使用 OpenAI API 或 Anthropic API 的 API 額度。ChatGPT Plus 或 Claude 訂閱本身通常不含這些 API 額度。
