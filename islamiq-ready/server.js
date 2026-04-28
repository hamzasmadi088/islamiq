import express from "express";
import dotenv from "dotenv";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false
}));

const db = new Database("islamiq.sqlite");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  memory TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT 'محادثة جديدة',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(chat_id) REFERENCES chats(id)
);
`);

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: "14d" }
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "غير مسجل الدخول" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "انتهت الجلسة، سجل الدخول مرة ثانية" });
  }
}

function safeTitle(text) {
  return (text || "محادثة جديدة").replace(/\s+/g, " ").trim().slice(0, 45) || "محادثة جديدة";
}

function buildSystemPrompt({ madhab, memory }) {
  const madhabFocus = {
    all: "قارن بين المذاهب الأربعة في المسائل الفقهية الخلافية عند الحاجة.",
    hanafi: "اعتمد المذهب الحنفي أساساً في الإجابة.",
    maliki: "اعتمد المذهب المالكي أساساً في الإجابة.",
    shafii: "اعتمد المذهب الشافعي أساساً في الإجابة.",
    hanbali: "اعتمد المذهب الحنبلي أساساً في الإجابة."
  };

  return `أنت IslamiQ، مساعد إسلامي عربي.
التوجيه المذهبي: ${madhabFocus[madhab] || madhabFocus.all}

ذاكرة المستخدم طويلة المدى:
${memory || "لا توجد ذاكرة محفوظة بعد."}

قواعد مهمة:
- أجب بالعربية بوضوح.
- لا تخترع آيات أو أحاديث أو مصادر.
- عند ذكر آية اذكر السورة ورقم الآية.
- عند ذكر حديث اذكر المصدر والدرجة إن عرفت.
- للمسائل الحساسة أو الشخصية قل إن الرجوع لعالم موثوق أفضل.
- لا تجعل الذاكرة تكشف معلومات خاصة غير ضرورية.
- استخدم HTML بسيط عند الحاجة:
<div class="quran">﴿نص الآية﴾</div>
<div class="hadith">نص الحديث</div>
<span class="source-tag">المصدر</span>
- اختم الفتاوى بـ: والله أعلم.`;
}

app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "الاسم والإيميل وكلمة السر مطلوبة" });
  if (password.length < 6) return res.status(400).json({ error: "كلمة السر لازم تكون 6 أحرف على الأقل" });

  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase());
  if (exists) return res.status(409).json({ error: "الإيميل مسجل مسبقاً" });

  const passwordHash = await bcrypt.hash(password, 12);
  const result = db.prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)")
    .run(name.trim(), email.toLowerCase().trim(), passwordHash);

  const user = { id: result.lastInsertRowid, name: name.trim(), email: email.toLowerCase().trim() };
  res.json({ token: signToken(user), user });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get((email || "").toLowerCase().trim());
  if (!user) return res.status(401).json({ error: "الإيميل أو كلمة السر غير صحيحة" });

  const ok = await bcrypt.compare(password || "", user.password_hash);
  if (!ok) return res.status(401).json({ error: "الإيميل أو كلمة السر غير صحيحة" });

  res.json({ token: signToken(user), user: { id: user.id, name: user.name, email: user.email } });
});

app.get("/api/me", auth, (req, res) => {
  const user = db.prepare("SELECT id, name, email, memory FROM users WHERE id = ?").get(req.user.id);
  res.json({ user });
});

app.get("/api/chats", auth, (req, res) => {
  const chats = db.prepare(`
    SELECT id, title, created_at, updated_at
    FROM chats
    WHERE user_id = ?
    ORDER BY updated_at DESC
  `).all(req.user.id);
  res.json({ chats });
});

app.get("/api/chats/:id/messages", auth, (req, res) => {
  const chat = db.prepare("SELECT * FROM chats WHERE id = ? AND user_id = ?").get(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: "المحادثة غير موجودة" });

  const messages = db.prepare("SELECT role, content, created_at FROM messages WHERE chat_id = ? ORDER BY id ASC").all(chat.id);
  res.json({ chat, messages });
});

app.delete("/api/chats/:id", auth, (req, res) => {
  const chat = db.prepare("SELECT * FROM chats WHERE id = ? AND user_id = ?").get(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: "المحادثة غير موجودة" });

  db.prepare("DELETE FROM messages WHERE chat_id = ?").run(chat.id);
  db.prepare("DELETE FROM chats WHERE id = ?").run(chat.id);
  res.json({ ok: true });
});

app.post("/api/memory/clear", auth, (req, res) => {
  db.prepare("UPDATE users SET memory = '' WHERE id = ?").run(req.user.id);
  res.json({ ok: true });
});

async function updateLongMemory({ userId, oldMemory, userMessage, assistantText }) {
  try {
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 350,
      system: "أنت تلخص ذاكرة طويلة المدى لمساعد. لا تحفظ معلومات حساسة إلا إذا كانت تفضيلات استخدام واضحة. أعد نصاً عربياً قصيراً فقط.",
      messages: [{
        role: "user",
        content: `الذاكرة الحالية:\n${oldMemory || "فارغة"}\n\nآخر رسالة من المستخدم:\n${userMessage}\n\nآخر رد من المساعد:\n${assistantText}\n\nحدّث الذاكرة بتفضيلات أو معلومات مفيدة مستقبلاً فقط. إن لم يوجد شيء مهم أعد الذاكرة كما هي.`
      }]
    });

    const newMemory = msg.content?.map(x => x.type === "text" ? x.text : "").join("\n").trim().slice(0, 2000);
    if (newMemory) db.prepare("UPDATE users SET memory = ? WHERE id = ?").run(newMemory, userId);
  } catch (e) {
    console.warn("Memory update skipped:", e.message);
  }
}

app.post("/api/chat", auth, async (req, res) => {
  try {
    const { chatId, message, madhab = "all" } = req.body || {};
    if (!message || !message.trim()) return res.status(400).json({ error: "الرسالة فارغة" });

    const user = db.prepare("SELECT id, name, email, memory FROM users WHERE id = ?").get(req.user.id);
    let chat;

    if (chatId) {
      chat = db.prepare("SELECT * FROM chats WHERE id = ? AND user_id = ?").get(chatId, req.user.id);
      if (!chat) return res.status(404).json({ error: "المحادثة غير موجودة" });
    } else {
      const title = safeTitle(message);
      const result = db.prepare("INSERT INTO chats (user_id, title) VALUES (?, ?)").run(req.user.id, title);
      chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(result.lastInsertRowid);
    }

    db.prepare("INSERT INTO messages (chat_id, role, content) VALUES (?, 'user', ?)").run(chat.id, message.trim());

    const history = db.prepare("SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id ASC LIMIT 30").all(chat.id);

    const ai = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1800,
      system: buildSystemPrompt({ madhab, memory: user.memory }),
      messages: history
    });

    const assistantText = ai.content?.map(x => x.type === "text" ? x.text : "").join("\n").trim();
    if (!assistantText) throw new Error("استجابة فارغة من النموذج");

    db.prepare("INSERT INTO messages (chat_id, role, content) VALUES (?, 'assistant', ?)").run(chat.id, assistantText);
    db.prepare("UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(chat.id);

    updateLongMemory({
      userId: req.user.id,
      oldMemory: user.memory,
      userMessage: message.trim(),
      assistantText
    });

    res.json({ chatId: chat.id, answer: assistantText });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر الاتصال بالنموذج أو السيرفر", details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`IslamiQ ready: http://localhost:${PORT}`);
});
