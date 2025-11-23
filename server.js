// server.js – Oplend AI (burek) – s products + popusti + customers admin
// - Chat narudžbe (HR/DE/EN, META, Supabase, password logika)
// - Lozinke i kategorije u customers
// - Proizvodi i popusti u products
// - Admin narudžbe: /admin + /api/admin/orders
// - Admin proizvodi: /admin/products + /api/admin/products*
// - Admin kupci: /admin/customers + /api/admin/customers*
// - Logiranje client_ip + user_agent
// - Rate limit na /api/chat

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

// statički fajlovi (admin HTML, JS, CSS iz /public)
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
//  PROJEKT
// ----------------------------

const PROJECTS = {
  burek01: {
    lang: "multi",
    title: "Burek – Online narudžba",
    pricing: { kaese: 5, fleisch: 5, kartoffeln: 5 }, // fallback ako nema products
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

1) KADA KLIJENT NAPIŠE NARUDŽBU (vrste + količine)
- Ukratko ponovi narudžbu (npr: "Dakle, želite 2x sir i 1x meso.").
- ODMAH NAKON TOGA obavezno postavi pitanje:
  - DE: "Ist das alles?"
  - EN: "Is that everything?"
  - BHS: "Da li je to sve?" / "Je li to sve?"

→ NE PITAJ za vrijeme, ime ili telefon DOK KLIJENT NE POTVRDI da je to sve.

2) KADA KLIJENT POTVRDI DA JE TO SVE
→ Pitaj za vrijeme preuzimanja.
3) KADA NAPIŠE VRIJEME
→ Pitaj za ime i broj telefona.

---------------------------------------------
PASSWORD LOGIKA
---------------------------------------------

- Identitet klijenta: BROJ TELEFONA + PASSWORD.
- Broj telefona može imati samo JEDAN password.

NOVI KLIJENT:
- Nakon imena + telefona:
  - objasni da postavlja password za ubuduće
  - pitaš: "Molim vas unesite password koji želite koristiti ubuduće."
  - META: passwordAction="set", password="..."

POSTOJEĆI KLIJENT:
- NE traži novi password.
- PRIJE završne potvrde narudžbe:
  - zamoli da potvrdi narudžbu unošenjem postojećeg passworda
  - META: passwordAction="confirm", password="..."

ZABORAVLJEN PASSWORD:
- Objasni da novi password dobiva tek nakon provjere u pekari.
- META: newPasswordRequested=true.

⚠️ TI NE ZNAŠ JE LI PASSWORD TOČAN
- Nikad ne govori "pogrešan password".
- Samo šalješ password i passwordAction u META.
- Backend provjerava.

---------------------------------------------
OTKAZIVANJE / IZMJENA
---------------------------------------------

- Novi chat: korisnik želi otkazati ili ispraviti prethodnu narudžbu.
- Tražiš telefon (+ password ako postoji).
- Kad potvrdi:
  - Otkazivanje:
    - META: orderAction="cancel_last", isFinalOrder=true, closeChat=true
  - Izmjena:
    - prikupi novu narudžbu,
    - META: orderAction="modify_last", isFinalOrder=true, closeChat=true

---------------------------------------------
TECHNICAL META
---------------------------------------------

Na KRAJU SVAKOG odgovora:

##META {...}

JSON:
  "phone": string|null
  "name": string|null
  "pickupTime": string|null
  "passwordAction": "none" | "set" | "confirm"
  "password": string|null
  "isFinalOrder": true/false
  "closeChat": true/false
  "newPasswordRequested": true/false
  "orderAction": "none" | "cancel_last" | "modify_last"
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

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.connection?.remoteAddress ||
    null
  );
}

// customers helperi
async function getCustomerByPhone(phone) {
  if (!supabase || !phone) return null;
  try {
    const { data, error } = await supabase
      .from("customers")
      .select("password_hash, categories, name")
      .eq("phone", phone)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error || !data || data.length === 0) return null;
    return data[0];
  } catch (e) {
    console.error("getCustomerByPhone error:", e);
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

// products helperi + popust logika
async function getProductsForProject(projectId) {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from("products")
      .select("*")
      .eq("project_id", projectId)
      .eq("is_active", true);

    if (error || !data) return [];
    return data;
  } catch (e) {
    console.error("getProductsForProject error:", e);
    return [];
  }
}

// cijena po komadu za ovog kupca
function computeUnitPrice(product, customerCategories = []) {
  const now = new Date();
  let price = Number(product.base_price);

  if (product.discount_price == null) {
    return price;
  }

  const startOk =
    !product.discount_start || now >= new Date(product.discount_start);
  const endOk =
    !product.discount_end || now <= new Date(product.discount_end);

  if (!startOk || !endOk) {
    return price;
  }

  const allowed = product.discount_allowed_categories;
  const appliesToEveryone =
    !allowed || (Array.isArray(allowed) && allowed.length === 0);

  if (appliesToEveryone) {
    return Number(product.discount_price);
  }

  const cats = Array.isArray(customerCategories)
    ? customerCategories
    : [];
  const hasMatch = cats.some((c) => allowed.includes(c));

  if (hasMatch) {
    return Number(product.discount_price);
  }

  return price;
}

function buildPricingInstruction(products, lang, customerCategories) {
  if (!products || products.length === 0) return "";

  const lines = [];

  let header;
  if (lang === "de") {
    header =
      "AKTUELLE PREISE für diesen Kunden (inklusive individueller Rabatte):";
  } else if (lang === "en") {
    header =
      "CURRENT PRICES for this customer (including applicable discounts):";
  } else {
    header =
      "TRENUTNI CJENIK za ovog kupca (uključujući popuste za koje ima pravo):";
  }
  lines.push(header);

  for (const p of products) {
    const unit = computeUnitPrice(p, customerCategories);
    const base = Number(p.base_price);
    const hasDiscount =
      p.discount_price != null && unit < base;

    if (hasDiscount) {
      const discName = p.discount_name || "popust";
      if (lang === "de") {
        lines.push(
          `- ${p.name}: ${unit.toFixed(
            2
          )} € mit Rabatt "${discName}" (Standardpreis ${base.toFixed(
            2
          )} €)`
        );
      } else if (lang === "en") {
        lines.push(
          `- ${p.name}: ${unit.toFixed(
            2
          )} € with discount "${discName}" (regular price ${base.toFixed(
            2
          )} €)`
        );
      } else {
        lines.push(
          `- ${p.name}: ${unit.toFixed(
            2
          )} € uz popust "${discName}" (redovna cijena ${base.toFixed(
            2
          )} €)`
        );
      }
    } else {
      lines.push(`- ${p.name}: ${unit.toFixed(2)} €`);
    }
  }

  return lines.join("\n");
}

// ----------------------------
//  RATE LIMIT ZA /api/chat
// ----------------------------

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
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
  : (req, res, next) => next();

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
    welcome =
      "Willkommen! Bitte geben Sie Sorte und Anzahl der Bureks ein.";
  } else if (lang === "en") {
    description = "Order burek: cheese | meat | potato";
    welcome =
      "Welcome! Please enter burek type and number of pieces.";
  } else {
    description = "Naručite burek: sir | meso | krumpir";
    welcome =
      "Dobrodošli! Molimo upišite vrstu bureka i broj komada.";
  }

  res.json({
    title: p.title,
    description,
    welcome,
    pricing: p.pricing, // fallback
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

    const allUserTextForPhone =
      safeHistory
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n") + "\n" + message;

    const phoneCandidate = detectPhone(allUserTextForPhone);
    let customer = null;
    let existingPasswordHash = null;
    let customerCategories = [];

    if (phoneCandidate && supabase) {
      customer = await getCustomerByPhone(phoneCandidate);
      existingPasswordHash = customer?.password_hash || null;
      customerCategories = Array.isArray(customer?.categories)
        ? customer.categories
        : [];
    }

    const products = await getProductsForProject(projectId);
    const productsByCode = {};
    for (const prod of products) {
      productsByCode[prod.code] = prod;
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
          ". Verwende diese Info NUR intern...",
      };
    }

    const messagesForAI = [
      { role: "system", content: p.systemPrompt },
      { role: "system", content: languageInstruction },
    ];

    const pricingInstruction = buildPricingInstruction(
      products,
      lang,
      customerCategories
    );
    if (pricingInstruction) {
      messagesForAI.push({
        role: "system",
        content: pricingInstruction,
      });
    }

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

    // META
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

    // KOLIČINE + CIJENA (uz popuste)
    const allUserTextForQty =
      safeHistory
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n") + "\n" + message;

    const qty = parseQuantities(allUserTextForQty);
    const fallbackPricing = p.pricing || {};
    const codes = ["kaese", "fleisch", "kartoffeln"];

    let total = 0;
    let totalPieces = 0;
    const partsLabel = [];
    const discountNotes = [];
    for (const code of codes) {
      const q = qty[code] || 0;
      if (!q) continue;
      const product = productsByCode[code];

      let base = null;
      let unitPrice = null;
      let hasDiscount = false;
      let discountName = null;

      if (product) {
        base = Number(product.base_price);
        unitPrice = computeUnitPrice(product, customerCategories);
        hasDiscount =
          product.discount_price != null && unitPrice < base;
        discountName = product.discount_name || null;
      } else {
        base = fallbackPricing[code] || 0;
        unitPrice = base;
      }

      total += unitPrice * q;
      totalPieces += q;

      if (code === "kaese") partsLabel.push(`${q}x Käse`);
      if (code === "fleisch") partsLabel.push(`${q}x Fleisch`);
      if (code === "kartoffeln") partsLabel.push(`${q}x Kartoffeln`);

      if (hasDiscount && discountName) {
        discountNotes.push({
          code,
          discountName,
          unitPrice,
          base,
          quantity: q,
          name: product ? product.name : code,
        });
      }
    }

    if (totalPieces > 0 && !reply.includes("€")) {
      let priceLine = "";
      const partsText = partsLabel.join(", ");
      const totalText = total.toFixed(2) + " €";
      const anyDiscount = discountNotes.length > 0;

      if (lang === "bhs") {
        priceLine = `Ukupna cijena (${partsText}): ${totalText}.`;
        if (anyDiscount) {
          const details = discountNotes
            .map(
              (d) =>
                `${d.name}: ${d.quantity}x po ${d.unitPrice.toFixed(
                  2
                )} € (popust "${d.discountName}", redovna cijena ${d.base.toFixed(
                  2
                )} €)`
            )
            .join("; ");
          priceLine += `\nPrimijenjeni popusti: ${details}.`;
        }
      } else if (lang === "en") {
        priceLine = `Total price (${partsText}): ${totalText}.`;
        if (anyDiscount) {
          const details = discountNotes
            .map(
              (d) =>
                `${d.name}: ${d.quantity}x at ${d.unitPrice.toFixed(
                  2
                )} € (discount "${d.discountName}", regular price ${d.base.toFixed(
                  2
                )} €)`
            )
            .join("; ");
          priceLine += `\nApplied discounts: ${details}.`;
        }
      } else {
        priceLine = `Gesamtpreis (${partsText}): ${totalText}.`;
        if (anyDiscount) {
          const details = discountNotes
            .map(
              (d) =>
                `${d.name}: ${d.quantity}x für ${d.unitPrice.toFixed(
                  2
                )} € (Rabatt "${d.discountName}", Standardpreis ${d.base.toFixed(
                  2
                )} €)`
            )
            .join("; ");
          priceLine += `\nAngewendete Rabatte: ${details}.`;
        }
      }

      reply += `\n\n${priceLine}`;
    }

    // PASSWORD / ORDER META
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

    // NEW PASSWORD
    if (
      passwordAction === "set" &&
      meta &&
      meta.password &&
      phoneToStore &&
      !existingPasswordHash
    ) {
      await upsertCustomer(phoneToStore, meta.password, nameToStore);
      const refreshed = await getCustomerByPhone(phoneToStore);
      existingPasswordHash = refreshed?.password_hash || null;
    }

    // CONFIRM PASSWORD
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

    // ORDER ACTION: cancel / modify – otkazuje zadnju finalnu
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

    // UPIS U orders
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
          is_cancelled: orderAction === "cancel_last" ? true : false,
          is_delivered: false,
          order_action: orderAction,
          client_ip,
          user_agent,
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
//  widget.js – chat za iframe
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
    "<div style='display:flex;gap:8px;padding:12px;border-top:1px solid:#eee;background:white'>" +
    "<textarea id='opl-in' placeholder='Poruka...' style='flex:1;min-height:44px;border:1px solid #ddd;border-radius:8px;padding:10px'></textarea>" +
    "<button id='opl-send' type='button' style='padding:10px 16px;border:1px solid:#222;background:#222;color:white;border-radius:8px;cursor:pointer'>Pošalji</button>" +
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
//  DEMO PAGE
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
    <p>Trenutni URL chata: https://oplend-ai.onrender.com/demo?lang=${lang}</p>
    <script src="/widget.js" data-project="${project}"></script>
  </body>
</html>
  `);
});

// ----------------------------
//  ADMIN HTML EKRANI
// ----------------------------

app.get("/admin", adminAuthMiddleware, (req, res) => {
  res.sendFile(new URL("./public/admin.html", import.meta.url).pathname);
});

app.get("/admin/products", adminAuthMiddleware, (req, res) => {
  res.sendFile(
    new URL("./public/products-admin.html", import.meta.url).pathname
  );
});

app.get("/admin/customers", adminAuthMiddleware, (req, res) => {
  res.sendFile(
    new URL("./public/customers-admin.html", import.meta.url).pathname
  );
});

// ----------------------------
//  ADMIN – ORDERS API
// ----------------------------

app.get("/api/admin/orders", adminAuthMiddleware, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    const {
      project = "burek01",
      status = "all",
      date = "all",
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
      .eq("project_id", project);

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

    let { data, error } = await query.order("created_at", {
      ascending: false,
    });

    if (error) {
      console.error("Supabase admin select error:", error);
      return res.status(500).json({ error: "DB error" });
    }

    // izbacimo nacrte (drafts)
    data = (data || []).filter(
      (o) => o.is_finalized || o.is_cancelled || o.is_delivered
    );

    if (status === "open") {
      data = data.filter(
        (o) =>
          o.is_finalized && !o.is_cancelled && !o.is_delivered
      );
    } else if (status === "delivered") {
      data = data.filter((o) => o.is_delivered);
    } else if (status === "cancelled") {
      data = data.filter((o) => o.is_cancelled);
    }

    res.json({ orders: data || [] });
  } catch (err) {
    console.error("Admin orders error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

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
//  ADMIN – PRODUCTS API
// ----------------------------

app.get("/api/admin/products", adminAuthMiddleware, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    const { projectId = "burek01" } = req.query;

    const { data, error } = await supabase
      .from("products")
      .select(
        `
        id,
        project_id,
        name,
        code,
        base_price,
        discount_name,
        discount_price,
        discount_start,
        discount_end,
        discount_allowed_categories,
        is_active,
        created_at,
        updated_at
      `
      )
      .eq("project_id", projectId)
      .order("name", { ascending: true });

    if (error) {
      console.error("Supabase products select error:", error);
      return res.status(500).json({ error: "DB error" });
    }

    res.json({ products: data });
  } catch (err) {
    console.error("Admin products error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post(
  "/api/admin/products/:id",
  adminAuthMiddleware,
  async (req, res) => {
    try {
      if (!supabase) {
        return res.status(500).json({ error: "Supabase not configured" });
      }

      const { id } = req.params;
      const {
        name,
        code,
        base_price,
        discount_name,
        discount_price,
        discount_start,
        discount_end,
        discount_allowed_categories,
        is_active,
      } = req.body;

      const update = {};
      if (name != null) update.name = name;
      if (code != null) update.code = code;
      if (base_price != null)
        update.base_price = Number(base_price);
      if (discount_name !== undefined)
        update.discount_name = discount_name || null;
      if (discount_price !== undefined)
        update.discount_price =
          discount_price === "" || discount_price == null
            ? null
            : Number(discount_price);
      if (discount_start !== undefined)
        update.discount_start =
          discount_start === "" ? null : discount_start;
      if (discount_end !== undefined)
        update.discount_end =
          discount_end === "" ? null : discount_end;

      if (discount_allowed_categories !== undefined) {
        if (
          typeof discount_allowed_categories === "string" &&
          discount_allowed_categories.trim() !== ""
        ) {
          update.discount_allowed_categories =
            discount_allowed_categories
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
        } else {
          update.discount_allowed_categories = null;
        }
      }

      if (is_active !== undefined) {
        update.is_active = !!is_active;
      }

      update.updated_at = new Date().toISOString();

      const { error } = await supabase
        .from("products")
        .update(update)
        .eq("id", id);

      if (error) {
        console.error("Supabase update product error:", error);
        return res.status(500).json({ error: "DB error" });
      }

      res.json({ ok: true });
    } catch (err) {
      console.error("Admin update product error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
});

// ----------------------------
//  ADMIN – CUSTOMERS API
// ----------------------------

app.get("/api/admin/customers", adminAuthMiddleware, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    const { data, error } = await supabase
      .from("customers")
      .select("phone, name, categories, created_at")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Supabase customers select error:", error);
      return res.status(500).json({ error: "DB error" });
    }

    res.json({ customers: data || [] });
  } catch (err) {
    console.error("Admin customers error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post(
  "/api/admin/customers/:phone",
  adminAuthMiddleware,
  async (req, res) => {
    try {
      if (!supabase) {
        return res.status(500).json({ error: "Supabase not configured" });
      }

      const phoneParam = req.params.phone;
      const { name, categories } = req.body;

      const update = {};
      if (name !== undefined) update.name = name;

      if (categories !== undefined) {
        if (typeof categories === "string" && categories.trim() !== "") {
          update.categories = categories
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        } else {
          update.categories = [];
        }
      }

      const { error } = await supabase
        .from("customers")
        .update(update)
        .eq("phone", phoneParam);

      if (error) {
        console.error("Supabase update customer error:", error);
        return res.status(500).json({ error: "DB error" });
      }

      res.json({ ok: true });
    } catch (err) {
      console.error("Admin update customer error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

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
