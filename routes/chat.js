const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const Exhibition = require("../models/Exhibition");

const router = express.Router();

/* ─────────────────────────────────────────────
   POST /api/chat/:exhibitionId
   Proxy visitor message to OpenRouter LLM,
   optionally return ElevenLabs TTS audio.
───────────────────────────────────────────── */
router.post("/:exhibitionId", async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ message: "message is required" });
    }

    // 1. Load exhibition context
    const exhibition = await Exhibition.findById(req.params.exhibitionId);
    if (!exhibition) {
      return res.status(404).json({ message: "Exhibition not found" });
    }
    if (!exhibition.aiShopkeeper?.enabled) {
      return res.status(403).json({ message: "AI Shopkeeper is not enabled for this exhibition" });
    }

    // 2. Build context from exhibition data
    const productContextLines = exhibition.slots
      .filter((s) => s.title)
      .map((s) => {
        const parts = [`- "${s.title}"`];
        if (s.artist) parts.push(`by ${s.artist}`);
        if (s.price) parts.push(`priced at ₹${s.price.toLocaleString("en-IN")}`);
        if (s.medium) parts.push(`(${s.medium})`);
        if (s.dimensions) parts.push(`dimensions: ${s.dimensions}`);
        if (s.year) parts.push(`year: ${s.year}`);
        if (s.description) parts.push(`— ${s.description}`);
        return parts.join(" ");
      })
      .join("\n");

    const systemPrompt = `You are a friendly and knowledgeable gallery assistant (shopkeeper) at the "${exhibition.name}" exhibition. You greet visitors warmly and help them with questions about the exhibition and its items.

${exhibition.aiShopkeeper.exhibitionStory ? `EXHIBITION STORY:\n${exhibition.aiShopkeeper.exhibitionStory}\n` : ""}
${productContextLines ? `ITEMS ON DISPLAY:\n${productContextLines}\n` : ""}
RULES:
- Keep responses concise (2-4 sentences max) since they will be spoken aloud.
- Be warm, enthusiastic, and helpful.
- If asked about an item not in the exhibition, politely say you only know about items in this exhibition.
- You can discuss pricing, materials, dimensions, artist background, and stories behind pieces.
- If the visitor asks something unrelated, gently steer them back to the exhibition.
- Never break character — you are a real gallery shopkeeper.`;

    // 3. Call OpenRouter LLM
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) {
      // Return a graceful fallback response if the key is missing instead of a hard 500 crash
      return res.json({
        reply: "I am currently taking a break! (Please ask the developer to add their OPENROUTER_API_KEY to the server/.env file).",
        ttsProvider: "browser"
      });
    }

    // Format the history array cleanly to reject any unwanted fields from frontend
    const formattedHistory = history.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content
    }));

    const llmResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://arteria.app",
        "X-Title": "Arteria Gallery Shopkeeper",
      },
      body: JSON.stringify({
        model: "openrouter/auto",
        messages: [
          { role: "system", content: systemPrompt },
          ...formattedHistory,
          { role: "user", content: message },
        ],
        temperature: 0.7,
      }),
    });

    if (!llmResponse.ok) {
      const errText = await llmResponse.text();
      console.error("OpenRouter error:", errText);
      return res.status(502).json({ message: "LLM request failed" });
    }

    const llmData = await llmResponse.json();
    
    let reply = llmData.choices?.[0]?.message?.content;
    if (!reply) {
      console.error("OpenRouter returning empty/error payload:", JSON.stringify(llmData, null, 2));
      reply = `OpenRouter API Error: ${JSON.stringify(llmData)}`;
    }

    // 4. Optional: ElevenLabs TTS
    const TTS_PROVIDER = (process.env.TTS_PROVIDER || "browser").toLowerCase();

    if (TTS_PROVIDER === "elevenlabs") {
      const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
      const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";

      if (!ELEVENLABS_API_KEY) {
        // Fallback to browser TTS if no key
        return res.json({ reply, ttsProvider: "browser" });
      }

      try {
        const ttsResponse = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
          {
            method: "POST",
            headers: {
              "xi-api-key": ELEVENLABS_API_KEY,
              "Content-Type": "application/json",
              Accept: "audio/mpeg",
            },
            body: JSON.stringify({
              text: reply,
              model_id: "eleven_turbo_v2_5",
              voice_settings: {
                stability: 0.5,
                similarity_boost: 0.75,
              },
            }),
          }
        );

        if (!ttsResponse.ok) {
          console.error("ElevenLabs error:", await ttsResponse.text());
          return res.json({ reply, ttsProvider: "browser" });
        }

        // Save audio to temp file and serve
        const audioBuffer = await ttsResponse.buffer();
        const audioFileName = `tts-${Date.now()}.mp3`;
        const audioPath = path.join(__dirname, "../uploads", audioFileName);
        fs.writeFileSync(audioPath, audioBuffer);

        // Clean up old TTS files (older than 5 min)
        const now = Date.now();
        const uploadsDir = path.join(__dirname, "../uploads");
        fs.readdirSync(uploadsDir)
          .filter((f) => f.startsWith("tts-") && f.endsWith(".mp3"))
          .forEach((f) => {
            const fPath = path.join(uploadsDir, f);
            const stat = fs.statSync(fPath);
            if (now - stat.mtimeMs > 5 * 60 * 1000) {
              fs.unlinkSync(fPath);
            }
          });

        return res.json({
          reply,
          ttsProvider: "elevenlabs",
          audioUrl: `/uploads/${audioFileName}`,
        });
      } catch (ttsErr) {
        console.error("ElevenLabs TTS error:", ttsErr);
        return res.json({ reply, ttsProvider: "browser" });
      }
    }

    // Default: browser TTS
    res.json({ reply, ttsProvider: "browser" });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ 
      message: "Server error", 
      errorInfo: err.message,
      stack: err.stack 
    });
  }
});

module.exports = router;
