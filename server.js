// server.js – Oplend AI
// widget.js mobile fix + demo page + multi-language
// + "je li to sve" flow + Supabase + hashirani password

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";

// ----------------------------
//  APP & CONFIG
// ----------------------------

const app = express();
app.use(express.json());
app.use(cors({ origin: "*", methods: "*", allowedHeaders: "*" }));

const {
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
} = process.env;

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// Supabase client
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

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

1) KADA KLIJENT NAPIŠE NARUDŽBU (vrste + količine)
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

4) PASSWORD LOGIKA (VRLO VAŽNO)

- Broj telefona služi kao identifikacija klijenta.
- APP razlikuje:
  a) NOVI KLIJENT (broj telefona još nije registriran)
  b) POSTOJEĆI KLIJENT (broj je već u bazi i ima password)

NOVI KLIJENT (nema password u bazi):
- Nakon što dobiješ ime + broj telefona:
  - Ljubazno objasni da treba postaviti password za buduće narudžbe.
  - Traži ga: npr. „Molim vas unesite password koji želite koristiti ubuduće.“
  - Kada ga korisnik unese → passwordAction = "set".
  - NE traži password ponovo na kraju narudžbe (ne duplirati).

POSTOJEĆI KLIJENT (broj postoji u bazi, ima password):
- NE traži novi password.
- Normalno vodi narudžbu (vrste + količine → da li je to sve → vrijeme → ime + telefon).
- PRIJE ZAVRŠNE POTVRDE narudžbe:
  - Traži od klijenta da POTVRDI narudžbu svojim postojećim passwordom.
  - „Molim potvrdite svoju narudžbu unošenjem vašeg passworda.“
  - Kada ga unese → passwordAction = "confirm".

ZABORAVLJEN PASSWORD:
- Ako korisnik kaže da je zaboravio password:
  - Nemoj pokušavati resetovati automatski.
  - Lijepo objasni da novi password dobija tek nakon ručne provjere u pekari (telefon / lično).
  - newPasswordRequested = true.
  - Ako password NE ODGOVARA, narudžbu NEMOJ smatrati finalnom.

5) KADA IME, TELEFON, VRIJEME I PASSWORD (ako je potreban) BUDU POZNATI
- Ako je sve jasno i (kod postojećeg klijenta) password je ispravan:
  - Napravi završnu potvrdu:
    - sve vrste + količine bureka
    - okvirni ukupni iznos prema cjenovniku
    - vrijeme preuzimanja
    - ime i telefon
    - napomena o plaćanju:
      - DE: „Bezahlung bei Abholung.“
      - EN: „Payment upon pickup.“
      - BHS: „Plaćanje pri preuzimanju.“
    - isFinalOrder = true

- Nakon završne potvrde:
  - Zahvali se.
  - Jasno reci da je ovaj chat sada ZATVOREN za ovu narudžbu.
  - Objasni da za nove promjene ili nova pitanja treba otvoriti NOVI chat.
  - closeChat = true

Ako korisnik NAKON ZATVARANJA chata ipak nastavi pisati u istom razgovoru:
- NE postavljaj ponovo pitanja za ime / telefon / password.
- Samo ljubazno reci da je ovaj chat zatvoren i da treba otvoriti novi chat za nove narudžbe ili promjene.

---------------------------------------------
TECHNICAL METADATA (VRLO VAŽNO)
---------------------------------------------

Am ENDE JEDER ANTWORT musst du EINE zusätzliche Zeile ausgeben,
die GENAU SO beginnt:

##META {JSON}

- JSON ist ein kompaktes Objekt mit folgenden Keys:
  - "phone": string oder null
  - "name": string oder null
  - "pickupTime": string oder null
  - "passwordAction": "none" | "set" | "confirm"
  - "password": string oder null
  - "isFinalOrder": true/false
  - "closeChat": true/false
  - "newPasswordRequested": true/false

BEISPIEL:
##META {"phone":"+491761234567","name":"Marko","pickupTime":"15:30","passwordAction":"confirm","password":"mojaSifra123","isFinalOrder":true,"closeChat":true,"newPasswordRequested":false}

- U ovoj liniji NE smije biti ništa osim "##META " i JSON objekta.
- Ovu liniju NE objašnjavaš korisniku. Ona je samo za sistem.
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

function detectPhone(text) {
  const m = (text || "").match(/(\+?\d[\d\s/\-]{6,})/);
  if (!m) return null;
  return m[1].replace(/[^\d+]/g, "");
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

    const allUserTextForPhone =
      safeHistory
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n") + "\n" + message;

    const phoneCandidate = detectPhone(allUserTextForPhone);
    let existingPasswordHash = null;

    if (phoneCandidate && supabase) {
      try {
        const { data, error } = await supabase
          .from("orders")
          .select("password")
          .eq("user_phone", phoneCandidate)
          .not("password", "is", null)
          .order("created_at", { ascending: false })
          .limit(1);

        if (!error && data && data.length > 0) {
          existingPasswordHash = data[0].password;
        }
      } catch (e) {
        console.error("Supabase select error (password lookup):", e);
      }
    }

    let internalUserStatusMessage = null;
    if (phoneCandidate) {
      internalUserStatusMessage = {
        role: "system",
        content:
          "INTERNAL_USER_STATUS: phone=" +
          phoneCandidate +
          ", hasPassword=" +
          (existingPasswordHash ? "true" : "false") +
          ". Verwende diese Info NUR intern, um zu entscheiden, ob der Kunde ein NEUES Passwort setzen soll (falls hasPassword=false) oder sein bestehendes Passwort NUR EINMAL zur Bestätigung der Bestellung eingeben soll (falls hasPassword=true). Erkläre diese interne Info dem Kunden NICHT.",
      };
    }

    const messagesForAI = [
      { role: "system", content: p.systemPrompt },
      { role: "system", content: languageInstruction },
    ];

    if (internalUserStatusMessage) {
      messagesForAI.push(internalUserStatusMessage);
    }

    messagesForAI.push(...safeHistory);

    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messagesForAI,
    });

    let reply = ai.choices?.[0]?.message?.content || "OK.";

    // --- META PARSING ---
    let meta = null;
    const metaMatch = reply.match(/##META\s+(\{[\s\S]*\})\s*$/);
    if (metaMatch) {
      const jsonStr = metaMatch[1];
      try {
        meta = JSON.parse(jsonStr);
      } catch (e) {
        console.error("META parse error:", e);
      }
      reply = reply.replace(/##META[\s\S]*$/, "").trim();
    }

    // --- Izračun cijene ---
    const allUserTextForQty =
      safeHistory
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n") + "\n" + message;

    const qty = parseQuantities(allUserTextForQty);
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

    // --- PASSWORD LOGIKA NA BACKENDU ---
    let phoneToStore =
      (meta && meta.phone) || phoneCandidate || null;
    let nameToStore = meta && meta.name ? meta.name : null;
    let pickupTimeToStore =
      meta && meta.pickupTime ? meta.pickupTime : null;

    let isFinalized =
      meta && typeof meta.isFinalOrder === "boolean"
        ? meta.isFinalOrder
        : false;

    let passwordHashToStore = existingPasswordHash || null;

    // SET new password
    if (
      meta &&
      meta.passwordAction === "set" &&
      meta.password &&
      phoneToStore &&
      !existingPasswordHash
    ) {
      try {
        const hash = await bcrypt.hash(meta.password, 10);
        passwordHashToStore = hash;
      } catch (e) {
        console.error("Password hash error:", e);
      }
    }

    // CONFIRM existing password
    if (
      meta &&
      meta.passwordAction === "confirm" &&
      meta.password &&
      existingPasswordHash
    ) {
      try {
        const ok = await bcrypt.compare(
          meta.password,
          existingPasswordHash
        );
        if (!ok) {
          isFinalized = false;
          reply +=
            "\n\nDas angegebene Passwort stimmt leider nicht. Ihre Bestellung wurde nicht endgültig bestätigt. Bitte wenden Sie sich direkt an die Bäckerei, um ein neues Passwort zu erhalten.";
        }
      } catch (e) {
        console.error("Password compare error:", e);
      }
    }

    // --- SUPABASE LOGGING ---
    if (supabase) {
      try {
        await supabase.from("orders").insert({
          project_id: projectId,
          user_message: message,
          ai_reply: reply,
          items: {
            kaese: qty.kaese,
            fleisch: qty.fleisch,
            kartoffeln: qty.kartoffeln,
          },
          total: total || null,
          user_phone: phoneToStore,
          user_name: nameToStore,
          pickup_time: pickupTimeToStore,
          is_finalized: isFinalized,
          password: passwordHashToStore, // HASH, ne plain
        });
      } catch (dbErr) {
        console.error("Supabase insert error:", dbErr);
      }
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
