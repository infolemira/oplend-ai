// server.js – Oplend AI (burek) – verzija s tablicom customers
// - Chat narudžbe (HR/DE/EN, meta, Supabase, password logika)
// - Admin dashboard: /admin + /api/admin/orders
// - Logiranje client_ip + user_agent
// - Rate limit na /api/chat
// - Ispravljeno: kod "modify_last":
//      * stara narudžba => is_cancelled = true
//      * nova narudžba => artikli + total se normalno popunjavaju
// - LOZINKE: spremaju se u Supabase tablicu "customers" (phone + password_hash)

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import basicAuth from "express-basic-auth";

// ----------------------------
//  APP & CONFIG
// ----------------------------

const app = express();
app.use(express.json());
app.use(cors({ origin: "*", methods: "*", allowedHeaders: "*" }));

// statički fajlovi za admin (frontend je u /public/admin.html, /public/admin.js, /public/admin.css)
app.use(express.static("public"));

const {
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
} = process.env;

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

// ----------------------------
//  PROJEKTI (više pekara)
// ----------------------------

const PROJECTS = {
  burek01: {
    lang: "multi",
    title: "Burek – Online narudžba",
    pricing: { kaese: 5, fleisch: 5, kartoffeln: 5 }, // sve 5 €
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

---------------------------------------------
STANDARDNI FLOW NOVE NARUDŽBE
---------------------------------------------

(ovaj dio je isti kao ranije – skraceno radi prostora)

---------------------------------------------
OTKAZIVANJE / IZMJENA PRETHODNE NARUDŽBE
---------------------------------------------

(važno: kod izmjene u META:
  - orderAction = "modify_last"
  - isFinalOrder = true
)

---------------------------------------------
TECHNICAL METADATA (VRLO VAŽNO)
---------------------------------------------

Na kraju SVAKOG odgovora:
##META {...}
(JSON sa: phone, name, pickupTime, passwordAction, password, isFinalOrder, closeChat, newPasswordRequested, orderAction)
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
  if (t.includes(" der ") || t.includes(" die ") || t.includes(" das "))
    return "de";
  if (t.includes("thanks") || t.includes("thank")) return "en";
  return "auto";
}

function detectPhone(text) {
  const m = (text || "").match(/(\+?\d[\d\s/\-]{6,})/);
  if (!m) return null;
  return m[1].replace(/[^\d+]/g, "");
}

function statusLabel(row, lang = "hr") {
  if (row.is_cancelled) {
    if (lang === "de") return "Storniert";
    if (lang === "en") return "Cancelled";
    return "Otkazano";
  }
  if (row.is_delivered) {
    if (lang === "de") return "Ausgeliefert";
    if (lang === "en") return "Delivered";
    return "Isporučeno";
  }
  if (row.is_finalized) {
    if (lang === "de") return "Bestätigt";
    if (lang === "en") return "Confirmed";
    return "Potvrđeno";
  }
  if (lang === "de") return "Entwurf";
  if (lang === "en") return "Draft";
  return "Nacrt";
}

function itemsToText(items, lang = "hr") {
  if (!items) return "-";
  const k = items.kaese || 0;
  const f = items.fleisch || 0;
  const kart = items.kartoffeln || 0;
  const parts = [];
  if (k)
    parts.push(
      `${k}x ${
        lang === "de" ? "Käse" : lang === "en" ? "cheese" : "sir"
      }`
    );
  if (f)
    parts.push(
      `${f}x ${
        lang === "de" ? "Fleisch" : lang === "en" ? "meat" : "meso"
      }`
    );
  if (kart)
    parts.push(
      `${kart}x ${
        lang === "de" ? "Kartoffeln" : lang === "en" ? "potato" : "krumpir"
      }`
    );
  return parts.length ? parts.join(", ") : "-";
}

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.connection?.remoteAddress ||
    null
  );
}

// ---- customers helperi (nova tablica) ----

async function getCustomerPasswordHash(phone) {
  if (!supabase || !phone) return null;
  try {
    const { data, error } = await supabase
      .from("customers")
      .select("password_hash")
      .eq("phone", phone)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error || !data || data.length === 0) return null;
    return data[0].password_hash || null;
  } catch (e) {
    console.error("getCustomerPasswordHash error:", e);
    return null;
  }
}

async function upsertCustomer(phone, passwordPlain, name) {
  if (!supabase || !phone || !passwordPlain) return;
  try {
    const hash = await bcrypt.hash(passwordPlain, 10);
    const payload = {
      phone,
      password_hash: hash,
    };
    if (name) payload.name = name;

    const { error } = await supabase
      .from("customers")
      .upsert(payload, { onConflict: "phone" });

    if (error) {
      console.error("upsertCustomer error:", error);
    }
  } catch (e) {
    console.error("upsertCustomer hash error:", e);
  }
}

// ----------------------------
//  RATE LIMIT ZA /api/chat
// ----------------------------

const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 20, // 20 requesta u minuti po IP-u
  message: { error: "Previše zahtjeva, pokušajte kasnije." },
});

app.use("/api/chat", chatLimiter);

// ----------------------------
//  BASIC AUTH ZA ADMIN
// ----------------------------

const adminUsers =
  ADMIN_USERNAME && ADMIN_PASSWORD
    ? { [ADMIN_USERNAME]: ADMIN_PASSWORD }
    : null;

const adminAuthMiddleware = adminUsers
  ? basicAuth({
      users: adminUsers,
      challenge: true,
      unauthorizedResponse: () => "Unauthorized",
    })
  : (req, res, next) => next(); // ako nema user/pass, admin je otvoren (za test)

// ----------------------------
//  CONFIG ENDPOINT
// ----------------------------

app.get("/api/projects/:id/config", (req, res) => {
  const { id } = req.params;
  const { lang = "hr" } = req.query;
  const p = PROJECTS[id] || PROJECTS["burek01"];

  let description, welcome;
  if (lang === "de") {
    description = "Bestellen Sie Burek: Käse | Fleisch | Kartoffeln";
    welcome = "Willkommen! Bitte geben Sie Sorte und Anzahl der Bureks ein.";
  } else if (lang === "en") {
    description = "Order burek: cheese | meat | potato";
    welcome = "Welcome! Please enter burek type and number of pieces.";
  } else {
    description = "Naručite burek: sir | meso | krumpir";
    welcome =
      "Dobrodošli! Molimo upišite vrstu bureka i broj komada.";
  }

  res.json({
    title: p.title,
    description,
    welcome,
    pricing: p.pricing,
  });
});

// ----------------------------
//  CHAT ENDPOINT
// ----------------------------

app.post("/api/chat", async (req, res) => {
  try {
    const client_ip = getClientIp(req);
    const user_agent = req.headers["user-agent"] || null;

    const {
      projectId = "burek01",
      message = "",
      history = [],
    } = req.body;
    const p = PROJECTS[projectId] || PROJECTS["burek01"];

    const safeHistory = Array.isArray(history)
      ? history.filter((m) => m && typeof m.content === "string")
      : [];

    const lastUser =
      safeHistory.filter((x) => x.role === "user").pop()?.content ||
      message;

    const lang = detectLang(lastUser);
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
      existingPasswordHash = await getCustomerPasswordHash(
        phoneCandidate
      );
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
          ". Verwende diese Info NUR intern ...",
      };
    }

    const messagesForAI = [
      { role: "system", content: p.systemPrompt },
      { role: "system", content: languageInstruction },
    ];
    if (internalUserStatusMessage) {
      messagesForAI.push(internalUserStatusMessage);
    }
    messagesForAI.push(...safeHistory, {
      role: "user",
      content: message,
    });

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

    // --- Izračun cijene (na osnovu TEKUĆEG chata) ---
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

Gesamtpreis (${parts.join(", ")}): ${total.toFixed(2)} €.`;
    }

    // --- PASSWORD / ORDER META NA BACKENDU ---
    let phoneToStore = (meta && meta.phone) || phoneCandidate || null;
    let nameToStore = meta && meta.name ? meta.name : null;
    let pickupTimeToStore =
      meta && meta.pickupTime ? meta.pickupTime : null;

    let isFinalized =
      meta && typeof meta.isFinalOrder === "boolean"
        ? meta.isFinalOrder
        : false;

    const orderAction = (meta && meta.orderAction) || "none";
    const passwordAction = (meta && meta.passwordAction) || "none";

    // 1) SET new password (samo ako taj broj NEMA password)
    if (
      passwordAction === "set" &&
      meta &&
      meta.password &&
      phoneToStore &&
      !existingPasswordHash
    ) {
      await upsertCustomer(phoneToStore, meta.password, nameToStore);
      existingPasswordHash = await getCustomerPasswordHash(
        phoneToStore
      );
    }

    // 2) CONFIRM existing password (postojeći klijent)
    if (
      passwordAction === "confirm" &&
      meta &&
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
    //    kod "modify_last" prethodna narudžba dobija is_cancelled = true
    if (
      supabase &&
      phoneToStore &&
      (orderAction === "cancel_last" ||
        orderAction === "modify_last")
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
        console.error(
          "Supabase update (cancel/modify) error:",
          e
        );
      }
    }

    // --- SUPABASE LOGGING (svaki chat korak) ---
    let insertedOrderId = null;

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
            order_action: orderAction,
            client_ip,
            user_agent,
          })
          .select("id")
          .single();

        if (error) {
          console.error("Supabase insert error:", error);
        } else {
          insertedOrderId = data?.id || null;
        }
      } catch (dbErr) {
        console.error("Supabase insert error:", dbErr);
      }
    }

    // --- NOTIFY BAKERY NA NOVU FINALNU NARUDŽBU ---
    if (
      isFinalized &&
      !(
        orderAction === "cancel_last" ||
        orderAction === "modify_last"
      )
    ) {
      notifyBakeryOnFinalOrder({
        projectId,
        phone: phoneToStore,
        name: nameToStore,
        pickupTime: pickupTimeToStore,
        items: {
          kaese: qty.kaese,
          fleisch: qty.fleisch,
          kartoffeln: qty.kartoffeln,
        },
        total: total || null,
        orderId: insertedOrderId,
      });
    }

    return res.json({ reply, total: total || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
//  widget.js (frontend za iframe)
// ----------------------------

app.get("/widget.js", (req, res) => {
  const js = `
(function(){
  const script = document.currentScript;
  const projectId = script.getAttribute("data-project") || "burek01";
  const host = script.src.split("/widget.js")[0];

  const urlParams = new URLSearchParams(window.location.search);
  const langParam = urlParams.get("lang") || "hr";

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
    "<textarea id='opl-in' placeholder='Poruka...' style='flex:1;min-height:44px;border:1px solid #ddd;border-radius:8px;padding:10px'></textarea>" +
    "<button id='opl-send' type='button' style='padding:10px 16px;border:1px solid #222;background:#222;color:white;border-radius:8px;cursor:pointer'>Pošalji</button>" +
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
  fetch(host + "/api/projects/" + projectId + "/config?lang=" + langParam)
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
    row.innerHTML = "<div style='padding:10px 12px;border-radius:12px;border:1px solid:#eee;background:white'>…</div>";
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
      bubble.textContent = "Greška pri slanju.";
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
//  DEMO PAGE (iframe)
// ----------------------------

app.get("/demo", (req, res) => {
  const { lang = "hr", project = "burek01" } = req.query;
  res.send(`
<html>
  <head>
    <meta charset="utf-8" />
    <title>Oplend AI Demo</title>
  </head>
  <body>
    <h3>Oplend AI Demo</h3>
    <p>Trenutni URL chata: ${`https://oplend-ai.onrender.com/demo?lang=${lang}`}</p>
    <script src="/widget.js" data-project="${project}"></script>
  </body>
</html>
  `);
});

// ----------------------------
//  ADMIN – HTML
// ----------------------------

app.get("/admin", adminAuthMiddleware, (req, res) => {
  res.sendFile(new URL("./public/admin.html", import.meta.url).pathname);
});

// ----------------------------
//  ADMIN – API
// ----------------------------

app.get("/api/admin/orders", adminAuthMiddleware, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    const {
      projectId = "burek01",
      filter = "all_final",
      date = "all",
      lang = "hr",
    } = req.query;

    let query = supabase
      .from("orders")
      .select(
        `
        id,
        project_id,
        created_at,
        user_name,
        user_phone,
        pickup_time,
        items,
        total,
        is_finalized,
        is_cancelled,
        is_delivered,
        order_action
      `
      )
      .eq("project_id", projectId);

    // prikazujemo finalne + isporučene + otkazane (bez nacrta)
    query = query.or("is_finalized.eq.true,is_cancelled.eq.true,is_delivered.eq.true");

    if (date === "today") {
      const today = new Date();
      const start = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate()
      );
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

      query = query
        .gte("created_at", start.toISOString())
        .lt("created_at", end.toISOString());
    }

    const { data, error } = await query.order("created_at", {
      ascending: false,
    });

    if (error) {
      console.error("Supabase admin select error:", error);
      return res.status(500).json({ error: "DB error" });
    }

    const mapped = data.map((row) => ({
      id: row.id,
      project_id: row.project_id,
      created_at: row.created_at,
      user_name: row.user_name,
      user_phone: row.user_phone,
      pickup_time: row.pickup_time,
      items: row.items,
      items_text: itemsToText(row.items, lang),
      total: row.total,
      is_finalized: row.is_finalized,
      is_cancelled: row.is_cancelled,
      is_delivered: row.is_delivered,
      order_action: row.order_action,
      status_label: statusLabel(row, lang),
    }));

    res.json({ orders: mapped });
  } catch (err) {
    console.error("Admin orders error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// oznaci isporuceno
app.post(
  "/api/admin/orders/:id/delivered",
  adminAuthMiddleware,
  async (req, res) => {
    try {
      if (!supabase) {
        return res
          .status(500)
          .json({ error: "Supabase not configured" });
      }

      const { id } = req.params;
      const { error } = await supabase
        .from("orders")
        .update({ is_delivered: true })
        .eq("id", id);

      if (error) {
        console.error("Supabase update delivered error:", error);
        return res.status(500).json({ error: "DB error" });
      }

      res.json({ ok: true });
    } catch (err) {
      console.error("Admin delivered error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

// ----------------------------
//  NOTIFY BAKERY (stub)
// ----------------------------

function notifyBakeryOnFinalOrder(order) {
  // Trenutno samo log.
  // Kada odlučiš provider (SendGrid, Twilio...), ovdje se doda pravi poziv.
  console.log("NEW FINAL ORDER:", order);
}

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
