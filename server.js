// server.js – Oplend AI (multi-language + history + mobile-ready)

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// --- Express app ---
const app = express();
app.use(express.json());

// --- CORS: dozvoli sve --- (fix za mobilni)
app.use(
  cors({
    origin: (origin, callback) => {
      callback(null, true);
    },
  })
);

// --- ENV varijable ---
const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

// OpenAI client
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Supabase client
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

// --- Projekti ---
const PROJECTS = {
  burek01: {
    lang: "multi",
    title: "Burek – Online-Bestellung",
    pricing: { kaese: 3.5, fleisch: 4.0, kartoffeln: 3.5 },
    systemPrompt: `
Du bist ein Bestell-Assistent für eine Bäckerei. Du bearbeitest ausschließlich Bestellungen für:
1) Burek mit Käse
2) Burek mit Fleisch
3) Burek mit Kartoffeln

SPRACHE:
- Kunde darf in mehreren Sprachen schreiben
- Antworte IMMER in der Sprache der letzten Kunden-Nachricht

ACTIONS:
- Neue Bestellung aufnehmen
- Bestellung erweitern/reduzieren/stornieren
- Rückfragen beantworten

REGELN:
- Preise: Käse 3,5€, Fleisch 4€, Kartoffeln 3,5€
- Keine anderen Produkte anbieten
- Klare Bestellbestätigung
`,
  },
};

// --- Helper: parsiranje količina ---
function parseQuantities(text) {
  const lower = (text || "").toLowerCase();
  const extract = (re) => {
    const m = lower.match(re);
    return m ? Number(m[1]) || 0 : 0;
  };
  const kaese = extract(/(\d+)\s*(?:x|mal)?[^\d\n]{0,25}(käse|kaese|sir)/i);
  const fleisch = extract(/(\d+)\s*(?:x|mal)?[^\d\n]{0,25}(fleisch|meso)/i);
  const kartoffeln = extract(/(\d+)\s*(?:x|mal)?[^\d\n]{0,25}(kartoffeln?|krumpir|krompir)/i);
  return { kaese, fleisch, kartoffeln };
}

function parseQuantitiesFromConversation(userHistory, lastMessage) {
  const allText =
    (userHistory || [])
      .filter((m) => m && typeof m.content === "string")
      .map((m) => m.content)
      .join("\n") +
    "\n" +
    (lastMessage || "");
  return parseQuantities(allText);
}

// --- Widget.js endpoint ---
app.get("/widget.js", (req, res) => {
  const js = `
(function(){
  const script = document.currentScript;
  const projectId = script.getAttribute('data-project') || 'burek01';
  const host = 'https://oplend-ai.onrender.com';

  const history = [];

  const box = document.createElement('div');
  box.style.cssText = "max-width:900px;margin:0 auto;border:1px solid #ddd;border-radius:10px;overflow:hidden;font-family:Arial, sans-serif";

  box.innerHTML = "<div style=\\"padding:14px 16px;border-bottom:1px solid #eee;background:white\\">" +
    "<h2 style=\\"margin:0;font-size:22px\\">Chat</h2>" +
    "<div id=\\"opl-desc\\" style=\\"margin-top:6px;color:#555;font-size:14px\\"></div>" +
    "</div>" +
    "<div id=\\"opl-chat\\" style=\\"height:60vh;overflow:auto;padding:12px;background:#fafafa\\"></div>" +
    "<div style=\\"display:flex;gap:8px;padding:12px;border-top:1px solid #eee;background:white\\">" +
    "<textarea id=\\"opl-in\\" placeholder=\\"Nachricht...\\" style=\\"flex:1;min-height:44px;border:1px solid #ddd;border-radius:8px;padding:10px\\"></textarea>" +
    "<button id=\\"opl-send\\" style=\\"padding:10px 16px;border:1px solid #222;background:#222;color:white;border-radius:8px;cursor:pointer\\">Senden</button>" +
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

  fetch(host + "/api/projects/" + projectId + "/config")
    .then(r=>r.json())
    .then(cfg=>{
      var welcome = cfg.welcome || "Willkommen! Was darf’s sein?";
      desc.textContent = cfg.description || "";
      add("assistant", welcome);
      history.push({ role: "assistant", content: welcome });
    });

  async function send(){
    var text = input.value.trim();
    if(!text) return;
    input.value = "";
    add("user", text);
    history.push({ role: "user", content: text });

    var row = document.createElement("div");
    row.style.margin = "8px 0";
    row.innerHTML = "<div style='padding:10px 12px;border-radius:12px;border:1px solid #eee;background:white'>…</div>";
    chat.appendChild(row);
    chat.scrollTop = chat.scrollHeight;
    var bubble = row.querySelector("div");

    try {
      var r = await fetch(host + "/api/chat", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ projectId:projectId, message:text, history:history })
      });
      var j = await r.json();
      var reply = j.reply || "OK.";
      bubble.textContent = reply;
      history.push({ role:"assistant", content:reply });
    } catch(err){
      bubble.textContent = "Fehler beim Senden.";
      console.error(err);
    }
  }

  sendBtn.onclick = send;
  input.addEventListener("keydown", function(e){
    if(e.key==="Enter" && !e.shiftKey){
      e.preventDefault();
      send();
    }
  });

})();
`;
  res.setHeader("Content-Type", "application/javascript");
  res.send(js);
});

// --- Config endpoint ---
app.get("/api/projects/:id/config", (req, res) => {
  const p = PROJECTS[req.params.id] || PROJECTS["burek01"];
  res.json({
    title: p.title,
    description: "Bestellen Sie Burek: Käse, Fleisch, Kartoffeln.",
    welcome: "Willkommen! Bitte Sorte und Anzahl angeben.",
    pricing: p.pricing,
  });
});

// --- Chat endpoint ---
app.post("/api/chat", async (req, res) => {
  try {
    const { projectId="burek01", message="", history=[] } = req.body || {};
    const p = PROJECTS[projectId] || PROJECTS["burek01"];
    const normalized = (message || "").trim().toLowerCase();

    const isClosing =
      normalized === "ok" || normalized.startsWith("danke") || normalized.startsWith("thanks") || normalized.startsWith("hvala");

    if (isClosing) {
      const reply = "Gerne, Ihre Bestellung ist gespeichert. Einen schönen Tag noch!";
      if (supabase) {
        try { await supabase.from("orders").insert({ project_id: projectId, user_message: message, ai_reply: reply, items: null, total: null }); } catch(e){console.error(e);}
      }
      return res.json({ reply, total:null });
    }

    const safeHistory = Array.isArray(history) ? history.filter(m=>m && typeof m.content==="string").map(m=>({role:m.role==="assistant"?"assistant":"user", content:m.content})) : [];

    const messagesForAI = [
      { role: "system", content: p.systemPrompt },
      ...safeHistory,
      { role: "user", content: message }
    ];

    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messagesForAI
    });

    let reply = ai.choices?.[0]?.message?.content || "OK.";

    const userHistory = safeHistory.filter(m=>m.role==="user");
    const { kaese, fleisch, kartoffeln } = parseQuantitiesFromConversation(userHistory, message);
    const prices = p.pricing || {};
    const total = kaese*(prices.kaese||0) + fleisch*(prices.fleisch||0) + kartoffeln*(prices.kartoffeln||0);

    if (total>0 && !reply.includes("Gesamtpreis")) {
      const parts=[];
      if(kaese) parts.push(kaese+"x Käse");
      if(fleisch) parts.push(fleisch+"x Fleisch");
      if(kartoffeln) parts.push(kartoffeln+"x Kartoffeln");
      reply+="\n\nVorläufiger Gesamtpreis ("+parts.join(", ")+"): "+total.toFixed(2)+" € (Richtwert, Zahlung bei Abholung).";
    }

    if(supabase){
      try { await supabase.from("orders").insert({ project_id: projectId, user_message: message, ai_reply: reply, items:{kaese,fleisch,kartoffeln}, total: total>0?total:null }); } catch(e){console.error(e);}
    }

    res.json({ reply, total: total>0?total:null });

  } catch(e){
    console.error("CHAT ERROR:", e);
    res.status(500).json({ error:e.message });
  }
});

// --- Root ---
app.get("/", (req,res)=>res.send("Oplend AI – running"));

// --- Start server ---
const port = process.env.PORT || 3000;
app.listen(port, ()=>console.log("Server running on port "+port));
