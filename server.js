// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import OpenAI from "openai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- DB (SQLite, file = dm.db) ----
const db = new Database(path.join(__dirname, "dm.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conv_id TEXT NOT NULL,
    role TEXT NOT NULL,          -- 'user' | 'assistant' | 'system'
    content TEXT NOT NULL,
    ip TEXT,
    ua TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(conv_id) REFERENCES conversations(id)
  );
`);
const insertConv = db.prepare("INSERT OR IGNORE INTO conversations (id) VALUES (?)");
const insertMsg  = db.prepare("INSERT INTO messages (conv_id, role, content, ip, ua) VALUES (?,?,?,?,?)");
const lastNMsgs  = db.prepare("SELECT role, content FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT ?");

// ---- App ----
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/] }));
app.use(express.static(__dirname)); // serves index.html etc.

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Small helper: ensure we have a conversation id cookie
function getConvId(req, res) {
  let cid = req.cookies?.cid;
  if (!cid) {
    cid = cryptoRandomId();
    res.cookie("cid", cid, { httpOnly: true, sameSite: "Lax", maxAge: 1000*60*60*24*30 });
  }
  insertConv.run(cid);
  return cid;
}
function cryptoRandomId() {
  // short random id for cookie/DB (not security-critical)
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

// --- Rule-based answers for your studio (fast + on-brand)
function cannedAnswer(q) {
  const txt = q.toLowerCase();
  if (txt.includes("package")) {
    return `Here are our core packages:

• Starter — Shopify-ready one-product page. Starts at ₹999.  
• Business Plus — 5–8 pages with CMS & Blog. Custom priced.  
• Premium Commerce — full e-commerce with integrations. Custom priced.  
• App Dev Add-On — cross-platform app + API. Custom priced.

Tell me a bit about your business and I’ll recommend the right fit.`;
  }
  if (txt.includes("price") || txt.includes("cost") || txt.includes("quote")) {
    return `High-level pricing:

• Starter: ₹999 (one-product Shopify page).  
• Business Plus / Premium Commerce / App Add-On: custom based on scope.

Share your goals, number of pages/products, and any integrations. I’ll give you a quick ballpark now.`;
  }
  if (txt.includes("timeline") || txt.includes("how long")) {
    return `Timelines:

• Starter: ~1–2 weeks  
• Larger sites/apps: ~3–6+ weeks depending on scope

If you share any deadlines, I can map a delivery plan.`;
  }
  if (txt.includes("human") || txt.includes("talk to human") || txt.includes("contact")) {
    return `You can reach us at hello@dmtodotcom or +91 94443 84637.  
Want me to prefill the contact form with our chat summary?`;
  }
  return null;
}

// --- Chat endpoint (stores every message, uses canned → OpenAI fallback)
app.post("/api/chat", async (req, res) => {
  try {
    const convId = getConvId(req, res);
    const userMsg = (req.body?.message || "").toString().slice(0, 2000);
    const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.socket.remoteAddress || "";
    const ua = req.headers["user-agent"] || "";

    if (!userMsg) return res.json({ reply: "Tell me a bit about your project and I’ll help you choose a package." });

    // Store user message
    insertMsg.run(convId, "user", userMsg, ip, ua);

    // 1) fast on-brand reply if it matches your common intents
    const canned = cannedAnswer(userMsg);
    if (canned) {
      insertMsg.run(convId, "assistant", canned, "", "");
      return res.json({ reply: canned });
    }

    // 2) Otherwise call OpenAI with short system + last 10 messages context
    const context = lastNMsgs.all(convId, 10).reverse(); // old → new
    const messages = [
      {
        role: "system",
        content:
          "You are dm to dot — a boutique studio. Be concise, friendly, and sales-aware. " +
          "When relevant, mention packages (Starter ₹999; Business Plus; Premium Commerce; App Dev Add-On), " +
          "typical timelines (Starter 1–2 weeks, larger 3–6+), and contact (hello@dmtodotcom, +91 94443 84637)."
      },
      ...context,
      { role: "user", content: userMsg }
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.4
    });

    const reply = completion.choices[0].message.content?.trim() || "I’m here! How can I help?";
    insertMsg.run(convId, "assistant", reply, "", "");

    res.json({ reply });
  } catch (err) {
    console.error("chat error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

// CSV export for admin
app.get("/admin/export.csv", (req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=dm-messages.csv");
  const rows = db.prepare(`
    SELECT id, conv_id, role, replace(replace(content, CHAR(13), ' '), CHAR(10), ' ') as content,
           ip, ua, created_at
    FROM messages ORDER BY id ASC
  `).all();

  const header = "id,conv_id,role,content,ip,ua,created_at\n";
  const body = rows.map(r =>
    [r.id, r.conv_id, r.role,
     `"${(r.content||"").replace(/"/g,'""')}"`,
     `"${(r.ip||"").replace(/"/g,'""')}"`,
     `"${(r.ua||"").replace(/"/g,'""')}"`,
     r.created_at].join(",")
  ).join("\n");

  res.send(header + body + "\n");
});

// health
app.get("/api/health", (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`dm-to-dot running at http://localhost:${PORT}`));
