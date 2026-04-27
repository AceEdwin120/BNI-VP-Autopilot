// quote-bank — 30 benign chat messages drawn from the BNI handbook (wiki/rules/總政策.md
// + wiki/rules/會議議程.md). Each message ≤40 char Traditional Chinese, one emoji max,
// never demands action from participants. Used as fast ($0, instant) responses to
// non-question chat — avoids the 7s LLM hop for the cheerful-background-presence
// job.
//
// Categories:
//   CORE_VALUES  — the 7 核心價值 from 總政策 (手冊 p.5)
//   ETHICS       — the 7 道德規範 from 總政策 (手冊 p.6)
//   MISSION      — 使命宣言 + 願景 (手冊 p.5)
//   MEETING      — 例會能量、氣氛、節奏
//   CELEBRATE    — 認可、感謝、正向鼓勵

export const QUOTES = [
  // --- Core Values (7) ---
  { cat: "core", text: "💪 付出者收穫 — 先付出，回報自然會找上你" },
  { cat: "core", text: "🤝 建立關係 — 今天又深化一分" },
  { cat: "core", text: "📚 終身學習 — 今天又長了一點本事" },
  { cat: "core", text: "🌱 傳統是基石，創新是機會" },
  { cat: "core", text: "☀️ 正面積極 — 就是你最好的名片" },
  { cat: "core", text: "✨ 當責 — 讓信任變成理所當然" },
  { cat: "core", text: "🙌 認可與表揚 — 感謝已在路上" },

  // --- Ethics / 道德規範 (7) ---
  { cat: "ethics", text: "💎 以誠信對待每一位會員夥伴" },
  { cat: "ethics", text: "🤝 優質服務永遠不打折扣" },
  { cat: "ethics", text: "🌟 好的商譽，是最好的商標" },
  { cat: "ethics", text: "📞 每一個引薦都值得全力跟進" },
  { cat: "ethics", text: "🚀 以 BNI 的身份，互相支持" },
  { cat: "ethics", text: "⚖️ 專業與 BNI 規範並重" },
  { cat: "ethics", text: "🔥 信任，是我們最珍貴的通貨" },

  // --- Mission & Vision (4) ---
  { cat: "mission", text: "🌏 BNI — 改變全世界做生意的方式" },
  { cat: "mission", text: "🔑 Givers Gain — 已在路上" },
  { cat: "mission", text: "🧩 有架構、正向、專業的引薦行銷" },
  { cat: "mission", text: "🌟 長期關係，壯大彼此事業" },

  // --- Meeting energy (6) ---
  { cat: "meeting", text: "☕ 例會前的 15 分鐘，是黃金交流時段" },
  { cat: "meeting", text: "🎤 60 秒簡報，每週的最好舞台" },
  { cat: "meeting", text: "💡 教育單元 3 分鐘，週間回味無窮" },
  { cat: "meeting", text: "📣 副主席一句話，方向就清晰了" },
  { cat: "meeting", text: "🎁 引薦 — 是 BNI 最甜美的禮物" },
  { cat: "meeting", text: "🌈 每一場例會，都是人脈升級" },

  // --- Celebrate / encourage (6) ---
  { cat: "celebrate", text: "🎉 準時到的夥伴，值得一個掌聲" },
  { cat: "celebrate", text: "🏆 領先人物的背後，是每週的堅持" },
  { cat: "celebrate", text: "🙏 帶來賓來的每一位夥伴，謝謝" },
  { cat: "celebrate", text: "💫 正向能量是會傳染的" },
  { cat: "celebrate", text: "🦁 BNI-Masta 默默陪大家一起成長 💛" },
  { cat: "celebrate", text: "🎊 今天，是個適合轉介的好日子" },

  // === EXPANSION 30 → 60 (2026-04-23) ===
  // Added so the new ×150-trigger cheer detector doesn't rotate through the
  // same 30 lines too quickly. 6 new entries per category, same 40-char cap.

  // --- Core Values (+6) ---
  { cat: "core", text: "💎 付出者的格局，永遠比收穫大一點" },
  { cat: "core", text: "🌐 關係，是把陌生人變成家人的橋" },
  { cat: "core", text: "📖 學一招、用一招、教一招 — BNI 三步驟" },
  { cat: "core", text: "🎨 傳統穩住根，創新開出花" },
  { cat: "core", text: "🌅 正面態度，是每天最好的自我加值" },
  { cat: "core", text: "🛡️ 當責不是責任，是承諾的另一面" },

  // --- Ethics (+6) ---
  { cat: "ethics", text: "🤲 真誠的付出，比話術更有力量" },
  { cat: "ethics", text: "📌 一次承諾，全力跟進到底" },
  { cat: "ethics", text: "🌿 商譽，靠每次小細節累積" },
  { cat: "ethics", text: "🪪 把每張名片當成一份信任" },
  { cat: "ethics", text: "🤜🤛 互相支持，大家一起變強" },
  { cat: "ethics", text: "🧭 專業，是讓人安心的最短路徑" },

  // --- Mission & Vision (+6) ---
  { cat: "mission", text: "🚀 改變做生意的方式，由你我開始" },
  { cat: "mission", text: "🌱 Givers Gain — 種下一顆，發芽一片" },
  { cat: "mission", text: "🧱 結構化的引薦，比偶然更可靠" },
  { cat: "mission", text: "🌳 長期關係，是事業最好的根" },
  { cat: "mission", text: "🌐 全球分會、在地深耕、彼此放大" },
  { cat: "mission", text: "🛤️ 一條路 + 一群人 = 無限可能" },

  // --- Meeting energy (+6) ---
  { cat: "meeting", text: "🌅 早起的夥伴，總是先看到機會" },
  { cat: "meeting", text: "🎯 60 秒，把專業說到心坎裡" },
  { cat: "meeting", text: "🔍 找到完美引薦，從一句話開始" },
  { cat: "meeting", text: "🤝 1-to-1 是把關係做深的關鍵時段" },
  { cat: "meeting", text: "📊 紅綠燈是鏡子，照出每週的努力" },
  { cat: "meeting", text: "🎉 例會結束，週間故事才正要開始" },

  // --- Celebrate / encourage (+6) ---
  { cat: "celebrate", text: "👏 今天每個發言，都讓分會更亮一點" },
  { cat: "celebrate", text: "🌟 看見彼此的努力，是 BNI 的溫度" },
  { cat: "celebrate", text: "🎁 引薦的快樂，是一起完成的快樂" },
  { cat: "celebrate", text: "💪 持續就是專業，加油每一位夥伴" },
  { cat: "celebrate", text: "🥇 認可是燃料，讓人想繼續貢獻" },
  { cat: "celebrate", text: "🌈 一週又一週，我們一起變更好" },
];

// Length invariant — guard against future edits
for (const q of QUOTES) {
  if ([...q.text].length > 40) {
    console.warn(`[quote-bank] ⚠ over 40 chars: ${q.text}`);
  }
}

// Pick a random quote, optionally filtered by category, optionally avoiding a recent set.
export function pickQuote({ avoidSet = new Set(), category = null } = {}) {
  let pool = QUOTES;
  if (category) pool = pool.filter(q => q.cat === category);
  const fresh = pool.filter(q => !avoidSet.has(q.text));
  const list = fresh.length ? fresh : pool;
  return list[Math.floor(Math.random() * list.length)]?.text || "";
}
