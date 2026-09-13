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
const MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";
const API_KEY = process.env.OPENROUTER_API_KEY || "";
const BROKER_URL = process.env.BROKER_URL || "https://pocketoption.com/ar/";

const systemPrompt = `
You are an assistant technical analyst. Analyze the trading chart screenshot only, and do not claim to have live market data.
Return a structured result as JSON only, with the following fields, no extra text before or after, no code fences:
- direction: CALL, PUT, or WAIT
- confidence: a number from 0 to 100
- asset: the asset name if visible, otherwise "unknown"
- timeframe: the timeframe if visible
- expiry_seconds: a suggested duration in seconds, between 30 and 300, or 0 if direction is WAIT
- reasons: 3 to 5 short technical reasons based only on what is visible in the image
- indicators: RSI/EMA/MACD/Price Action if actually visible in the image, otherwise state they are not visible
- warning: a short warning that the signal is not a guarantee of profit

Important rules:
1) Do not invent RSI, EMA, or MACD values that are not visible.
2) If the image is unclear or does not contain enough candles, direction must be WAIT.
3) If signals strongly conflict, use WAIT.
4) Do not say "guaranteed" or "100% certain".
5) Write all text fields (reasons, warning, asset, timeframe) entirely in English. Do not mix in words from other languages.
6) Return valid JSON only.
`;

function extractOutputText(data) {
  try {
    return data?.choices?.[0]?.message?.content || "";
  } catch {
    return "";
  }
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

    let upstream;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      upstream = await fetch(parsed.toString(), {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept": "image/png,image/jpeg,image/webp,image/*;q=0.8"
        }
      });
      clearTimeout(timeout);
    } catch (fetchErr) {
      return res.status(400).json({ error: "انتهت مهلة الاتصال أو تعذر الوصول للرابط." });
    }
    if (!upstream.ok) {
      return res.status(400).json({ error: `تعذر تحميل الصورة من هذا الرابط (رمز الخطأ ${upstream.status}).` });
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
        error: "لم يتم وضع OPENROUTER_API_KEY في ملف البيئة. الواجهة جاهزة، لكن التحليل الحقيقي يحتاج مفتاح API."
      });
    }

    const userPrompt = `
Analyze this image as a trading chart.
Optional user-provided info:
Asset: ${assetHint || "not specified"}
Timeframe: ${timeframeHint || "not specified"}

Focus on the most recent visible candles, price direction, support and resistance levels, price action, and only the indicators that are actually visible.
`;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: userPrompt },
              { type: "image_url", image_url: { url: imageDataUrl } }
            ]
          }
        ],
        max_tokens: 900,
        temperature: 0.4
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
