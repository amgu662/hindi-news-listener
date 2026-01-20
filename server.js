import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import OpenAI from "openai";
import sdk from "microsoft-cognitiveservices-speech-sdk";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const required = [
  "NEWSAPI_KEY",
  "OPENAI_API_KEY",
  "AZURE_SPEECH_KEY",
  "AZURE_SPEECH_REGION",
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("Missing env vars:", missing.join(", "));
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get("/api/health", (req, res) => res.json({ status: "OK" }));

// ===== News =====
app.get("/api/news", async (req, res) => {
  const count = Math.max(1, Math.min(20, Number(req.query.count || 3)));
  const q = (req.query.q || "India").toString();
  const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  try {
    const response = await axios.get("https://newsapi.org/v2/everything", {
      params: {
        q,
        from,
        sortBy: "publishedAt",
        language: "en",
        pageSize: count,
        apiKey: process.env.NEWSAPI_KEY,
      },
      timeout: 15000,
    });

    res.json({
      status: response.data.status,
      totalResults: response.data.totalResults,
      articles: response.data.articles,
    });
  } catch (err) {
    res.status(500).json({
      error: "NewsAPI request failed",
      details: err?.response?.data || err.message,
    });
  }
});

// ===== Summarize (Hindi + Hebrew only) =====
app.post("/api/summarize", async (req, res) => {
  const { text, level = "beginner" } = req.body || {};
  if (!text) return res.status(400).json({ error: "Missing text" });

  const levelGuide =
    level === "beginner"
      ? "הינדית פשוטה מאוד, משפטים קצרים מאוד, אוצר מילים בסיסי."
      : level === "intermediate"
      ? "הינדית פשוטה אך עשירה יותר, עדיין משפטים קצרים."
      : "הינדית מתקדמת יותר, אך תמציתית וברורה.";

  const prompt = `
כתוב 4–6 משפטים קצרים שמסכמים את הידיעה.
${levelGuide}

כללים חשובים:
- כל משפט בהינדית בלבד (כתב דוואנגרי).
- מיד אחרי כל משפט בהינדית – שורה נפרדת עם תרגום לעברית בלבד.
- אסור להשתמש באנגלית בכלל.
- העברית קצרה וברורה.
- אל תעתיק משפטים מהמקור.

פורמט חובה:
[משפט בהינדית]
[תרגום לעברית]

[משפט בהינדית]
[תרגום לעברית]

ידיעה:
${text}
`.trim();

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
    });

    let result = completion.choices[0].message.content || "";

    // רשת ביטחון: מסירים שורות "תרגום" שאינן עברית/הינדית
    result = result
      .split("\n")
      .map((line) => {
        const hasHebrew = /[\u0590-\u05FF]/.test(line);
        const hasDeva = /[\u0900-\u097F]/.test(line);
        if (!hasHebrew && !hasDeva) return "";
        return line.trim();
      })
      .filter(Boolean)
      .join("\n");

    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: "OpenAI error", details: String(e) });
  }
});

// ===== SSML helpers =====
function escapeXml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function ratePercentToSsmlRate(ratePercent) {
  const r = Math.max(60, Math.min(140, Number(ratePercent || 100)));
  if (r <= 80) return "x-slow";
  if (r <= 95) return "slow";
  if (r <= 110) return "medium";
  if (r <= 125) return "fast";
  return "x-fast";
}

function buildHindiSsml(text, ratePercent, pauseMs) {
  const rateTag = ratePercentToSsmlRate(ratePercent);
  const safePause = Math.max(0, Math.min(2000, Number(pauseMs || 0)));

  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const joiner = safePause > 0 ? `<break time="${safePause}ms"/>` : " ";
  const body = words.map(escapeXml).join(joiner);

  return `
<speak version="1.0" xml:lang="hi-IN" xmlns="http://www.w3.org/2001/10/synthesis">
  <voice name="hi-IN-SwaraNeural">
    <prosody rate="${rateTag}">
      ${body}
    </prosody>
  </voice>
</speak>`.trim();
}

// ===== Speak -> MP3 =====
app.post("/api/speak", async (req, res) => {
  const { text, rate = 100, pauseMs = 0 } = req.body || {};
  if (!text) return res.status(400).json({ error: "Missing text" });

  const ssml = buildHindiSsml(text, rate, pauseMs);

  try {
    const speechConfig = sdk.SpeechConfig.fromSubscription(
      process.env.AZURE_SPEECH_KEY,
      process.env.AZURE_SPEECH_REGION
    );

    if (sdk.SpeechSynthesisOutputFormat) {
      speechConfig.speechSynthesisOutputFormat =
        sdk.SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3;
    }

    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

    synthesizer.speakSsmlAsync(
      ssml,
      (result) => {
        try {
          if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted) {
            synthesizer.close();
            return res
              .status(500)
              .json({ error: "Speech not completed", reason: String(result.reason) });
          }

          const audioBuffer = Buffer.from(result.audioData);
          synthesizer.close();

          res.setHeader("Content-Type", "audio/mpeg");
          res.setHeader("Content-Length", audioBuffer.length);
          return res.send(audioBuffer);
        } catch (e) {
          synthesizer.close();
          return res.status(500).json({ error: "Speech handling error", details: String(e) });
        }
      },
      (err) => {
        synthesizer.close();
        return res.status(500).json({ error: "Speech error", details: String(err) });
      }
    );
  } catch (e) {
    return res.status(500).json({ error: "Speech setup error", details: String(e) });
  }
});

// ===== Word map (Hindi -> Hebrew) =====
app.post("/api/wordmap", async (req, res) => {
  const { sentence } = req.body || {};
  if (!sentence) return res.status(400).json({ error: "Missing sentence" });

  const words = String(sentence).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return res.json({ words: [] });

  const prompt = `
את/ה מתרגם/ת להעברית בלבד.
החזר/י JSON בלבד, בדיוק בפורמט:
{"words":[{"hi":"...","he":"..."}, ...]}

חוקים (חשוב מאוד):
- "hi" חייב להיות בדיוק המילה כפי שמופיעה ברשימה שאני נותנת לך.
- "he" חייב להיות בעברית בלבד (אותיות עבריות). אסור אנגלית.
- "he" תרגום קצר (מילה אחת או עד 3 מילים).
- אם זו מילת יחס/חיבור/כינוי וכו' שאין לה תרגום עצמאי, תן משמעות קצרה בעברית.
- אל תוסיף שום טקסט מעבר ל-JSON. בלי הסברים. בלי Markdown.

רשימת המילים (בסדר הזה, בדיוק):
${words.map((w, i) => `${i + 1}. ${w}`).join("\n")}
`.trim();

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
    });

    const raw = (completion.choices[0].message.content || "").trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start >= 0 && end > start) parsed = JSON.parse(raw.slice(start, end + 1));
      else throw new Error("Failed to parse JSON from model");
    }

    const out = Array.isArray(parsed?.words) ? parsed.words : [];

    const normalized = words.map((w, idx) => {
      const item = out[idx];
      let he = item && item.he ? String(item.he) : "";
      const hasHebrew = /[\u0590-\u05FF]/.test(he);
      if (!hasHebrew) he = "";
      return { hi: w, he };
    });

    res.json({ words: normalized });
  } catch (e) {
    res.status(500).json({ error: "Wordmap error", details: String(e) });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
