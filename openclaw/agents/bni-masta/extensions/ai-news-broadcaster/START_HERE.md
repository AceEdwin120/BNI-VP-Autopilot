# 交接任務：完成 AI News Broadcaster 安裝與啟用

你好，這是一個給你的完整指引。請從頭看到尾再開始動作。

---

## 1. 你是誰、做什麼

你是 <YourName>（操作員）Mac 上的助理 AI（具備檔案存取與 shell 執行能力）。<YourName> 是台灣 BNI 分會的 副主席（<YourChapter>），他長期在維護一個叫 **BNI Masta** 的個人 agent。

我（另一個 AI session）剛幫他在 BNI Masta 裡新增了一個叫 **AI News Broadcaster** 的功能。功能本體已經寫完、測試過 dry-run，現在需要你接手把它**正式安裝、啟用、開始跑**。

---

## 2. 鐵律（最重要，違規會出事）

**不准修改 `extensions/ai-news-broadcaster/` 以外的任何檔案。**

- BNI Masta 主框架（`SOUL.md`、原本 `skills/` 下那 15 個 skill、`config/`）已經 sha256 鎖定
- 動到任何一個既有檔案 = 破壞與框架擁有者之間的合約
- 我們新增的功能是**嚴格 additive**，全部住在 `extensions/ai-news-broadcaster/` 內
- 31 個受保護檔案的 sha256 baseline 在 `extensions/ai-news-broadcaster/test-results/stage7-framework-checksums.txt`，你完工後要再 verify 一次

如果你在執行任何步驟時發現非得修改既有檔案，**停下來問 操作員**，不要自己決定。

---

## 3. 專案路徑

主資料夾：
```
<repo-root>/openclaw/agents/bni-masta/
```

我們的功能資料夾（你只能在這裡寫東西）：
```
<repo-root>/openclaw/agents/bni-masta/extensions/ai-news-broadcaster/
```

以下路徑都是相對 extension 資料夾。

---

## 4. 第一件事：照順序讀這些檔案

不要跳過。先把脈絡讀進腦袋再動手。

1. **`MANIFEST.md`** — 整合介面說明書。告訴你我們新增了什麼、依賴哪些既有檔案、寫盤路徑、env vars、入口指令、明確的 non-goals。**最重要的一份**。
2. **`INSTALL.md`** — 7 步驟安裝清單。你接下來要照這個跑。每步都附「✓ Expected output」。
3. **`plan.md`** v0.5 — 完整設計文件（含 changelog，可看見決策軌跡）。
4. **`skills/ai-news-broadcast/SKILL.md`** — orchestrator (`broadcast.mjs`) 的用法、CLI flags、env vars。

讀的時候你會看到我們 vendor 了既有 `meeting-deck-report` 跟 `post-meeting-line-digest` 的少數模式（Chrome headless render、LINE Messaging API push）— 這是刻意的。詳見 MANIFEST。

---

## 5. 功能在做什麼（高層次）

每兩天早上 09:00（台北）自動跑一次，全程一個 Node process：

1. **Scrape** — 用 Apify 的 `apify/facebook-posts-scraper` 抓 20 個 Facebook 頁面（8 個實驗室官方 + 5 個英文媒體 + 7 個繁中台灣媒體）48 小時內的貼文，並 dedupe 掉前三輪已出現過的內容
2. **Curate + 翻譯 + Tips** — 一次 Claude Haiku call：從候選池選 top 3、翻成繁體中文（標題 / 摘要 / 為什麼重要），並產出三個給<YourChapter> 夥伴的 tips
3. **Render** — 用 Chrome headless 產 6 頁 PDF（cover / 三則新聞 / tips / 來源清單），繁中字型
4. **Archive** — 寫一份 Markdown 紀錄到 `<vault>/archive/ai_news/<date>_<HHmm>.md` + 把 PDF 複製到旁邊 + 更新 `INDEX.md`（最新在最上面）
5. **Fan-out 到 LINE 兩條 channel（並行）：**
   - **Bot channel**：BNI Masta 官方帳號 → LINE Messaging API push 到指定 group ID
   - **Personal channel**：寫一份 JSON plan 到 `<vault>/raw/ai_news/<date>/<run_id>.personal_line_plan.json`，由 <YourName> Mac 上的 Claude Desktop（透過 Computer Use）撿起來，從 <YourName>（操作員）個人 LINE 帳號發到指定群組顯示名稱

---

## 6. 雙頻道測試目標

兩條 channel 都打到同一個群組：**`<YourTestGroup>`**

- 個人 LINE 顯示名稱：`<YourTestGroup>`（注意是小寫 `Bni masta`，照既有 personal-line-broadcast skill 裡的字樣，**不是** `BNI Masta`）— 已寫進 `config/test-targets.json`
- Bot-side `C…` 群 ID：**目前還是空的**，存在 `~/.openclaw/secrets/bni-masta.env` 或 操作員 腦袋裡 — 安裝過程要請 操作員 提供，貼進 `config/test-targets.json` 的 `bot_target_group_ids[]`。如果操作員不貼，bot leg 就跳過，只測個人 LINE leg

---

## 7. 你要執行的 7 個步驟（照 INSTALL.md）

每一步做完都跟 操作員 短報一次（不要等全跑完才回報），並貼出實際輸出對照「✓ Expected output」。

### Step 1 — 設置 env vars
編輯 `~/.openclaw/secrets/bni-masta.env`，加入：
```
APIFY_TOKEN=apify_api_xxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx
LINE_CHANNEL_ACCESS_TOKEN=（既有，BNI Masta bot 用的，post-meeting-line-digest 已經在用）
LINE_PERSONAL_TARGET_GROUPS=<YourTestGroup>
```

如果 操作員 還沒辦 Apify 帳號 → 請操作員到 https://apify.com 註冊（免費 $5 credit 月足夠跑），拿 token。
ANTHROPIC_API_KEY 應該既有（BNI Masta 本來就用 Claude）。

### Step 2 — 安裝 npm 依賴
```bash
cd "<repo-root>/openclaw/agents/bni-masta/extensions/ai-news-broadcaster"
npm install
```
✓ 預期：`apify-client@^2.x` + `@anthropic-ai/sdk@^0.91.x` 安裝完成，本地 `node_modules/` ~25 MB / 約 70 packages

### Step 3 — 驗證 20 個 FB 來源 reachable
```bash
node tools/verify-sources.mjs
```
✓ 預期：報出每個頁面 200 OK 還是 404；自動把 404 的頁面 `active: false`，並印出 diff 給 操作員 確認

特別留意 Tier C 繁中那 7 個 — 是我用 handle 直接放上去的，沒實際打過 FB 驗證。如果有 4 個以上掛掉，要回報 操作員 看是不是 handle 拼錯。

### Step 4 — Dry-run 整鏈
```bash
node skills/ai-news-broadcast/broadcast.mjs --dry-run --test-targets --vault-root /tmp/ai-news-test
```
✓ 預期 summary block：
```
[ai-news-broadcast] DONE — run_id: <id>
  scrape: <N> posts from 20 sources
  deck: (html only — dry-run, 6 pages projected)
  archive: (dry-run — composed in memory, not written)
  bot LINE: dry-run (... groups: ...)
  personal LINE: dry-run (1 groups: <YourTestGroup>)
```

### Step 5（可選）— 補上 bot 端 group ID
如果 操作員 要測 bot leg，請操作員從 `~/.openclaw/secrets/bni-masta.env` 或 LINE Developer Console 撈出 `<YourTestGroup>` 對應的 `C…` 群 ID，貼進 `config/test-targets.json` 的 `bot_target_group_ids[]`。
不貼也可以，bot leg 自動跳過，只跑個人 LINE leg。

### Step 6 — Live 測試（真的會發訊息！）
**請先警告 操作員 這會發真實訊息到 `<YourTestGroup>` 群組。等操作員確認再跑。**
```bash
node skills/ai-news-broadcast/broadcast.mjs --test-targets
```
✓ 預期：
- `<YourTestGroup>` 群收到 1 則來自 BNI Masta bot 的繁中 AI 新聞訊息（如果 bot ID 有貼）
- `<vault>/raw/ai_news/<date>/<run_id>.personal_line_plan.json` 寫出來，等 Claude Desktop executor 撿
- `<vault>/archive/ai_news/<date>_<HHmm>.md` + `.deck.pdf` + `INDEX.md` 都產生

如果 Computer Use executor (Claude Desktop) 那時還在跑，個人 LINE 那條會自動被處理掉；如果沒在跑，JSON 就放在那裡等下次。

### Step 7 — 安裝 launchd 排程
```bash
bash scheduling/install.sh
```
✓ 預期：plist 複製到 `~/Library/LaunchAgents/com.bni-masta.ai-news.plist`，`launchctl load` 成功，下一次 fire time 印出來

排程策略是「daily 09:00 開火 + state-file gate」（讀 `<vault>/logs/ai_news/last_run_date`，未滿 40 小時就 exit）。可自動處理睡眠/DST/重灌。

---

## 8. 完工驗證

跑完 Step 7 後做兩件事：

1. **31 個既有檔案 sha256 沒變：**
   ```bash
   cd "<repo-root>/openclaw/agents/bni-masta"
   diff <(sort extensions/ai-news-broadcaster/test-results/stage7-framework-checksums.txt) \
        <(find . -path ./extensions -prune -o -type f -print | xargs shasum -a 256 | sort)
   ```
   ✓ 預期：empty diff

2. **`launchctl list | grep bni-masta` 看到 agent loaded**

---

## 9. 給未來你（或下個 AI）的整合注意事項

當你之後要在 BNI Masta 加其他新 feature，請：

- 沿用同樣 pattern：放在 `extensions/<your-feature>/` 下，**絕不修改既有檔案**
- 我們的 feature 會在 runtime 寫到這四個路徑（不要踩到）：
  - `<vault>/raw/ai_news/`
  - `<vault>/archive/ai_news/`（含 `INDEX.md` — 唯一會 in-place mutate 的檔案）
  - `<vault>/build/ai_news/`
  - `<vault>/logs/ai_news/`
- 我們依賴**既有檔案**的這幾個介面（不要改它們的契約）：
  - `skills/personal-line-broadcast/broadcast.mjs` 的 JSON output schema（12 個 key）
  - `skills/post-meeting-line-digest/digest.mjs` 的 LINE push 模式（已 vendored）
  - `skills/meeting-deck-report/deck.mjs` 的 Chrome headless render 模式（已 vendored）
  - `~/.openclaw/secrets/bni-masta.env` 的 env loader 格式
- env vars 我們新增/共用了這些：`APIFY_TOKEN`、`ANTHROPIC_API_KEY`、`LINE_CHANNEL_ACCESS_TOKEN`、`LINE_PERSONAL_TARGET_GROUPS`
- launchd label：`com.bni-masta.ai-news`（不要重複用）

---

## 10. 你完成後給 操作員 的報告應包含

- Step 1-7 各自 ✓ 還是 ✗（附實際輸出）
- 任何 deviation 或非預期狀況
- 下一次自動 fire 的預期時間
- 31 個既有檔案 verify diff 結果
- 如果有跳過 bot leg，明確說

---

## 11. 遇到問題的回報原則

- 任何試圖修改既有檔案的衝動 → 停，問 操作員
- 任何「我覺得這樣比較好但跟 plan / MANIFEST 不一樣」的想法 → 停，問 操作員
- npm / Apify / LINE / Anthropic API 的真實錯誤 → 完整貼錯誤訊息，不要省略
- 如果 INSTALL.md 的某步驟 expected output 跟你看到的不一致 → 停，貼出來討論

---

謝謝，等你回報。操作員 會在旁邊看。
