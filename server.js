import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const API_KEY = process.env.OPENAI_API_KEY || "";
const BROKER_URL = process.env.BROKER_URL || "https://pocketoption.com/ar/";

const systemPrompt = `
أنت محلل فني مساعد. حلل صورة شاشة الرسم البياني فقط، ولا تدّع أنك تملك بيانات سوق مباشرة.
أخرج نتيجة منظمة بالعربية:
- direction: CALL أو PUT أو WAIT
- confidence: رقم 0 إلى 100
- asset: اسم الأصل إن ظهر، وإلا "غير معروف"
- timeframe: الإطار الزمني إن ظهر
- expiry_seconds: مدة مقترحة بالثواني، بين 30 و300، أو 0 إذا كانت WAIT
- reasons: 3 إلى 5 أسباب فنية قصيرة مبنية فقط على ما يظهر في الصورة
- indicators: RSI/EMA/MACD/Price Action إذا ظهرت فعلا في الصورة، وإلا اذكر أنها غير ظاهرة
- warning: تنبيه قصير بأن الإشارة ليست ضمانا للربح

قواعد مهمة:
1) لا تخترع قيمة RSI أو EMA أو MACD غير ظاهرة.
2) إذا كانت الصورة غير واضحة أو لا تحتوي شموعا كافية، direction يجب أن يكون WAIT.
3) إذا تعارضت الإشارات بقوة، استخدم WAIT.
4) لا تقل "مضمون" أو "مؤكد 100%".
5) أعد JSON صالحا فقط.
`;

function extractOutputText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  const chunks = [];
  for (const item of (data?.output || [])) {
    for (const c of (item?.content || [])) {
      if (typeof c?.text === "string") chunks.push(c.text);
    }
  }
  return chunks.join("\n");
}

app.get("/api/config", (_req, res) => {
  res.json({ brokerUrl: BROKER_URL });
});

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

app.post("/api/fetch-image", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "أرسل رابط صورة صالح." });
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: "الرابط غير صالح." });
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return res.status(400).json({ error: "يجب أن يبدأ الرابط بـ http أو https." });
    }

    const upstream = await fetch(parsed.toString(), { redirect: "follow" });
    if (!upstream.ok) {
      return res.status(400).json({ error: "تعذر تحميل الصورة من هذا الرابط." });
    }

    const contentType = (upstream.headers.get("content-type") || "").split(";")[0].trim();
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      return res.status(400).json({ error: "الرابط لا يشير إلى صورة PNG/JPG/WebP." });
    }

    const arrayBuffer = await upstream.arrayBuffer();
    if (arrayBuffer.byteLength > 10 * 1024 * 1024) {
      return res.status(400).json({ error: "حجم الصورة كبير جدا (الحد 10MB)." });
    }

    const base64 = Buffer.from(arrayBuffer).toString("base64");
    res.json({ imageDataUrl: `data:${contentType};base64,${base64}` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "حدث خطأ أثناء جلب الصورة." });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const { imageDataUrl, assetHint = "", timeframeHint = "" } = req.body || {};

    if (!imageDataUrl || !/^data:image\/(png|jpeg|jpg|webp);base64,/.test(imageDataUrl)) {
      return res.status(400).json({ error: "أرسل صورة PNG/JPG/WebP صحيحة." });
    }

    if (!API_KEY) {
      return res.status(503).json({
        error: "لم يتم وضع OPENAI_API_KEY في ملف البيئة. الواجهة جاهزة، لكن التحليل الحقيقي يحتاج مفتاح API."
      });
    }

    const userPrompt = `
حلل هذه الصورة كرسم بياني للتداول.
معلومة اختيارية من المستخدم:
الأصل: ${assetHint || "غير محدد"}
الإطار: ${timeframeHint || "غير محدد"}

ركز على آخر الشموع الظاهرة، اتجاه الحركة، الدعوم والمقاومات، Price Action، والمؤشرات الظاهرة فقط.
`;

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: systemPrompt }]
          },
          {
            role: "user",
            content: [
              { type: "input_text", text: userPrompt },
              { type: "input_image", image_url: imageDataUrl, detail: "high" }
            ]
          }
        ],
        max_output_tokens: 900
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || "فشل طلب التحليل."
      });
    }

    let text = extractOutputText(data).trim();
    text = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

    let result;
    try {
      result = JSON.parse(text);
    } catch {
      return res.status(502).json({
        error: "النموذج أعاد نتيجة غير منظمة. أعد المحاولة بصورة أوضح.",
        raw: text.slice(0, 1500)
      });
    }

    result.direction = ["CALL", "PUT", "WAIT"].includes(result.direction) ? result.direction : "WAIT";
    result.confidence = Math.max(0, Math.min(100, Number(result.confidence) || 0));
    result.expiry_seconds = Math.max(0, Math.min(300, Number(result.expiry_seconds) || 0));
    result.reasons = Array.isArray(result.reasons) ? result.reasons.slice(0, 5) : [];
    result.indicators = Array.isArray(result.indicators) ? result.indicators : [];

    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "حدث خطأ داخلي أثناء التحليل." });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Signal Bot running: http://localhost:${PORT}`);
});