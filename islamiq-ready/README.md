# IslamiQ Ready

نسخة جاهزة فيها:
- تسجيل دخول وإنشاء حساب
- حفظ المستخدمين في SQLite
- حفظ المحادثات والرسائل
- ذاكرة طويلة لكل مستخدم
- ربط آمن مع Claude API عبر Backend

## التشغيل

```bash
npm install
copy .env.example .env
npm start
```

على macOS/Linux:

```bash
cp .env.example .env
npm start
```

افتح:

```txt
http://localhost:3000
```

## مهم

افتح ملف `.env` وحط:
- ANTHROPIC_API_KEY
- JWT_SECRET طويل وعشوائي

قاعدة البيانات ستنشأ تلقائياً باسم:

```txt
islamiq.sqlite
```
