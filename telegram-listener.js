#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * RX9 Telegram Listener — MTProto userbot שמאזין לערוץ ודוחף הודעות ל-Base44 webhook בזמן אמת.
 *
 * פועל כחשבון הטלגרם האישי שלך (לא בוט) — מאזין לכל ערוץ שאתה מנוי אליו,
 * גם בלי הרשאת אדמין או הוספת בוט.
 * מושך את כל התצורה (session, channel, api_id, api_hash) אוטומטית מ-Base44.
 *
 * תכונות:
 * - דחיפת הודעות חדשות ועריכות ל-webhook מיד עם קבלתן
 * - התאוששות אוטומטית מניתוקים (autoReconnect + catch-up)
 * - השלמת הודעות שהתפספסו בזמן ניתוק (עד 50 האחרונות)
 * - דה-דופ בצד ה-webhook מונע התראות כפולות
 *
 * דרושים רק 2 משתני סביבה: APP_URL ו-LISTENER_TOKEN.
 * ראה README.md להוראות התקנה.
 */

const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage, EditedMessage } = require("telegram/events");
const http = require("http");

// ─── תצורה — רק 2 משתני סביבה נדרשים ───
const APP_URL = process.env.APP_URL || "https://conscious-rapid-alert-pulse.base44.app";
const LISTENER_TOKEN = process.env.LISTENER_TOKEN;

if (!LISTENER_TOKEN) {
  console.error("❌ חסר LISTENER_TOKEN. ראה README.md.");
  process.exit(1);
}

const CONFIG_URL = `${APP_URL}/functions/getListenerConfig`;
let WEBHOOK_URL = `${APP_URL}/functions/telegramWebhookLive`;

function ts() {
  return new Date().toISOString();
}

// ─── שליפת תצורה מ-Base44 ───
async function fetchConfig(retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(CONFIG_URL, {
        headers: { "X-Listener-Token": LISTENER_TOKEN },
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      if (data.ok) return data;
      throw new Error(data.reason || data.error || "unknown");
    } catch (e) {
      console.error(`[${ts()}] ⚠️ שליפת תצורה נכשלה (ניסיון ${i + 1}/${retries}): ${e.message}`);
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 5000 * (i + 1)));
    }
  }
  console.error(`[${ts()}] ❌ לא ניתן לשלוף תצורה מ-Base44. יוצא.`);
  process.exit(1);
}

// ─── מצב ───
let lastProcessedId = 0;
let isCatchingUp = false;
let startedAt = null;
let client = null;
let CHANNEL_ID = null;

// ─── שליחת הודעה ל-webhook ───
async function sendToWebhook(msg) {
  const text = msg.message || msg.text || "";
  if (!text || text.trim().length === 0) return;

  const payload = {
    telegram_message_id: msg.id,
    text,
    chatId: String(msg.peerId?.channelId || msg.chatId || ""),
    chatName: "",
    date: msg.date,
  };

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Listener-Token": LISTENER_TOKEN,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`[${ts()}] ❌ webhook !ok: ${JSON.stringify(data)}`);
    } else {
      console.log(
        `[${ts()}] ✅ msg ${msg.id}: ${data.outcome} | new=${data.new} updated=${data.updated} | ${data.latency_ms}ms`
      );
    }
    lastProcessedId = Math.max(lastProcessedId, msg.id);
  } catch (e) {
    console.error(`[${ts()}] ❌ webhook error (msg ${msg.id}): ${e.message}`);
    // ניסיון חוזר אחרי 2 שניות — מונע איבוד הודעות בעת תקלת רשת רגעית
    setTimeout(() => sendToWebhook(msg).catch(() => {}), 2000);
  }
}

// ─── השלמת הודעות שהתפספסו בזמן ניתוק ───
async function catchUp() {
  if (isCatchingUp || !client) return;
  isCatchingUp = true;
  try {
    console.log(`[${ts()}] 🔄 משלים הודעות...`);
    const messages = await client.getMessages(CHANNEL_ID, { limit: 50 });
    const sorted = [...messages].reverse();
    let count = 0;
    for (const msg of sorted) {
      if (msg.id <= lastProcessedId) continue;
      if (!msg.message && !msg.text) continue;
      await sendToWebhook(msg);
      count++;
    }
    console.log(`[${ts()}] ✅ השלמה הסתיימה: ${count} הודעות נשלחו.`);
  } catch (e) {
    console.error(`[${ts()}] ❌ שגיאת השלמה: ${e.message}`);
  } finally {
    isCatchingUp = false;
  }
}

// ─── יצירת חיבור GramJS ───
function createClient(config) {
  return new TelegramClient(
    new StringSession(config.session_string),
    parseInt(config.api_id),
    config.api_hash,
    {
      connectionRetries: 999,
      retryDelay: 3000,
      autoReconnect: true,
      floodSleepThreshold: 120,
    }
  );
}

// ─── רישום event handlers ───
function registerHandlers(c) {
  // הודעות חדשות בערוץ המנוטר
  c.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg) return;
    const msgChannelId = String(msg.peerId?.channelId || "");
    if (msgChannelId !== String(CHANNEL_ID)) return;
    if (msg.id <= lastProcessedId) return;
    await sendToWebhook(msg);
  }, new NewMessage({}));

  // עריכות (בוטל/שונה/שודרג/כתובת עודכנה)
  c.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg) return;
    const msgChannelId = String(msg.peerId?.channelId || "");
    if (msgChannelId !== String(CHANNEL_ID)) return;
    await sendToWebhook(msg);
  }, new EditedMessage({}));
}

// ─── התחברות והתחלה ───
async function start() {
  console.log(`[${ts()}] 🔍 שולף תצורה מ-Base44...`);
  const config = await fetchConfig();
  CHANNEL_ID = config.channel_id;

  console.log(`[${ts()}] 🔌 מתחבר לטלגרם (ערוץ ${config.channel_name || CHANNEL_ID})...`);
  client = createClient(config);
  await client.connect();

  if (!(await client.isUserAuthorized())) {
    console.error(`[${ts()}] ❌ ה-session אינו מורשה. יש להתחבר מחדש דרך האפליקציה.`);
    process.exit(1);
  }

  startedAt = Date.now();
  console.log(`[${ts()}] ✅ מחובר לטלגרם.`);
  console.log(`[${ts()}] 🎯 Webhook: ${WEBHOOK_URL}`);

  registerHandlers(client);
  await catchUp();

  console.log(`[${ts()}] 👂 מאזין להודעות חדשות...`);
}

// ─── ניטור חיבור — השלמה אוטומטית אחרי התחברות מחדש ───
let wasConnected = true;
setInterval(async () => {
  if (!client) return;
  const isConnected = client.connected;
  if (!isConnected && wasConnected) {
    console.log(`[${ts()}] ⚠️ ניתוק זוהה. ממתין להתחברות אוטומטית...`);
    wasConnected = false;
  } else if (isConnected && !wasConnected) {
    console.log(`[${ts()}] ✅ חיבור חזר. משלים הודעות שהתפספסו...`);
    wasConnected = true;
    await catchUp();
  }
}, 15000);

// ─── סטטוס תקופתי ───
setInterval(() => {
  const uptime = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
  console.log(`[${ts()}] 📊 פעיל ${uptime}s | אחרון: ${lastProcessedId} | מחובר: ${client?.connected}`);
}, 300000);

// ─── טיפול בשגיאות ───
process.on("unhandledRejection", (reason) => {
  console.error(`[${ts()}] ⚠️ Unhandled rejection: ${reason}`);
});

process.on("uncaughtException", (err) => {
  console.error(`[${ts()}] 💥 Uncaught exception: ${err.message}`);
  process.exit(1);
});

// ─── סגירה נקייה ───
process.on("SIGINT", async () => {
  console.log(`[${ts()}] 👋 סוגר...`);
  if (client) await client.disconnect();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log(`[${ts()}] 👋 SIGTERM — סוגר...`);
  if (client) await client.disconnect();
  process.exit(0);
});

// ─── Health endpoint (לניטור Railway) ───
const HEALTH_PORT = parseInt(process.env.PORT || "3000", 10);
const healthServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        connected: client?.connected || false,
        uptime: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
        lastProcessedId,
      })
    );
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found. Use /health");
  }
});
healthServer.listen(HEALTH_PORT, () => {
  console.log(`[${ts()}] 🏥 Health endpoint on :${HEALTH_PORT}/health`);
});

start().catch((e) => {
  console.error(`[${ts()}] 💥 שגיאה קריטית: ${e.message}`);
  process.exit(1);
});