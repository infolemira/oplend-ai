// server.js – Oplend AI mit History-Unterstützung (clean)

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// --- osnovna Express postavka ---
const app = express();
app.use(express.json());

// CORS – dozvoli tvoj sajt (po potrebi dodaj još domene)
app.use(
  cors({
    origin: ["https://oplend.com", "https://www.oplend.com"],
  })
);

// --- ENV varijable ---
const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

// OpenAI client
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Supabase client (može biti null ako env nije postavljen)
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

// --- Konfiguracije projekata ---
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

REGELN (sehr wichtig):
- Antworte immer auf Deutsch, höflich und klar.
- Frage zu Beginn nach Sorte(n) und Anzahl, falls der Kunde das noch nicht genannt hat.
- Wenn der Kunde bereits Sorte(n) UND Anzahl genannt hat (z.B. "2x Käse, 1x Fleisch"),
  DANN STELLE DIESE FRAGEN NICHT NOCHMAL.
- Danach frage nur noch nach: Abholzeit, Name, Telefonnummer.
- Sobald du alle Informationen hast (Sorten + Anzahl + Abholzeit + Name + Telefonnummer),
  ERSTELLE EINE VOLLSTÄNDIGE BESTELLBESTÄTIGUNG in klarer Liste.
- Wiederhole dabei NICHT mehr dieselben Fragen, sondern fasse alles zusammen.
- Berechne den Gesamtpreis anhand der Preisliste (Käse 3,50 €, Fleisch 4,00 €, Kartoffeln 3,50 €)
  und gib den Betrag in Euro an.
- Frage den Kunden am Ende nur noch nach einer kurzen Bestätigung ("Ja, bestätigen").
- Biete keine anderen Produkte an.
    `,
  },
};

// --- Pomoćna funkcija: parsiranje količina iz CIJELOG razgovora ---
function parseQuantitiesFromConversation(history, lastMessage) {
  const allText =
    (history || [])
      .filter((m) => m && typeof m.content === "string")
      .map((m) => m.content)
      .join("\n") +
    "\n" +
    (lastMessage || "");

  const text = allText.toLowerCase();

  const extract = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) || 0 : 0;
  };

  // Dozvoljavamo do ~25 nedigitalnih znakova između broja i ključne riječi,
  // npr. "2x Burek mit Käse", "1 x mit Fleisch", "3 Stück Burek mit Kartoffeln" itd.
  const kaese = extract(/(\d+)\s*(?:x|×)?[^\d\n]{0,25}(käse|kaese)/i);
  const fleisch = extract(/(\d+)\s*(?:x|×)?[^\d\n]{0,25}fleisch/i);
  const kartoffeln = extract(/(\d+)\s*(?:x|×)?[^\d\n]{0,25}kartoffeln?/i);

  return { kaese, fleisch, kartoffeln };
}

// --- WIDGET.JS endpoint (skripta koju ubacuješ u DNN) ---
app.get("/widget.js", (req, res) => {
  const js = `
(function(){
  const script = document.currentScript;
  const projectId = script.getAttribute('data-project') || 'burek01';
  const host = script.src.split("/widget.js")[0];

  // History poruka (user + assistant) – šaljemo na backend
  const history = [];

  // Kreiraj box za chat
  const box = document.createElement('div');
  box.style.cssText = "max-width:900px;margin:0 auto;border:1px solid #ddd;border-radius:10px;overflow:hidden;font-family:Arial, sans-serif";

  box.innerHTML = "<div style=\\"padding:14px 16px;border-bottom:1px solid #eee;background:white\\">" +
    "<h2 style=\\"margin:0;font-size:22px\\">Chat</h2>" +
    "<div id=\\"opl-desc\\" style=\\"margin-top:6px;color:#555;font-size:14px\\"></div>" +
    "</div>" +
    "<div id=\\"opl-chat\\" style=\\"height:60vh;overflow:auto;padding:12px;background:#fafafa\\"></div>" +
    "<div style=\\"display:flex;gap:8px;padding:12px;border-top:1px solid #eee;background:white\\">" +
    "<textarea id=\\"opl-in\\" placeholder=\\"Nachricht...\\" style=\\"flex:1;min-height:44px;border:1px solid #ddd;border-radius:8px;padding:10px\\"></textarea>" +
    "<button id=\\"opl-send\\" style=\\"padding:10px 14px;border:1px solid #222;background:#222;color:white;border-radius:8px;cursor:pointer\\">Senden</button>" +
    "</div>";

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

  // Učitaj opis / welcome poruku
  fetch(host + "/api/projects/" + projectId + "/config")
    .then(r => r.json())
    .then(cfg => {
      const welcome = cfg.welcome || "Willkommen! Was darf’s sein?";
      desc.textContent = cfg.description || "";
      add("assistant", welcome);
      history.push({ role: "assistant", content: welcome });
    });

  async function send(){
    const text = input.value.trim();
    if(!text) return;

    input.value = "";
    add("user", text);
    history.push({ role: "user", content: text });

    // "Thinking" balon
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
        body: JSON.stringify({ projectId, message: text, history })
      });
      const j = await r.json();

      var replyText = j.reply || "OK.";
      if (j.total) {
        replyText += "\\n\\nVorläufiger Gesamtpreis: " +
          Number(j.total).toFixed(2) +
          " € (Richtwert, Zahlung bei Abholung).";
      }

      bubble.textContent = replyText;
      history.push({ role: "assistant", content: replyText });

    } catch (err) {
      bubble.textContent = "Es tut mir leid, ein Fehler ist aufgetreten.";
      console.error(err);
    }
  }

  sendBtn.onclick = send;
  input.addEventListener("keydown", function(e){
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

// --- Config endpoint za widget ---
app.get("/api/projects/:id/config", (req, res) => {
  const p = PROJECTS[req.params.id] || PROJECTS["burek01"];

  res.json({
    title: p.title,
    description: "Bestellen Sie Burek: Käse, Fleisch, Kartoffeln.",
    welcome: "Willkommen! Bitte Sorte und Anzahl angeben.",
    pricing: p.pricing,
  });
});

// --- CHAT endpoint sa history podrškom ---
app.post("/api/chat", async (req, res) => {
  try {
    const {
      projectId = "burek01",
      message,
      history = [],
    } = req.body || {};

    const p = PROJECTS[projectId] || PROJECTS["burek01"];

    // 1) pripremi history poruke (dozvoli samo user/assistant)
    const safeHistory = Array.isArray(history)
      ? history
          .filter((m) => m && typeof m.content === "string")
          .map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
          }))
      : [];

    // 2) OpenAI poruke: system + history + nova user poruka
    const messages = [
      { role: "system", content: p.systemPrompt },
      ...safeHistory,
      { role: "user", content: message || "" },
    ];

    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
    });

    let reply = ai.choices?.[0]?.message?.content || "OK.";

    // 3) Parsiraj količine iz cijelog razgovora
    const { kaese, fleisch, kartoffeln } = parseQuantitiesFromConversation(
      safeHistory.filter((m) => m.role === "user"),
      message || ""
    );
    const prices = p.pricing || {};

    const total =
      kaese * (prices.kaese || 0) +
      fleisch * (prices.fleisch || 0) +
      kartoffeln * (prices.kartoffeln || 0);

    if (total > 0) {
      const parts = [];
  if (kaese) parts.push(kaese + "x Käse");
if (fleisch) parts.push(fleisch + "x Fleisch");
if (kartoffeln) parts.push(kartoffeln + "x Kartoffeln");

      if (!reply.includes("Gesamtpreis")) {
        reply +=
          "\\n\\nVorläufiger Gesamtpreis für " +
          parts.join(", ") +
          ": " +
          total.toFixed(2) +
          " € (Richtwert, Zahlung bei Abholung).";
      }
    }

    // 4) Spremi u Supabase (ako je dostupno)
    if (supabase) {
      try {
        await supabase.from("orders").insert({
          project_id: projectId,
          user_message: message,
          ai_reply: reply,
          items: {
            kaese,
            fleisch,
            kartoffeln,
          },
          total: total > 0 ? total : null,
        });
      } catch (dbErr) {
        console.error("Supabase insert error:", dbErr);
      }
    }

    res.json({ reply, total: total > 0 ? total : null });
  } catch (e) {
    console.error("CHAT ERROR:", e);
    res.status(500).json({ error: e.message });
  }
});

// --- Root ---
app.get("/", (req, res) => {
  res.send("Oplend AI – running");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port " + port));
