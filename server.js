// server.js – Oplend AI

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

// CORS – dozvoli samo tvoj sajt (po potrebi dodaj još domene)
app.use(
  cors({
    origin: [
      "https://oplend.com",
      "https://www.oplend.com",
    ],
  })
);

// -------- ENV VARS --------
const {
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
} = process.env;

// OpenAI client
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// Supabase client (može biti null ako env nije postavljen)
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

// -------- PROJECT CONFIGS --------
const PROJECTS = {
  burek01: {
    lang: "de",
    title: "Burek – Online-Bestellung",
    pricing: { kaese: 3.5, fleisch: 4.0, kartoffeln: 3.5 },
    systemPrompt: `
Du bist ein Bestell-Assistent für eine Bäckerei. Du nimmst ausschließlich Bestellungen für:
1) Burek mit Käse
2) Burek mit Fleisch
3) Burek mit Kartoffeln

Regeln:
- Antworte immer auf Deutsch, höflich und klar.
- Frage nach Sorte(n), Anzahl, Abholzeit, Name, Telefonnummer.
- Erkläre kurz die Preise, wenn es passt.
- Erstelle am Ende eine klare Zusammenfassung der Bestellung.
- Versuche, den Gesamtpreis anhand der Preisliste zu berechnen.
- Keine anderen Produkte anbieten.
    `,
  },
  // ovdje kasnije možeš dodati npr. frizer01, pizza01 itd.
};

// -------- WIDGET.JS --------
app.get("/widget.js", (req, res) => {
  const js = `
(function(){
  const script = document.currentScript;
  const projectId = script.getAttribute('data-project') || 'burek01';
  const host = script.src.split("/widget.js")[0];

  // Create widget box
  const box = document.createElement('div');
  box.style.cssText = "max-width:900px;margin:0 auto;border:1px solid #ddd;border-radius:10px;overflow:hidden;font-family:Arial, sans-serif";

  box.innerHTML = \`
    <div style="padding:14px 16px;border-bottom:1px solid #eee;background:white">
      <h2 style="margin:0;font-size:22px">Chat</h2>
      <div id="opl-desc" style="margin-top:6px;color:#555;font-size:14px"></div>
    </div>

    <div id="opl-chat" style="height:60vh;overflow:auto;padding:12px;background:#fafafa"></div>

    <div style="display:flex;gap:8px;padding:12px;border-top:1px solid #eee;background:white">
      <textarea id="opl-in" placeholder="Nachricht..." style="flex:1;min-height:44px;border:1px solid #ddd;border-radius:8px;padding:10px"></textarea>
      <button id="opl-send" style="padding:10px 14px;border:1px solid #222;background:#222;color:white;border-radius:8px;cursor:pointer">Senden</button>
    </div>
  \`;

  script.parentNode.insertBefore(box, script);

  const chat = document.getElementById('opl-chat');
  const input = document.getElementById('opl-in');
  const sendBtn = document.getElementById('opl-send');
  const desc = document.getElementById('opl-desc');

  function add(role, text){
    const row = document.createElement('div');
    row.style.margin = "8px 0";
    row.style.display = "flex";
    row.style.justifyContent = role === 'user' ? 'flex-end' : 'flex-start';

    const b = document.createElement('div');
    b.style.maxWidth = "75%";
    b.style.padding = "10px 12px";
    b.style.borderRadius = "12px";
    b.style.whiteSpace = "pre-wrap";
    b.style.border = "1px solid " + (role === 'user' ? "#d6e3ff" : "#eee");
    b.style.background = role === 'user' ? "#e8f0ff" : "white";
    b.textContent = text;

    row.appendChild(b);
    chat.appendChild(row);
    chat.scrollTop = chat.scrollHeight;
  }

  // Load config
  fetch(host + "/api/projects/" + projectId + "/config")
    .then(r => r.json())
    .then(cfg => {
      desc.textContent = cfg.description || "";
      add("assistant", cfg.welcome || "Willkommen! Was darf’s sein?");
    });

  async function send(){
    const text = input.value.trim();
    if(!text) return;

    input.value = "";
    add("user", text);

    // "Thinking" bubble
    const row = document.createElement("div");
    row.style.margin = "8px 0";
    row.innerHTML = "<div style='padding:10px 12px;border-radius:12px;border:1px solid #eee;background:white'>…</div>";
    chat.appendChild(row);
    chat.scrollTop = chat.scrollHeight;
    const bubble = row.querySelector("div");

    try {
      const r = await fetch(host + "/api/chat", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ projectId, message: text })
      });
      const j = await r.json();

      // reply + (opcionalno) total
      let replyText = j.reply || "OK.";
      if (j.total) {
        replyText += "\\n\\nVorläufiger Gesamtpreis: " +
          Number(j.total).toFixed(2) +
          " € (Richtwert, Zahlung bei Abholung).";
      }

      bubble.textContent = replyText;
    } catch (err) {
      bubble.textContent = "Es tut mir leid, ein Fehler ist aufgetreten.";
      console.error(err);
    }
  }

  sendBtn.onclick = send;
  input.addEventListener("keydown", e => {
    if(e.key === "Enter" && !e.shiftKey){
      e.preventDefault();
      send();
    }
  });
})();
`;
  res.setHeader("Content-Type", "application/javascript");
  res.send(js);
});

// -------- PROJECT CONFIG ENDPOINT --------
app.get("/api/projects/:id/config", (req, res) => {
  const p = PROJECTS[req.params.id] || PROJECTS["burek01"];

  res.json({
    title: p.title,
    description: "Bestellen Sie Burek: Käse, Fleisch, Kartoffeln.",
    welcome: "Willkommen! Bitte Sorte und Anzahl angeben.",
    pricing: p.pricing,
  });
});

// -------- CHAT ENDPOINT --------
app.post("/api/chat", async (req, res) => {
  try {
    const { projectId = "burek01", message } = req.body || {};
    const p = PROJECTS[projectId] || PROJECTS["burek01"];

    // 1) Poruke za OpenAI
    const messages = [
      { role: "system", content: p.systemPrompt },
      { role: "user", content: message },
    ];

    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",        // možeš promijeniti model ako želiš
      messages,
    });

    let reply = ai.choices?.[0]?.message?.content || "OK.";

    // 2) Grubi parsing poruke za količine (DE)
    const text = (message || "").toLowerCase();

    const getQty = (patterns) => {
      for (const pat of patterns) {
        const re = new RegExp("(\\d+)\\s*(x|×)?\\s*" + pat, "i");
        const m = text.match(re);
        if (m) return Number(m[1]) || 0;
      }
      return 0;
    };

    const qtyKaese = getQty(["käse", "kaese"]);
    const qtyFleisch = getQty(["fleisch"]);
    const qtyKartoffeln = getQty(["kartoffel", "kartoffeln"]);

    const prices = p.pricing || {};
    const total =
      qtyKaese * (prices.kaese || 0) +
      qtyFleisch * (prices.fleisch || 0) +
      qtyKartoffeln * (prices.kartoffeln || 0);

    // 3) Dodaj informaciju o cijeni u reply (ako ima smisla)
    if (total > 0) {
      const parts = [];
      if (qtyKaese) parts.push(`${qtyKaese}× Käse`);
      if (qtyFleisch) parts.push(`${qtyFleisch}× Fleisch`);
      if (qtyKartoffeln) parts.push(`${qtyKartoffeln}× Kartoffeln`);

      reply += `

Vorläufiger Gesamtpreis für ${parts.join(
        ", "
      )}: ${total.toFixed(2)} € (Richtwert, Zahlung bei Abholung).`;
    }

    // 4) Spremi u Supabase (ako je konfigurisan)
    if (supabase) {
      try {
        await supabase.from("orders").insert({
          project_id: projectId,
          user_message: message,
          ai_reply: reply,
          items: {
            kaese: qtyKaese,
            fleisch: qtyFleisch,
            kartoffeln: qtyKartoffeln,
          },
          total: total > 0 ? total : null,
        });
      } catch (dbErr) {
        console.error("Supabase insert error:", dbErr);
      }
    }

    // 5) Pošalji klijentu
    res.json({ reply, total: total > 0 ? total : null });
  } catch (e) {
    console.error("CHAT ERROR:", e);
    res.status(500).json({ error: e.message });
  }
});

// -------- ROOT --------
app.get("/", (req, res) => {
  res.send("Oplend AI – running");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port " + port));
