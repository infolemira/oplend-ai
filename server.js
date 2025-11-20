// server.js – stable version (widget.js mobile fix + demo page + multi-language + "je li to sve" flow)

import express from "express";
import cors from "cors";
import OpenAI from "openai";

// ----------------------------
//  APP & CONFIG
// ----------------------------

const app = express();
app.use(express.json());
app.use(cors({ origin: "*", methods: "*", allowedHeaders: "*" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
- Antworte IMMER in der gleichen Sprache wie in der LETZTEN Nachricht des Kunden:
  * Wenn der Kunde auf Deutsch schreibt → antworte auf Deutsch.
  * Wenn der Kunde auf Englisch schreibt → antworte auf Englisch.
  * Ako piše na bosanskom/hrvatskom/srpskom → odgovaraj na tom jeziku.
- Nemoj mijenjati jezik usred razgovora, osim ako korisnik to izričito zatraži.

---------------------------------------------
DEIN VERKAUFS-FLOW (OBAVEZAN REDOSLIJED)
---------------------------------------------

1) KADA KLIJENT NAPIŠE NARUDŽBU (navede vrste + količine)
- Ukratko ponovi narudžbu (npr: „Dakle, želite 2x sir i 1x meso.“).
- ODMAH NAKON TOGA obavezno postavi pitanje:
  - DE: „Ist das alles?“
  - EN: „Is that everything?“
  - BHS: „Da li je to sve?“ / „Je li to sve?“

→ NE PITAJ za vrijeme, ime ili telefon DOK KLIJENT NE POTVRDI da je to sve.

2) KADA KLIJENT POTVRDI DA JE TO SVE
Prepoznaj odgovore tipa:
- DE: „Ja, das ist alles“, „das wars“, „ja, das war’s“, „ja, das ist alles, danke“
- BHS: „da, to je sve“, „to je sve“, „je, to je sve“, „to je to“
- EN: „yes, that’s all“, „that’s all“, „yes, that’s it“

TADA OBAVEZNO PITAJ:
  - DE: „Wann möchten Sie Ihre Bestellung abholen?“
  - EN: „When would you like to pick up your order?“
  - BHS: „Kada želite doći po narudžbu?“ / „U koliko sati dolazite po narudžbu?“

3) KADA KLIJENT NAPIŠE VRIJEME PREUZIMANJA
- Potvrdi vrijeme preuzimanja (npr: „Preuzimanje u 15:30.“ / „Abholung um 15:30.“).
- Zatim OBAVEZNO PITAJ:
  - DE: „Wie ist Ihr Name und Ihre Telefonnummer?“
  - EN: „What is your name and phone number?“
  - BHS: „Kako se zovete i koji je vaš broj telefona?“

4) KADA IME I BROJ TELEFONA BUDU POZNATI
Napravi završnu potvrdu:
- sve vrste + količine bureka
- okvirni ukupni iznos prema cjenovniku
- vrijeme preuzimanja
- ime i telefon
- napomena o plaćanju:
  - DE: „Bezahlung bei Abholung.“
  - EN: „Payment upon pickup.“
  - BHS: „Plaćanje pri preuzimanju.“

---------------------------------------------
DODATNE VAŽNE SMJERNICE
---------------------------------------------

• Ako klijent mijenja narudžbu (više/manje), obavezno razjasni:
  - da li želi DODATI komade (add-on),
  - ili želi NOVU UKUPNU količinu (insgesamt / ukupno).

• Ako nešto nije jasno, ne nagađaj — pitaj dodatno, kratko i konkretno.

• Ograničenje:
  - NE nudi druge proizvode.
  - NE razgovaraj o temama koje nisu vezane za narudžbe bureka (ljubazno vrati razgovor na narudžbu).

---------------------------------------------
CIJENE
---------------------------------------------
Käse: 3,50 €
Fleisch: 4,00 €
Kartoffeln: 3,50 €

---------------------------------------------
CILJ
---------------------------------------------
- Jasna narudžba (vrste + količine)
- Provjera „je li to sve?“
- Dogovoreno vrijeme preuzimanja
- Ime i broj telefona
- Završna potvrda sa ukupnom cijenom i napomenom o plaćanju.
    `,
  },
};

// ----------------------------
//  HELPERS
// ----------------------------

function parseQuantities(text) {
  const t = (text || "").toLowerCase();

  const get = (regex) => {
    const m = t.match(regex);
    return m ? Number(m[1]) : 0;
  };

  return {
    kaese: get(/(\d+).{0,15}(käse|kaese|sir)/),
    fleisch: get(/(\d+).{0,15}(fleisch|meso)/),
    kartoffeln: get(/(\d+).{0,20}(kartoffeln?|krompir|krumpir)/),
  };
}

function detectLang(text) {
  const t = (text || "").toLowerCase();
  if (/[šđćčž]/.test(t)) return "bhs";
  if (t.includes(" der ") || t.includes(" die ") || t.includes(" das ")) return "de";
  if (t.includes("thanks") || t.includes("thank")) return "en";
  return "auto";
}

// ----------------------------
//  CONFIG ENDPOINT
// ----------------------------

app.get("/api/projects/:id/config", (req, res) => {
  const p = PROJECTS[req.params.id] || PROJECTS["burek01"];
  res.json({
    title: p.title,
    description: "Bestellen Sie Burek: Käse | Fleisch | Kartoffeln",
    welcome: "Willkommen! Bitte Sorte und Anzahl angeben.",
    pricing: p.pricing,
  });
});

// ----------------------------
//  CHAT ENDPOINT
// ----------------------------

app.post("/api/chat", async (req, res) => {
  try {
    const { projectId = "burek01", message = "", history = [] } = req.body;
    const p = PROJECTS[projectId] || PROJECTS["burek01"];

    const safeHistory = Array.isArray(history)
      ? history.filter((m) => m && typeof m.content === "string")
      : [];

    const lastUser =
      safeHistory.filter((x) => x.role === "user").pop()?.content || message;
    const lang = detectLang(lastUser);

    const languageInstruction =
      lang === "de"
        ? "Antworte ausschließlich auf Deutsch."
        : lang === "en"
        ? "Respond strictly in English."
        : lang === "bhs"
        ? "Odgovaraj isključivo na bosanskom/hrvatskom/srpskom jeziku."
        : "Antwort in der Sprache der letzten Benutzer-Nachricht.";

    const messagesForAI = [
      { role: "system", content: p.systemPrompt },
      { role: "system", content: languageInstruction },
      ...safeHistory, // VEĆ sadrži zadnju user poruku — NE dodajemo je duplo
    ];

    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messagesForAI,
    });

    let reply = ai.choices?.[0]?.message?.content || "OK.";

    // Izračun cijene
    const allUserText =
      safeHistory
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n") + "\n" + message;

    const qty = parseQuantities(allUserText);
    const prices = p.pricing;

    const total =
      qty.kaese * prices.kaese +
      qty.fleisch * prices.fleisch +
      qty.kartoffeln * prices.kartoffeln;

    if (total > 0 && !reply.includes("€")) {
      const parts = [];
      if (qty.kaese) parts.push(`${qty.kaese}x Käse`);
      if (qty.fleisch) parts.push(`${qty.fleisch}x Fleisch`);
      if (qty.kartoffeln) parts.push(`${qty.kartoffeln}x Kartoffeln`);

      reply += `

Gesamtpreis (${parts.join(", ")}): ${total.toFixed(2)} €.`;
    }

    return res.json({ reply, total: total || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
//  widget.js (sa mobile fix)
// ----------------------------

app.get("/widget.js", (req, res) => {
  const js = `
(function(){
  const script = document.currentScript;
  const projectId = script.getAttribute("data-project") || "burek01";
  const host = script.src.split("/widget.js")[0];

  const history = [];

  const box = document.createElement("div");
  box.style.cssText = "max-width:900px;margin:0 auto;border:1px solid #ddd;border-radius:10px;overflow:hidden;font-family:Arial";

  box.innerHTML =
    "<div style='padding:14px 16px;border-bottom:1px solid #eee;background:white'>" +
    "<h2 style='margin:0;font-size:22px'>Chat</h2>" +
    "<div id='opl-desc' style='margin-top:6px;color:#555;font-size:14px'></div>" +
    "</div>" +
    "<div id='opl-chat' style='height:60vh;overflow:auto;padding:12px;background:#fafafa'></div>" +
    "<div style='display:flex;gap:8px;padding:12px;border-top:1px solid #eee;background:white'>" +
    "<textarea id='opl-in' placeholder='Nachricht...' style='flex:1;min-height:44px;border:1px solid #ddd;border-radius:8px;padding:10px'></textarea>" +
    "<button id='opl-send' type='button' style='padding:10px 16px;border:1px solid #222;background:#222;color:white;border-radius:8px;cursor:pointer'>Senden</button>" +
    "</div>";

  script.parentNode.insertBefore(box, script);

  const chat = document.getElementById("opl-chat");
  const input = document.getElementById("opl-in");
  const sendBtn = document.getElementById("opl-send");
  const desc = document.getElementById("opl-desc");

  function add(role, text){
    const row = document.createElement("div");
    row.style.margin = "8px 0";
    row.style.display = "flex";
    row.style.justifyContent = role === "user" ? "flex-end" : "flex-start";

    const bubble = document.createElement("div");
    bubble.style.maxWidth = "75%";
    bubble.style.padding = "10px 12px";
    bubble.style.borderRadius = "12px";
    bubble.style.whiteSpace = "pre-wrap";
    bubble.style.border = "1px solid " + (role === "user" ? "#d6e3ff" : "#eee");
    bubble.style.background = role === "user" ? "#e8f0ff" : "white";
    bubble.textContent = text;

    row.appendChild(bubble);
    chat.appendChild(row);
    chat.scrollTop = chat.scrollHeight;
  }

  // Load config
  fetch(host + "/api/projects/" + projectId + "/config")
    .then(r => r.json())
    .then(cfg => {
      const welcome = cfg.welcome;
      desc.textContent = cfg.description;
      add("assistant", welcome);
      history.push({ role:"assistant", content: welcome });
    });

  async function send(){
    const text = input.value.trim();
    if (!text) return;
    input.value = "";

    add("user", text);
    history.push({ role:"user", content: text });

    const row = document.createElement("div");
    row.style.margin = "8px 0";
    row.innerHTML = "<div style='padding:10px 12px;border-radius:12px;border:1px solid #eee;background:white'>…</div>";
    chat.appendChild(row);
    chat.scrollTop = chat.scrollHeight;
    const bubble = row.querySelector("div");

    try {
      const r = await fetch(host + "/api/chat", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ projectId, message: text, history })
      });

      const j = await r.json();
      bubble.textContent = j.reply;
      history.push({ role:"assistant", content: j.reply });

    } catch (err) {
      bubble.textContent = "Fehler beim Senden.";
    }
  }

  sendBtn.onclick = send;

  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey){
      e.preventDefault();
      send();
    }
  });
})();
`;
  res.setHeader("Content-Type", "application/javascript");
  res.send(js);
});

// ----------------------------
//  DEMO PAGE
// ----------------------------

app.get("/demo", (req, res) => {
  res.send(`
<html><body>
<h2>Oplend AI Demo</h2>
<script src="/widget.js" data-project="burek01"></script>
</body></html>
  `);
});

// ----------------------------
//  ROOT
// ----------------------------

app.get("/", (req, res) => {
  res.send("Oplend AI – running");
});

// ----------------------------
//  START SERVER
// ----------------------------

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port " + port));
