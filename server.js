// server.js – Oplend AI (proširena verzija)
// - widget.js + multi-language
// - flow za narudžbu + Supabase + hashirani password
// - zaštita broja telefona + otkazivanje / izmjena
// - backend jedini provjerava password
// - cijena bureka = 5 €
// - admin dashboard (/admin + /api/admin/orders)
// - rate limit + logiranje IP + user-agent
// - Basic Auth za /admin i /api/admin/* (preko env varijabli)
// - admin tablica: 
//    status=open -> potvrđene, neisporučene, neotkazane
//    status=all  -> sve potvrđene (i isporučene i otkazane), bez nacrta
// - admin /admin na HR / DE / EN preko ?lang= parametra

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
  ADMIN_USER,
  ADMIN_PASS,
} = process.env;

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

// ----------------------------
//  BASIC AUTH ZA ADMIN
// ----------------------------

function adminAuth(req, res, next) {
  // Ako nema postavljenih ADMIN_USER/ADMIN_PASS, ne blokiramo (otvoren admin)
  if (!ADMIN_USER || !ADMIN_PASS) {
    return next();
  }

  const authHeader = req.headers["authorization"] || "";
  if (!authHeader.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Burek Admin"');
    return res.status(401).send("Authentication required");
  }

  const base64 = authHeader.split(" ")[1] || "";
  let decoded = "";
  try {
    decoded = Buffer.from(base64, "base64").toString("utf8");
  } catch (e) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Burek Admin"');
    return res.status(401).send("Invalid auth header");
  }

  const [user, pass] = decoded.split(":");
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    return next();
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Burek Admin"');
  return res.status(401).send("Invalid credentials");
}

// ----------------------------
//  PROJEKTI (više pekara)
// ----------------------------

const PROJECTS = {
  burek01: {
    id: "burek01",
    lang: "multi",
    title: "Burek – Online narudžba",
    pricing: { kaese: 5, fleisch: 5, kartoffeln: 5 },
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
IZBJEGAVAJ PONAVLJANJE ISTIH PITANJA
---------------------------------------------

- Prije nego što nešto pitaš (npr. ime, broj telefona, password, vrijeme preuzimanja),
  prvo PROČITAJ CIJELI dosadašnji razgovor.
- Ako je podatak već JASNO naveden u ovom chatu:
  - NE pitaj ponovo isto pitanje.
  - Umjesto toga, koristi već postojeći podatak.
- Primjeri:
  - Ako je korisnik već napisao broj telefona: ne pitaj opet "koji je vaš broj telefona?".
  - Ako je korisnik već napisao ime: ne pitaj ponovno "kako se zovete?", osim ako kaže da je prethodni podatak kriv.
  - Ako je korisnik već jednom unio password u ovom chatu i backend ga je prihvatio
    (vidićeš po tome što je narudžba potvrđena), NE traži ponovo password za istu narudžbu.
- Kada korisnik ispravlja narudžbu u NOVOM chatu:
  - Jednom tražiš broj telefona i password, nakon toga ih VIŠE NE PONAVLJAŠ u tom razgovoru.

---------------------------------------------
STANDARDNI FLOW NOVE NARUDŽBE
---------------------------------------------

1) KADA KLIJENT NAPIŠE NARUDŽBU (vrste + količine)
- Ukratko ponovi narudžbu (npr: "Dakle, želite 2x sir i 1x meso.").
- ODMAH NAKON TOGA obavezno postavi pitanje:
  - DE: "Ist das alles?"
  - EN: "Is that everything?"
  - BHS: "Da li je to sve?" / "Je li to sve?"

→ NE PITAJ za vrijeme, ime ili telefon DOK KLIJENT NE POTVRDI da je to sve.

2) KADA KLIJENT POTVRDI DA JE TO SVE
Prepoznaj odgovore tipa:
- DE: "Ja, das ist alles", "das wars", "ja, das war’s", "ja, das ist alles, danke"
- BHS: "da, to je sve", "to je sve", "je, to je sve", "to je to"
- EN: "yes, that’s all", "that’s all", "yes, that’s it"

TADA PITAJ:
  - DE: "Wann möchten Sie Ihre Bestellung abholen?"
  - EN: "When would you like to pick up your order?"
  - BHS: "Kada želite doći po narudžbu?" / "U koliko sati dolazite po narudžbu?"

3) KADA KLIJENT NAPIŠE VRIJEME PREUZIMANJA
- Potvrdi vrijeme (npr: "Abholung um 15:30." / "Preuzimanje u 15:30.").
- Zatim PITAJ:
  - DE: "Wie ist Ihr Name und Ihre Telefonnummer?"
  - EN: "What is your name and phone number?"
  - BHS: "Kako se zovete i koji je vaš broj telefona?"

---------------------------------------------
PASSWORD LOGIKA (BROJ TELEFONA = JEDAN KLIJENT)
---------------------------------------------

- Identitet klijenta je kombinacija: BROJ TELEFONA + PASSWORD.
- Broj telefona može pripadati SAMO jednom passwordu (jednom klijentu).
- Ako je broj telefona već registriran (ima password u sistemu),
  ne smiješ postavljati novi password za taj broj – samo traži postojeći.

NOVI KLIJENT (broj telefona NEMA password u bazi):
- Nakon što dobiješ ime + broj telefona:
  - Objasni da treba postaviti password za buduće narudžbe.
  - Pitaj: "Molim vas unesite password koji želite koristiti ubuduće."
  - Kad je korisnik unese → u META stavi: passwordAction = "set", password = "..."
  - NE traži password ponovo na kraju iste narudžbe.

POSTOJEĆI KLIJENT (broj telefona VEĆ IMA password u bazi):
- NE traži novi password.
- Vodi normalni flow (vrste + količine → je li to sve → vrijeme → ime + telefon).
- PRIJE ZAVRŠNE POTVRDE narudžbe:
  - Zamoli da POTVRDI narudžbu svojim POSTOJEĆIM passwordom.
  - npr: "Molim potvrdite svoju narudžbu unošenjem vašeg passworda."
  - Kada ga unese → META: passwordAction = "confirm", password = "..."

ZABORAVLJEN PASSWORD:
- Ako korisnik kaže da je zaboravio password:
  - NE mijenjaj password.
  - Ljubazno objasni da novi password dobija tek nakon ručne provjere u pekari (telefon / lično).
  - U META: newPasswordRequested = true.

⚠️ VEOMA VAŽNO:
- TI KAO ASISTENT NE ZNAŠ da li je password ispravan ili ne.
- NIKADA ne smiješ reći:
  - "password nije ispravan", "pogrešna lozinka", "lozinka ne odgovara",
  - niti odbiti narudžbu uz obrazloženje da je password netačan.
- Tvoja jedina uloga je:
  - tražiti password kad je potrebno
  - upisati ga u META polje "password" i "passwordAction"
  - backend sistem će provjeriti ispravnost i eventualno korisniku javiti da lozinka nije tačna.

---------------------------------------------
ZAVRŠNA POTVRDA NARUDŽBE
---------------------------------------------

- Kada su poznati:
  - vrste + količine bureka
  - okvirna ukupna cijena (prema cjenovniku)
  - vrijeme preuzimanja
  - ime i broj telefona
  - (za postojećeg klijenta) password je unijet i sistem ga je prihvatio

→ napravi završnu potvrdu i u META stavi:
  - isFinalOrder = true
  - closeChat = true

U odgovoru JASNO reci da je:
- narudžba potvrđena
- plaćanje pri preuzimanju
- ovaj chat sada je ZATVOREN za ovu narudžbu
- za nova pitanja ili izmjene treba otvoriti NOVI chat.

---------------------------------------------
OTKAZIVANJE / IZMJENA PRETHODNE NARUDŽBE
---------------------------------------------

Ako korisnik u NOVOM chatu napiše da želi:
- otkazati prethodnu narudžbu
- ili ispraviti / promijeniti prethodnu narudžbu

TADA:
1) Traži broj telefona (ako nije već napisan u ovom chatu).
2) Provjeri (interno, preko sistema) da li je za taj broj već postojao password.
3) Ako postoji password → traži da unese password za potvrdu identiteta.
   - Kada ga korisnik unese, OBAVEZNO u META upiši:
     - passwordAction = "confirm"
     - password = uneseni tekst.

OTKAZIVANJE:
- Ako želi potpuno anulirati zadnju potvrđenu narudžbu:
  - Objasni da ćeš otkazati NJEGOVU POSLJEDNJU potvrđenu narudžbu koja još nije isporučena.
  - U META stavi:
    - orderAction = "cancel_last"
    - isFinalOrder = true
    - closeChat = true

IZMJENA:
- Ako želi promijeniti zadnju potvrđenu narudžbu:
  - Jasno pitaj novu željenu kombinaciju (vrste + količine, eventualno novo vrijeme).
  - Kada nova kombinacija bude jasna i password je unijet:
    - U META:
      - orderAction = "modify_last"
      - isFinalOrder = true
      - (closeChat = true nakon završne potvrde)

VAŽNO:
- Otkazivanje ili izmjena vrijedi samo dok narudžba NIJE označena kao isporučena (interno, preko sistema).
- Ako sistem javi da je narudžba već isporučena, TI samo objasni da izmjena/otkazivanje nije moguće.

---------------------------------------------
TECHNICAL METADATA (VRLO VAŽNO)
---------------------------------------------

Am ENDE JEDER ANTWORT musst du EINE zusätzliche Zeile ausgeben,
die GENAU SO beginnt:

##META {JSON}

JSON Objekt mit:
  - "phone": string oder null
  - "name": string oder null
  - "pickupTime": string oder null
  - "passwordAction": "none" | "set" | "confirm"
  - "password": string oder null
  - "isFinalOrder": true/false
  - "closeChat": true/false
  - "newPasswordRequested": true/false
  - "orderAction": "none" | "cancel_last" | "modify_last"

BEISPIEL:
##META {"phone":"+491761234567","name":"Marko","pickupTime":"15:30","passwordAction":"confirm","password":"mojaSifra123","isFinalOrder":true,"closeChat":true,"newPasswordRequested":false,"orderAction":"cancel_last"}

- U ovoj liniji NE smije biti ništa osim "##META " i JSON objekta.
- Ovu liniju NE objašnjavaš korisniku. Ona je samo za sistem.
    `,
  },

  // PRIMJER za drugi projekt (druga pekara) – za kasnije:
  // burek02: {
  //   id: "burek02",
  //   lang: "multi",
  //   title: "Pekara XYZ – Burek",
  //   pricing: { kaese: 6, fleisch: 6, kartoffeln: 6 },
  //   systemPrompt: "...",
  // },
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

function getClientIp(req) {
  const xfwd = req.headers["x-forwarded-for"];
  if (typeof xfwd === "string" && xfwd.length > 0) {
    return xfwd.split(",")[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || "unknown";
}

// ----------------------------
//  RATE LIMIT (anti-spam)
// ----------------------------

const RATE_LIMIT_WINDOW_MS = 60_000; // 60 sekundi
const RATE_LIMIT_MAX_REQUESTS = 20;  // max 20 / minutu po IP
const rateLimitStore = new Map();

function checkRateLimit(req, res) {
  const ip = getClientIp(req);
  const now = Date.now();

  const arr = rateLimitStore.get(ip) || [];
  const recent = arr.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  rateLimitStore.set(ip, recent);

  if (recent.length > RATE_LIMIT_MAX_REQUESTS) {
    res.status(429).json({
      error: "Previše zahtjeva s ove IP adrese. Pokušajte ponovo za minutu.",
    });
    return false;
  }
  return true;
}

// ----------------------------
//  CONFIG ENDPOINT
// ----------------------------

app.get("/api/projects/:id/config", (req, res) => {
  const p = PROJECTS[req.params.id] || PROJECTS["burek01"];
  const lang = (req.query.lang || "hr").toLowerCase();

  let title = p.title;
  let description;
  let welcome;

  if (lang === "de") {
    title = "Chat-Bestellung";
    description = "Bestellen Sie Burek: Käse | Fleisch | Kartoffeln";
    welcome = "Willkommen! Bitte geben Sie Sorte und Anzahl der Bureks ein.";
  } else if (lang === "en") {
    title = "Chat order";
    description = "Order burek: cheese | meat | potato";
    welcome = "Welcome! Please enter the type of burek and number of pieces.";
  } else {
    // hr / bhs default
    title = "Chat narudžba";
    description = "Naručite burek: sir | meso | krumpir";
    welcome = "Dobrodošli! Molimo upišite vrstu bureka i broj komada.";
  }

  res.json({
    title,
    description,
    welcome,
    pricing: p.pricing,
  });
});

// ----------------------------
//  NOTIFICATION HOOK (za pekaru)
// ----------------------------

async function notifyBakeryOnFinalOrder(orderRow) {
  try {
    console.log("NOVA POTVRĐENA NARUDŽBA:", {
      id: orderRow?.id,
      phone: orderRow?.user_phone,
      name: orderRow?.user_name,
      pickup_time: orderRow?.pickup_time,
      total: orderRow?.total,
      items: orderRow?.items,
    });
    // OVDJE KASNIJE DODAŠ STVARNI EMAIL/SMS POZIV
  } catch (err) {
    console.error("Greška u notifyBakeryOnFinalOrder:", err);
  }
}

// ----------------------------
//  CHAT ENDPOINT
// ----------------------------

app.post("/api/chat", async (req, res) => {
  try {
    if (!checkRateLimit(req, res)) return;

    const clientIp = getClientIp(req);
    const userAgent = req.headers["user-agent"] || null;

    const {
      projectId = "burek01",
      message = "",
      history = [],
      lang: forcedLang,
    } = req.body;

    const p = PROJECTS[projectId] || PROJECTS["burek01"];

    const safeHistory = Array.isArray(history)
      ? history.filter((m) => m && typeof m.content === "string")
      : [];

    const lastUser =
      safeHistory.filter((x) => x.role === "user").pop()?.content || message;

    const langDetected = detectLang(lastUser);
    const lang = forcedLang || langDetected;

    const languageInstruction =
      lang === "de"
        ? "Antworte ausschließlich auf Deutsch."
        : lang === "en"
        ? "Respond strictly in English."
        : lang === "bhs"
        ? "Odgovaraj isključivo na bosanskom/hrvatskom/srpskom jeziku."
        : "Antwort in der Sprache der letzten Benutzer-Nachricht.";

    // --- Detekcija telefona za lookup ---
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

    // internal status za model
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

    const totalPieces = qty.kaese + qty.fleisch + qty.kartoffeln;

    if (totalPieces > 0 && !reply.includes("€")) {
      const parts = [];
      if (qty.kaese) parts.push(`${qty.kaese}x Käse`);
      if (qty.fleisch) parts.push(`${qty.fleisch}x Fleisch`);
      if (qty.kartoffeln) parts.push(`${qty.kartoffeln}x Kartoffeln`);

      reply += `

Ukupna cijena (${parts.join(", ")}): ${total.toFixed(2)} € (plaćanje pri preuzimanju).`;
    }

    // --- PASSWORD / ORDER META NA BACKENDU ---
    let phoneToStore = (meta && meta.phone) || phoneCandidate || null;
    let nameToStore = meta && meta.name ? meta.name : null;
    let pickupTimeToStore = meta && meta.pickupTime ? meta.pickupTime : null;

    let isFinalized =
      meta && typeof meta.isFinalOrder === "boolean"
        ? meta.isFinalOrder
        : false;

    let passwordHashToStore = existingPasswordHash || null;
    const orderAction = (meta && meta.orderAction) || "none";
    const passwordAction = (meta && meta.passwordAction) || "none";

    // 1) SET new password (samo ako taj broj do sada NEMA password)
    if (
      passwordAction === "set" &&
      meta &&
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

    // 2) CONFIRM existing password (postojeći klijent)
    if (
      passwordAction === "confirm" &&
      meta &&
      meta.password &&
      existingPasswordHash
    ) {
      try {
        const ok = await bcrypt.compare(meta.password, existingPasswordHash);
        if (!ok) {
          isFinalized = false;

          let wrongPwMsg;
          if (lang === "bhs") {
            wrongPwMsg =
              "Nažalost, password koji ste unijeli nije ispravan. Vaša narudžba nije konačno potvrđena. Molimo vas da kontaktirate pekaru (telefon ili lično) kako biste dobili novi password.";
          } else if (lang === "en") {
            wrongPwMsg =
              "Unfortunately, the password you entered is not correct. Your order has not been finalized. Please contact the bakery (by phone or in person) to receive a new password.";
          } else {
            wrongPwMsg =
              "Das angegebene Passwort stimmt leider nicht. Ihre Bestellung wurde nicht endgültig bestätigt. Bitte wenden Sie sich direkt an die Bäckerei (Telefon oder persönlich), um ein neues Passwort zu erhalten.";
          }

          reply += "\n\n" + wrongPwMsg;
        }
      } catch (e) {
        console.error("Password compare error:", e);
      }
    }

    // 3) ORDER-AKTIONEN (cancel / modify)
    if (
      supabase &&
      phoneToStore &&
      (orderAction === "cancel_last" || orderAction === "modify_last")
    ) {
      try {
        const { data: lastOrders, error: lastErr } = await supabase
          .from("orders")
          .select("id, is_delivered, is_cancelled")
          .eq("user_phone", phoneToStore)
          .eq("is_finalized", true)
          .order("created_at", { ascending: false })
          .limit(1);

        if (!lastErr && lastOrders && lastOrders.length > 0) {
          const lastOrder = lastOrders[0];

          if (!lastOrder.is_delivered) {
            await supabase
              .from("orders")
              .update({
                is_cancelled: true,
              })
              .eq("id", lastOrder.id);
          }
        }
      } catch (e) {
        console.error("Supabase update (cancel/modify) error:", e);
      }
    }

    // --- SUPABASE LOGGING (nova "akcija" / narudžba) ---
    let insertedRow = null;

    if (supabase) {
      try {
        const { data, error } = await supabase
          .from("orders")
          .insert({
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
            is_cancelled: orderAction === "cancel_last" ? true : false,
            is_delivered: false,
            password: passwordHashToStore,
            client_ip: clientIp,
            user_agent: userAgent,
          })
          .select("*")
          .single();

        if (!error) {
          insertedRow = data;
        } else {
          console.error("Supabase insert error:", error);
        }
      } catch (dbErr) {
        console.error("Supabase insert error:", dbErr);
      }
    }

    // Ako je narudžba finalizirana → notifikacija pekari
    if (insertedRow && insertedRow.is_finalized && !insertedRow.is_cancelled) {
      notifyBakeryOnFinalOrder(insertedRow);
    }

    return res.json({ reply, total: total || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
//  widget.js (sa mobile fix + lang)
// ----------------------------

app.get("/widget.js", (req, res) => {
  const js = `
(function(){
  const script = document.currentScript;
  const projectId = script.getAttribute("data-project") || "burek01";
  const lang = (script.getAttribute("data-lang") || "hr").toLowerCase();
  const host = script.src.split("/widget.js")[0];

  const history = [];

  const box = document.createElement("div");
  box.style.cssText = "max-width:900px;margin:0 auto;border:1px solid #ddd;border-radius:10px;overflow:hidden;font-family:Arial";

  box.innerHTML =
    "<div style='padding:14px 16px;border-bottom:1px solid #eee;background:white'>" +
    "<h2 id='opl-title' style='margin:0;font-size:22px'>Chat</h2>" +
    "<div id='opl-desc' style='margin-top:6px;color:#555;font-size:14px'></div>" +
    "</div>" +
    "<div id='opl-chat' style='height:60vh;overflow:auto;padding:12px;background:#fafafa'></div>" +
    "<div style='display:flex;gap:8px;padding:12px;border-top:1px solid:#eee;background:white'>" +
    "<textarea id='opl-in' placeholder='Poruka...' style='flex:1;min-height:44px;border:1px solid:#ddd;border-radius:8px;padding:10px'></textarea>" +
    "<button id='opl-send' type='button' style='padding:10px 16px;border:1px solid:#222;background:#222;color:white;border-radius:8px;cursor:pointer'>Pošalji</button>" +
    "</div>";

  script.parentNode.insertBefore(box, script);

  const chat = document.getElementById("opl-chat");
  const input = document.getElementById("opl-in");
  const sendBtn = document.getElementById("opl-send");
  const desc = document.getElementById("opl-desc");
  const titleEl = document.getElementById("opl-title");

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

  // Load config (sa lang parametrom)
  fetch(host + "/api/projects/" + projectId + "/config?lang=" + encodeURIComponent(lang))
    .then(r => r.json())
    .then(cfg => {
      const welcome = cfg.welcome;
      desc.textContent = cfg.description;
      titleEl.textContent = cfg.title || "Chat";
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
    row.innerHTML = "<div style='padding:10px 12px;border-radius:12px;border:1px solid:#eee;background:white'>…</div>";
    chat.appendChild(row);
    chat.scrollTop = chat.scrollHeight;
    const bubble = row.querySelector("div");

    try {
      const r = await fetch(host + "/api/chat", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ projectId, message: text, history, lang })
      });

      const j = await r.json();
      if (j.error) {
        bubble.textContent = j.error;
        return;
      }
      bubble.textContent = j.reply;
      history.push({ role:"assistant", content: j.reply });

    } catch (err) {
      bubble.textContent = "Greška pri slanju poruke.";
    }
  }

  sendBtn.onclick = send;

  input.addEventListener("keydown", function(e){
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
//  DEMO PAGE (iframe)
// ----------------------------

app.get("/demo", (req, res) => {
  const lang = (req.query.lang || "hr").toLowerCase();
  const project = (req.query.project || "burek01").toString();

  res.send(`
<html>
  <head>
    <meta charset="utf-8" />
    <title>Oplend AI Demo</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body style="margin:0;padding:10px;font-family:system-ui,sans-serif;">
    <div id="app"></div>
    <script src="/widget.js" data-project="${project}" data-lang="${lang}"></script>
  </body>
</html>
  `);
});

// ----------------------------
//  ADMIN API – pregled narudžbi
// ----------------------------

// GET /api/admin/orders?status=open|all&date=today|all&project=burek01
// status=open -> potvrđene, neisporučene, neotkazane
// status=all  -> sve potvrđene (i isporučene i otkazane), bez nacrta
app.get("/api/admin/orders", adminAuth, async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ error: "Supabase nije konfiguriran." });
  }

  try {
    const {
      status = "open",
      date = "all",
      project = "burek01",
    } = req.query;

    let query = supabase
      .from("orders")
      .select("*")
      .eq("project_id", project)
      .order("created_at", { ascending: false })
      .limit(200);

    if (status === "open") {
      // samo ono što još treba obraditi
      query = query
        .eq("is_finalized", true)
        .eq("is_cancelled", false)
        .eq("is_delivered", false);
    } else {
      // "all" – sve potvrđene (i isporučene i otkazane), bez nacrta
      query = query.eq("is_finalized", true);
    }

    if (date === "today") {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

      query = query
        .gte("created_at", start.toISOString())
        .lt("created_at", end.toISOString());
    }

    const { data, error } = await query;

    if (error) {
      console.error("Admin orders error:", error);
      return res.status(500).json({ error: "Greška pri čitanju narudžbi." });
    }

    res.json({ orders: data || [] });
  } catch (err) {
    console.error("Admin orders exception:", err);
    res.status(500).json({ error: "Interna greška servera." });
  }
});

// POST /api/admin/orders/:id/delivered
app.post("/api/admin/orders/:id/delivered", adminAuth, async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ error: "Supabase nije konfiguriran." });
  }

  const id = req.params.id;
  try {
    const { data, error } = await supabase
      .from("orders")
      .update({ is_delivered: true })
      .eq("id", id)
      .select("*")
      .single();

    if (error) {
      console.error("Mark delivered error:", error);
      return res.status(500).json({ error: "Greška pri označavanju isporuke." });
    }

    res.json({ ok: true, order: data });
  } catch (err) {
    console.error("Mark delivered exception:", err);
    res.status(500).json({ error: "Interna greška servera." });
  }
});

// ----------------------------
//  ADMIN DASHBOARD PAGE (/admin) – više jezika
// ----------------------------

app.get("/admin", adminAuth, (req, res) => {
  const lang = (req.query.lang || "hr").toLowerCase();

  const dict = {
    hr: {
      title: "Burek – admin narudžbe",
      projectLabel: "Projekt:",
      statusLabel: "Status:",
      dateLabel: "Datum:",
      refresh: "Osvježi",
      shownPrefix: "Prikazano",
      shownSuffix: "narudžbi.",
      colTime: "Vrijeme",
      colNamePhone: "Ime / telefon",
      colItems: "Artikli",
      colTotal: "Ukupno",
      colStatus: "Status",
      colAction: "Akcija",
      filterOpen: "Samo otvorene (potvrđene, neisporučene)",
      filterAll: "Sve potvrđene (uključujući isporučene i otkazane)",
      dateToday: "Samo današnje",
      dateAll: "Svi datumi",
      statusOpen: "Potvrđeno",
      statusDone: "Isporučeno",
      statusCancel: "Otkazano",
      statusDraft: "Nacrt / u tijeku",
      loading: "Učitavanje...",
      noOrders: "Nema narudžbi za zadane filtere.",
      loadError: "Greška pri dohvaćanju narudžbi.",
      btnMarkDelivered: "Označi isporučeno",
      btnSaving: "Spremam...",
      saveError: "Greška pri spremanju.",
      timePickupPrefix: "Preuzimanje:",
    },
    de: {
      title: "Burek – Bestellungen (Admin)",
      projectLabel: "Projekt:",
      statusLabel: "Status:",
      dateLabel: "Datum:",
      refresh: "Aktualisieren",
      shownPrefix: "Angezeigt",
      shownSuffix: "Bestellungen.",
      colTime: "Zeit",
      colNamePhone: "Name / Telefon",
      colItems: "Artikel",
      colTotal: "Gesamt",
      colStatus: "Status",
      colAction: "Aktion",
      filterOpen: "Nur offene (bestätigt, nicht ausgeliefert)",
      filterAll: "Alle bestätigten (inkl. ausgelieferte und stornierte)",
      dateToday: "Nur heute",
      dateAll: "Alle Daten",
      statusOpen: "Bestätigt",
      statusDone: "Ausgeliefert",
      statusCancel: "Storniert",
      statusDraft: "Entwurf / in Bearbeitung",
      loading: "Wird geladen...",
      noOrders: "Keine Bestellungen für die aktuellen Filter.",
      loadError: "Fehler beim Laden der Bestellungen.",
      btnMarkDelivered: "Als ausgeliefert markieren",
      btnSaving: "Speichern...",
      saveError: "Fehler beim Speichern.",
      timePickupPrefix: "Abholung:",
    },
    en: {
      title: "Burek – admin orders",
      projectLabel: "Project:",
      statusLabel: "Status:",
      dateLabel: "Date:",
      refresh: "Refresh",
      shownPrefix: "Showing",
      shownSuffix: "orders.",
      colTime: "Time",
      colNamePhone: "Name / phone",
      colItems: "Items",
      colTotal: "Total",
      colStatus: "Status",
      colAction: "Action",
      filterOpen: "Only open (confirmed, not delivered)",
      filterAll: "All confirmed (including delivered and cancelled)",
      dateToday: "Today only",
      dateAll: "All dates",
      statusOpen: "Confirmed",
      statusDone: "Delivered",
      statusCancel: "Cancelled",
      statusDraft: "Draft / in progress",
      loading: "Loading...",
      noOrders: "No orders for the selected filters.",
      loadError: "Error while loading orders.",
      btnMarkDelivered: "Mark as delivered",
      btnSaving: "Saving...",
      saveError: "Error while saving.",
      timePickupPrefix: "Pickup:",
    },
  };

  const LL = dict[lang] || dict.hr;

  res.send(`
<!DOCTYPE html>
<html lang="${lang}">
  <head>
    <meta charset="utf-8" />
    <title>${LL.title}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 0;
        padding: 20px;
        background: #f4f4f5;
      }
      h1 {
        margin-top: 0;
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 15px;
        align-items: center;
      }
      select, button {
        padding: 6px 10px;
        border-radius: 6px;
        border: 1px solid #d4d4d8;
        font-size: 14px;
      }
      button.primary {
        background: #16a34a;
        color: white;
        border-color: #16a34a;
        cursor: pointer;
      }
      button.primary:disabled {
        opacity: 0.6;
        cursor: default;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        background: white;
        border-radius: 10px;
        overflow: hidden;
      }
      th, td {
        padding: 8px 10px;
        border-bottom: 1px solid #e4e4e7;
        font-size: 13px;
      }
      th {
        background: #f4f4f5;
        text-align: left;
      }
      tr:last-child td {
        border-bottom: none;
      }
      .badge {
        display: inline-block;
        padding: 2px 6px;
        border-radius: 999px;
        font-size: 11px;
      }
      .badge-open {
        background: #f97316;
        color: white;
      }
      .badge-done {
        background: #22c55e;
        color: white;
      }
      .badge-cancel {
        background: #ef4444;
        color: white;
      }
      .badge-draft {
        background: #e5e7eb;
        color: #111827;
      }
      .nowrap {
        white-space: nowrap;
      }
      .small {
        font-size: 11px;
        color: #71717a;
      }
    </style>
  </head>
  <body>
    <h1>${LL.title}</h1>
    <div class="toolbar">
      <label>${LL.projectLabel}
        <select id="project-select">
          <option value="burek01">burek01</option>
          <!-- Za novu pekaru: dodaj ovdje <option value="burek02">burek02</option> -->
        </select>
      </label>
      <label>${LL.statusLabel}
        <select id="status-select">
          <option value="open">${LL.filterOpen}</option>
          <option value="all">${LL.filterAll}</option>
        </select>
      </label>
      <label>${LL.dateLabel}
        <select id="date-select">
          <option value="today">${LL.dateToday}</option>
          <option value="all">${LL.dateAll}</option>
        </select>
      </label>
      <button id="refresh-btn" class="primary">${LL.refresh}</button>
      <span id="info" class="small"></span>
    </div>

    <table>
      <thead>
        <tr>
          <th>${LL.colTime}</th>
          <th>${LL.colNamePhone}</th>
          <th>${LL.colItems}</th>
          <th>${LL.colTotal}</th>
          <th>${LL.colStatus}</th>
          <th>${LL.colAction}</th>
        </tr>
      </thead>
      <tbody id="orders-body">
        <tr><td colspan="6">${LL.loading}</td></tr>
      </tbody>
    </table>

    <script>
      const TEXT = {
        shownPrefix: "${LL.shownPrefix}",
        shownSuffix: "${LL.shownSuffix}",
        statusOpen: "${LL.statusOpen}",
        statusDone: "${LL.statusDone}",
        statusCancel: "${LL.statusCancel}",
        statusDraft: "${LL.statusDraft}",
        loading: "${LL.loading}",
        noOrders: "${LL.noOrders}",
        loadError: "${LL.loadError}",
        btnMarkDelivered: "${LL.btnMarkDelivered}",
        btnSaving: "${LL.btnSaving}",
        saveError: "${LL.saveError}",
        timePickupPrefix: "${LL.timePickupPrefix}"
      };

      const tbody = document.getElementById('orders-body');
      const projectSel = document.getElementById('project-select');
      const statusSel = document.getElementById('status-select');
      const dateSel = document.getElementById('date-select');
      const refreshBtn = document.getElementById('refresh-btn');
      const infoEl = document.getElementById('info');

      async function loadOrders() {
        tbody.innerHTML = "<tr><td colspan='6'>" + TEXT.loading + "</td></tr>";
        infoEl.textContent = "";
        refreshBtn.disabled = true;

        const params = new URLSearchParams({
          project: projectSel.value,
          status: statusSel.value,
          date: dateSel.value,
        });

        try {
          const res = await fetch("/api/admin/orders?" + params.toString());
          const data = await res.json();
          if (data.error) {
            tbody.innerHTML = "<tr><td colspan='6'>" + data.error + "</td></tr>";
            refreshBtn.disabled = false;
            return;
          }

          const orders = data.orders || [];
          infoEl.textContent = TEXT.shownPrefix + " " + orders.length + " " + TEXT.shownSuffix;

          if (!orders.length) {
            tbody.innerHTML = "<tr><td colspan='6'>" + TEXT.noOrders + "</td></tr>";
            refreshBtn.disabled = false;
            return;
          }

          tbody.innerHTML = "";
          for (const o of orders) {
            const tr = document.createElement("tr");

            const created = new Date(o.created_at);
            const createdStr = created.toLocaleString();

            const pickup = o.pickup_time ? String(o.pickup_time) : "-";

            const items = o.items || {};
            const parts = [];
            if (items.kaese) parts.push(items.kaese + "x sir");
            if (items.fleisch) parts.push(items.fleisch + "x meso");
            if (items.kartoffeln) parts.push(items.kartoffeln + "x krumpir");

            let statusHtml = "";
            if (o.is_cancelled) {
              statusHtml = "<span class='badge badge-cancel'>" + TEXT.statusCancel + "</span>";
            } else if (o.is_delivered) {
              statusHtml = "<span class='badge badge-done'>" + TEXT.statusDone + "</span>";
            } else if (o.is_finalized) {
              statusHtml = "<span class='badge badge-open'>" + TEXT.statusOpen + "</span>";
            } else {
              statusHtml = "<span class='badge badge-draft'>" + TEXT.statusDraft + "</span>";
            }

            const btnDisabled = o.is_delivered || o.is_cancelled || !o.is_finalized;

            tr.innerHTML =
              "<td class='nowrap'>" + createdStr + "<br><span class='small'>" + TEXT.timePickupPrefix + " " + pickup + "</span></td>" +
              "<td>" + (o.user_name || "-") + "<br><span class='small'>" + (o.user_phone || "") + "</span></td>" +
              "<td>" + (parts.join(", ") || "-") + "</td>" +
              "<td>" + (o.total != null ? (o.total.toFixed ? o.total.toFixed(2) : o.total) + " €" : "-") + "</td>" +
              "<td>" + statusHtml + "</td>" +
              "<td><button data-id='" + o.id + "' " + (btnDisabled ? "disabled" : "") + ">" + TEXT.btnMarkDelivered + "</button></td>";

            tbody.appendChild(tr);
          }

        } catch (err) {
          tbody.innerHTML = "<tr><td colspan='6'>" + TEXT.loadError + "</td></tr>";
          console.error(err);
        } finally {
          refreshBtn.disabled = false;
        }
      }

      tbody.addEventListener("click", async function(e){
        const btn = e.target.closest("button[data-id]");
        if (!btn) return;
        const id = btn.getAttribute("data-id");
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = TEXT.btnSaving;

        try {
          const res = await fetch("/api/admin/orders/" + id + "/delivered", {
            method: "POST",
          });
          const data = await res.json();
          if (data.error) {
            alert(data.error);
            btn.disabled = false;
            btn.textContent = originalText;
            return;
          }
          await loadOrders();
        } catch (err) {
          console.error(err);
          alert(TEXT.saveError);
          btn.disabled = false;
          btn.textContent = originalText;
        }
      });

      refreshBtn.addEventListener("click", loadOrders);
      statusSel.addEventListener("change", loadOrders);
      dateSel.addEventListener("change", loadOrders);
      projectSel.addEventListener("change", loadOrders);

      loadOrders();
    </script>
  </body>
</html>
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
