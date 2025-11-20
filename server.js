// server.js – Oplend AI (više jezika + history + izmjene/storno + OK/Danke)

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// --- Express app ---
const app = express();
app.use(express.json());

// --- CORS: dozvoli Oplend domenu ---
app.use(
  cors({
    origin: ["https://oplend.com", "https://www.oplend.com"],
  })
);

// --- ENV varijable ---
const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

// OpenAI client
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Supabase client (samo ako su postavljene varijable)
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

// --- Konfiguracija projekta ---
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

SPRACHE (SEHR WICHTIG):
- Der Kunde darf in verschiedenen Sprachen schreiben (z.B. Deutsch, Englisch, Bosnisch, Kroatisch, Serbisch).
- Antworte IMMER in der gleichen Sprache wie in der LETZTEN Nachricht des Kunden:
  * Wenn der Kunde auf Deutsch schreibt -> antworte auf Deutsch.
  * Wenn der Kunde auf Englisch schreibt -> antworte auf Englisch.
  * Ako piše na bosanskom/hrvatskom/srpskom -> odgovaraj na tom jeziku.
- Ako je poruka miješana, izaberi glavni jezik poruke i drži se njega.
- Nemoj mijenjati jezik usred razgovora, osim ako korisnik to izričito zatraži.

DU KANNST FOLGENDE AKTIONEN AUSFÜHREN:
- Neue Bestellung aufnehmen
- Eine bestehende Bestellung ERWEITERN (zusätzliche Stücke)
- Eine bestehende Bestellung REDUZIEREN (weniger Stücke)
- Eine bestehende Bestellung KOMPLETT STORNIEREN
- Rückfragen zur bestehenden Bestellung beantworten (z.B. Zeit, Menge, Inhalt)

WICHTIGE REGELN:

1) NEUE BESTELLUNG
- Wenn noch keine Bestellung vorliegt, frage nach:
  - Sorten (Käse / Fleisch / Kartoffeln)
  - Stückzahlen
  - Abholzeit
  - Name
  - Telefonnummer
- Erkläre kurz die Preise, wenn es hilfreich ist.

2) BESTEHENDE BESTELLUNG ÄNDERN
- Achte auf Wörter wie: "noch", "zusätzlich", "mehr", "weniger", "abziehen", "reduzieren",
  "ändern", "korrigieren", "doch lieber", "stattdessen", "još", "više", "manje".
- Wenn der Kunde so eine Änderung beschreibt, gehe wie folgt vor:
  a) Sage in eigenen Worten, was du verstanden hast (z.B. "Sie möchten also einen Käse-Burek hinzufügen.").
  b) FRAGE NACH, ob es sich um:
     - eine ERGÄNZUNG zur bisherigen Bestellung handelt ("zusätzlich"),
     - oder um eine NEUE GESAMTZAHL ("insgesamt").
  c) Nachdem alles klar ist, fasse die AKTUELLE BESTELLUNG in einer Liste zusammen:
     - z.B. "2x Käse, 1x Fleisch, 1x Kartoffeln".
  d) Wenn sich durch die Änderung der Gesamtpreis ändert, nenne den NEUEN Gesamtpreis.

3) STORNIERUNG
- Achte auf Ausdrücke wie: "stornieren", "abbrechen", "komplett löschen", "doch keine Bestellung",
  "bitte alles annullieren", "keine Bureks mehr", "storno", "otkaži", "poništi".
- Bestätige eindeutig:
  - dass die Bestellung STORNIERT ist,
  - dass keine Ware vorbereitet wird.
- Frage optional, ob der Kunde eine neue Bestellung aufgeben möchte.

4) BESTELLBESTÄTIGUNG UND WEITERE FRAGEN
- Sobald alle Informationen vorliegen (Sorten + Stückzahlen + Abholzeit + Name + Telefonnummer),
  erstelle eine saubere Bestellbestätigung:
  - Auflistung der Sorten und Stücke
  - Abholzeit
  - Name
  - Telefonnummer
  - Gesamtpreis (siehe Preisliste unten)
  - Hinweis: sinngemäß "Die Bezahlung erfolgt bei Abholung." / "Plaćanje pri preuzimanju." / "Payment upon pickup."
- Wenn der Kunde NACH der Bestätigung weitere Fragen stellt (z.B. "Kann ich doch 1 Stück mehr nehmen?",
  "Da li mogu pomjeriti vrijeme preuzimanja?"), beantworte sie und passe die aktuelle Bestellung entsprechend an.

5) WENN DU ETWAS NICHT VERSTEHST
- Wenn die Nachricht unklar ist, rate NICHT.
- Stelle stattdessen eine konkrete Rückfrage, um zu klären, was genau der Kunde möchte.
  Beispiel: "Möchten Sie zusätzliche Stücke hinzufügen oder die Gesamtanzahl ändern?" /
           "Da li želite još bureka ili da smanjimo postojeću količinu?"

6) PREISE
- Verwende diese Preise:
  * Burek mit Käse: 3,50 €
  * Burek mit Fleisch: 4,00 €
  * Burek mit Kartoffeln: 3,50 €
- Wenn du einen Gesamtpreis nennst, stelle sicher, dass er zur aufgelisteten Bestellung passt.
- Die Anwendung rechnet zusätzlich selbst – deine Aufgabe ist, dem Kunden eine klare, konsistente Antwort zu geben.

7) EINSCHRÄNKUNG
- Biete KEINE anderen Produkte an.
- Antworte NICHT auf Themen außerhalb von Burek-Bestellungen (höflich ablenken).

ZIEL:
- Führe den Kunden so lange durch den Prozess, bis die Bestellung klar ist.
- Bleibe höflich ansprechbar, solange der Kunde noch Fragen zur Bestellung hat.
    `,
  },
};

// --- Pomoćna funkcija: parsiranje količina iz teksta ---
function parseQuantities(text) {
  const lower = (text || "").toLowerCase();

  const extract = (re) => {
    const m = lower.match(re);
    return m ? Number(m[1]) || 0 : 0;
  };

  const kaese = extract(/(\d+)\s*(?:x|mal)?[^\d\n]{0,25}(käse|kaese|sir)/i);
  const fleisch = extract(/(\d+)\s*(?:x|mal)?[^\d\n]{0,25}(fleisch|meso)/i);
  const kartoffeln = extract(
    /(\d+)\s*(?:x|mal)?[^\d\n]{0,25}(kartoffeln?|krumpir|krompir)/i
  );

  return { kaese, fleisch, kartoffeln };
}

// --- Parsiranje količina iz CIJELOG razgovora ---
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

// --- WIDGET.JS endpoint (chat s historyjem) ---
app.get("/widget.js", (req, res) => {
  const js = `
(function(){
  const script = document.currentScript;
  const projectId = script.getAttribute('data-project') || 'burek01';
  const host = script.src.split("/widget.js")[0];

  // History poruka (user + assistant)
  const history = [];

  // CHAT KUTIJA
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

  // UČITAJ CONFIG (opis + welcome)
  fetch(host + "/api/projects/" + projectId + "/config")
    .then(function(r){ return r.json(); })
    .then(function(cfg){
      var welcome = cfg.welcome || "Willkommen! Was darf’s sein?";
      desc.textContent = cfg.description || "";
      add("assistant", welcome);
      history.push({ role: "assistant", content: welcome });
    })
    .catch(function(err){
      console.error("Config error:", err);
      var welcome = "Willkommen! Was darf’s sein?";
      add("assistant", welcome);
      history.push({ role: "assistant", content: welcome });
    });

  // SLANJE PORUKE
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
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          projectId: projectId,
          message: text,
          history: history
        })
      });

      var j = await r.json();
      var reply = j.reply || "OK.";

      bubble.textContent = reply;
      history.push({ role: "assistant", content: reply });

    } catch (err) {
      bubble.textContent = "Es tut mir leid, ein Fehler ist aufgetreten.";
      console.error("Chat error:", err);
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
      message = "",
      history = [],
    } = req.body || {};
    const p = PROJECTS[projectId] || PROJECTS["burek01"];

    const normalized = (message || "").trim().toLowerCase();

    // --- 1) Kratke "OK / Danke / Thanks / Hvala" poruke -> odgovor bez OpenAI ---
    const isClosing =
      normalized &&
      (
        normalized === "ok" ||
        normalized === "ok!" ||
        normalized === "okay" ||
        normalized === "okay!" ||
        normalized === "okej" ||
        normalized === "okej!" ||
        normalized.startsWith("danke") ||
        normalized.startsWith("vielen dank") ||
        normalized.includes("danke,") ||
        normalized.includes("danke.") ||
        normalized.includes("danke!") ||
        normalized === "thanks" ||
        normalized === "thanks!" ||
        normalized === "thank you" ||
        normalized === "thank you!" ||
        normalized.startsWith("hvala") ||
        normalized.includes("hvala!")
      );

    if (isClosing) {
      const reply =
        "Gerne, Ihre Bestellung ist gespeichert. Einen schönen Tag noch und bis zum nächsten Mal!";

      if (supabase) {
        try {
          await supabase.from("orders").insert({
            project_id: projectId,
            user_message: message,
            ai_reply: reply,
            items: null,
            total: null,
          });
        } catch (dbErr) {
          console.error("Supabase insert error (closing):", dbErr);
        }
      }

      return res.json({ reply, total: null });
    }

    // --- History priprema za OpenAI ---
    const safeHistory = Array.isArray(history)
      ? history
          .filter((m) => m && typeof m.content === "string")
          .map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
          }))
      : [];

    const messagesForAI = [
      { role: "system", content: p.systemPrompt },
      ...safeHistory,
      { role: "user", content: message },
    ];

    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messagesForAI,
    });

    let reply = ai.choices?.[0]?.message?.content || "OK.";

    // Izračunaj količine i total iz CIJELOG user historyja + zadnje poruke
    const userHistory = safeHistory.filter((m) => m.role === "user");
    const { kaese, fleisch, kartoffeln } = parseQuantitiesFromConversation(
      userHistory,
      message
    );
    const prices = p.pricing || {};

    const total =
      kaese * (prices.kaese || 0) +
      fleisch * (prices.fleisch || 0) +
      kartoffeln * (prices.kartoffeln || 0);

    if (total > 0 && !reply.includes("Gesamtpreis")) {
      const parts = [];
      if (kaese) parts.push(kaese + "x Käse");
      if (fleisch) parts.push(fleisch + "x Fleisch");
      if (kartoffeln) parts.push(kartoffeln + "x Kartoffeln");

      reply +=
        "\n\nVorläufiger Gesamtpreis für die aktuelle Bestellung (" +
        parts.join(", ") +
        "): " +
        total.toFixed(2) +
        " € (Richtwert, Zahlung bei Abholung).";
    }

    // Spremi u Supabase (ako je dostupan)
    if (supabase) {
      try {
        await supabase.from("orders").insert({
          project_id: projectId,
          user_message: message,
          ai_reply: reply,
          items: { kaese, fleisch, kartoffeln },
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

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port " + port));
