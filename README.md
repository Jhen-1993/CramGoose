# 溫書鵝 CramGoose — GitHub Pages 個人 AI Relay 版

Repo：https://github.com/Jhen-1993/CramGoose

## 第一次使用

進入 GitHub Pages 的溫書鵝後，展開「個人 AI Relay 設定」：

1. 選擇你的 Relay 使用 GPT 或 Claude。
2. 貼上 Cloudflare 的 Production Worker URL。
3. 輸入你在 Cloudflare 設定的 `RELAY_ACCESS_TOKEN`。
4. 按「測試並儲存 Relay」。

設定只會存在目前瀏覽器的 localStorage；API Key 不會寫進 GitHub 網頁。若朋友也想用 AI，應部署自己的 Worker、使用自己的 API Key 與 Relay 存取密碼。

Worker 專案在 [`cramgoose-ai-relay-worker/`](./cramgoose-ai-relay-worker) 資料夾，部署方式請看該資料夾內的 README。

## 功能

- **每日進度自動排程**：依「剩餘量 ÷ 剩餘天數」計算每天建議進度，沒完成的量會自動累進到後面幾天
- **章節記錄**：科目可以拆成一章一章記錄，勾選已完成即可，也可以回溯補登過去讀過的進度
- **總複習日**：考前 N 天自動排成複習日，不排新進度
- **筆記管理**：上傳 PDF／圖片筆記，依科目、章節分類；掃描檔或手寫照片會自動用 AI 影像辨識轉錄文字
- **AI 統整筆記**：把同一科目的所有筆記，統整成一份結構化、內容完整的最終複習筆記，並可依考古資料標示重點（🔥常考／📋指引重點）
- **匯出 Word／PDF**：統整好的筆記可以直接匯出成 `.doc` 或 PDF，帶著走或印出來都方便
- **考古資料與考情指引**：可加入歷屆試題、老師提供的題目、老師的考情指引文字或 PDF，分開標記，出題時只會參考指引方向、不會把指引原句當題目
- **AI 模擬考**：練習模式或限時考試模式，依統整筆記與考古資料出申論題，作答後由 AI 評分並給回饋，保留歷史紀錄

## 成本提醒

GitHub 版的 AI 功能使用 OpenAI API 或 Anthropic API 的 API 額度。ChatGPT Plus 或 Claude 訂閱本身通常不含這些 API 額度。

## 資料存放位置

所有資料（設定、進度、筆記文字、考古資料）都只存在**你自己瀏覽器的 localStorage**，沒有任何後端資料庫。清除瀏覽器資料、換瀏覽器或換裝置都不會同步。

## License

MIT
