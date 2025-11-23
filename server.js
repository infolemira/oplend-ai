// server.js – kompletna verzija s:
//
// - PROJECTS (burek01)
// - više jezika (HR / DE / EN) u /api/projects/:id/config
// - Supabase orders + customers + products
// - popusti ovisno o kategorijama kupaca
// - admin za narudžbe, proizvode, kupce
// - basic auth za admin
// - rate-limit za /api/chat
// --------------------------------------------------------

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import rateLimit from "express-rate-limit";
import basicAuth from "express-basic-auth";

const PORT = process.env.PORT || 10000;

const app = express();

// ⚠️ VAŽNO ZA RENDER + rate-limit
app.set("trust proxy", 1);

// ----- MIDDLEWARE ---------------------------------------------------------

app.use(cors());
app.use(express.json());

// Static fajlovi za admin frontend (public folder)
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

// Rate limit samo za /api/chat
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuta
  max: 30,             // max 30 zahtjeva / min / IP
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api/chat", chatLimiter);

// ----- BASIC AUTH ZA ADMIN -----------------------------------------------

let adminUsers = {};
if (process.env.ADMIN_USER && process.env.ADMIN_PASS) {
  adminUsers[process.env.ADMIN_USER] = process.env.ADMIN_PASS;
}
const adminAuth =
  Object.keys(adminUsers).length > 0
    ? basicAuth({
        users: adminUsers,
        challenge: true
      })
    : (req, res, next) => {
        console.warn("⚠️ ADMIN bez zaštite (ADMIN_USER/ADMIN_PASS nisu postavljeni)");
        next();
      };

// ----- OPENAI & SUPABASE -------------------------------------------------

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// ----- PROJECT KONFIG ----------------------------------------------------

const PROJECTS = {
  burek01: {
    id: "burek01",
    title: {
      hr: "Burek – chat narudžba",
      de: "Burek – Chat-Bestellung",
      en: "Burek – Chat order"
    },
    pricing: {
      currency: "EUR"
    }
  }
};

const CONFIG_TEXTS = {
  hr: {
    description: "Naruči burek: sir | meso | krumpir",
    welcome: "Dobrodošli! Molimo upišite vrstu i količinu bureka."
  },
  de: {
    description: "Bestellen Sie Burek: Käse | Fleisch | Kartoffeln",
    welcome:
      "Willkommen! Bitte geben Sie Sorte und Anzahl der Bureks ein."
  },
  en: {
    description: "Order burek: cheese | meat | potato",
    welcome:
      "Welcome! Please enter the type of burek and the number of pieces."
  }
};

function getConfigTexts(lang) {
  if (lang === "de") return CONFIG_TEXTS.de;
  if (lang === "en") return CONFIG_TEXTS.en;
  return CONFIG_TEXTS.hr;
}

// ----- HELPER FUNKCIJE ---------------------------------------------------

// IP + user-agent iz requesta
function getRequestMeta(req) {
  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket.remoteAddress ||
    null;

  const ua = req.headers["user-agent"] || null;
  return { ip, ua };
}

// Dohvat kupca iz customers tablice
async function findCustomer(projectId, phone) {
  const { data, error } = await supabase
    .from("customers")
    .select("*")
    .eq("project_id", projectId)
    .eq("phone", phone)
    .maybeSingle();

  if (error) {
    console.error("Supabase error findCustomer:", error);
    return null;
  }
  return data;
}

// Spremi ili ažuriraj kupca (telefon + PIN + ime + kategorije)
async function upsertCustomer({ projectId, phone, pin, name, categories }) {
  const { data, error } = await supabase
    .from("customers")
    .upsert(
      {
        project_id: projectId,
        phone,
        pin,
        name: name || null,
        categories: categories || []
      },
      { onConflict: "project_id,phone" }
    )
    .select()
    .maybeSingle();

  if (error) {
    console.error("Supabase error upsertCustomer:", error);
    return null;
  }
  return data;
}

// Dohvat proizvoda za projekt
async function getProductsForProject(projectId) {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("project_id", projectId)
    .eq("is_active", true);

  if (error) {
    console.error("Supabase error getProductsForProject:", error);
    return [];
  }
  return data || [];
}

// Izračunaj jediničnu cijenu s popustom
function computeUnitPrice(product, customerCategories) {
  const base = Number(product.base_price || 0);

  if (
    !product.is_discount_active ||
    !product.discount_type ||
    product.discount_value == null
  ) {
    return { unitPrice: base, discountName: null };
  }

  const allowed = product.allowed_categories || [];
  const custCats = customerCategories || [];

  if (allowed.length > 0) {
    const hasMatch = custCats.some((c) => allowed.includes(c));
    if (!hasMatch) {
      return { unitPrice: base, discountName: null };
    }
  }

  const dv = Number(product.discount_value);
  let finalPrice = base;

  if (product.discount_type === "percent") {
    finalPrice = base * (1 - dv / 100);
  } else if (product.discount_type === "amount") {
    finalPrice = base - dv;
  }

  if (finalPrice < 0) finalPrice = 0;

  return {
    unitPrice: finalPrice,
    discountName: product.discount_name || null
  };
}

// Izračun cijelog računa na osnovu items + products + kategorija kupca
function computeOrderTotals({ items, products, customerCategories }) {
  const productMap = {};
  for (const p of products) {
    productMap[p.sku] = p;
  }

  let total = 0;
  const lineItems = [];

  for (const [sku, qtyRaw] of Object.entries(items || {})) {
    const qty = Number(qtyRaw || 0);
    if (!qty || qty <= 0) continue;

    const product = productMap[sku];
    if (!product) continue;

    const { unitPrice, discountName } = computeUnitPrice(
      product,
      customerCategories
    );
    const lineTotal = unitPrice * qty;
    total += lineTotal;

    lineItems.push({
      sku,
      quantity: qty,
      base_price: Number(product.base_price || 0),
      unit_price: unitPrice,
      line_total: lineTotal,
      discount_name: discountName
    });
  }

  return { total, lineItems };
}

// Spremi finalnu narudžbu u orders
async function saveFinalOrder({
  projectId,
  lang,
  phone,
  name,
  pickupTime,
  items,
  customerCategories,
  originalOrderId,
  req
}) {
  const products = await getProductsForProject(projectId);
  const { total, lineItems } = computeOrderTotals({
    items,
    products,
    customerCategories
  });

  const { ip: client_ip, ua: user_agent } = getRequestMeta(req);

  const payload = {
    project_id: projectId,
    lang,
    phone,
    name: name || null,
    pickup_time: pickupTime || null,
    status: "confirmed",
    original_order_id: originalOrderId || null,
    items: {
      raw: items,
      lines: lineItems
    },
    total,
    currency: "EUR",
    client_ip,
    user_agent
  };

  const { data, error } = await supabase
    .from("orders")
    .insert(payload)
    .select()
    .maybeSingle();

  if (error) {
    console.error("Supabase insert order error:", error);
    return null;
  }

  console.log("NOVA POTVRĐENA NARUDŽBA:", {
    id: data.id,
    phone: data.phone,
    name: data.name,
    pickup_time: data.pickup_time,
    total: data.total,
    items: data.items?.raw || null
  });

  return data;
}

// Oznaci staru narudžbu kao otkazanu ako je korigirana
async function cancelOriginalOrderIfAny(originalOrderId) {
  if (!originalOrderId) return;

  const { error } = await supabase
    .from("orders")
    .update({ status: "canceled" })
    .eq("id", originalOrderId);

  if (error) {
    console.error(
      "Supabase error cancelOriginalOrderIfAny for",
      originalOrderId,
      error
    );
  }
}

// ----- API: PROJECT CONFIG (widget) --------------------------------------

// npr. /api/projects/burek01/config?lang=hr
app.get("/api/projects/:id/config", (req, res) => {
  const lang = (req.query.lang || "hr").toLowerCase();
  const p = PROJECTS[req.params.id] || PROJECTS["burek01"];
  const texts = getConfigTexts(lang);

  res.json({
    projectId: p.id,
    title: p.title[lang] || p.title.hr,
    description: texts.description,
    welcome: texts.welcome,
    pricing: p.pricing
  });
});

// ----- DEMO STRANICA ZA CHAT ---------------------------------------------

// Jednostavna demo stranica koja učitava widget.js
app.get("/demo", (req, res) => {
  const lang = (req.query.lang || "hr").toLowerCase();

  const html = `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8" />
  <title>Oplend AI – Burek chat</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      margin: 0;
      padding: 0;
      background: #f4f4f5;
    }
    .demo-container {
      max-width: 900px;
      margin: 0 auto;
      padding: 16px;
    }
    h1 {
      font-size: 1.5rem;
      margin-bottom: 8px;
    }
    .chat-box {
      margin-top: 12px;
      border-radius: 12px;
      background: #fff;
      padding: 12px;
      box-shadow: 0 4px 14px rgba(0,0,0,0.08);
    }
  </style>
</head>
<body>
  <div class="demo-container">
    <h1>Burek – chat</h1>
    <div id="chat-root" class="chat-box"></div>
  </div>
  <script src="/widget.js"></script>
  <script>
    window.OplendWidget && window.OplendWidget.init({
      elementId: "chat-root",
      projectId: "burek01",
      lang: "${lang}"
    });
  </script>
</body>
</html>`;

  res.send(html);
});

// ----- API: CHAT ----------------------------------------------------------

// Frontend (widget.js) šalje: { projectId, lang, messages, state }
// Vraćamo: { messages, state }
app.post("/api/chat", async (req, res) => {
  try {
    const { projectId = "burek01", lang = "hr", messages, state } = req.body;
    const project = PROJECTS[projectId] || PROJECTS["burek01"];

    const sysLang = lang === "de" ? "German" : lang === "en" ? "English" : "Croatian";

    const systemPrompt = `
Ti si ljubazan chatbot za naručivanje bureka u pekari.
Govorite isključivo na jeziku korisnika (${sysLang}).
Vodi korisnika kroz:
- odabir vrste bureka (sir/cheese/kaese, meso/meat/fleisch, krumpir/potato/kartoffeln)
- količine
- ime (opcionalno)
- broj telefona (obavezno)
- PIN lozinku za izmjene narudžbe
- vrijeme preuzimanja
- potvrdu narudžbe

STATE objekt opisuje trenutno stanje narudžbe:

state = {
  stage: string,              // "start" | "collect_items" | "ask_name" | "ask_phone" | "ask_pin" | "ask_pickup" | "confirm" | "finalized" | "cancel"
  projectId: string,
  lang: string,
  phone: string | null,
  pin: string | null,
  name: string | null,
  pickupTime: string | null,
  items: { kaese?: number, fleisch?: number, kartoffeln?: number },
  originalOrderId?: number | null
}

U SVAKOM odgovoru:
1) ažuriraj i vrati novi JSON state u posebnom bloku:
<state>{...}</state>
2) u ostatku teksta normalno razgovaraj.

Kada je narudžba potpuno gotova i korisnik JE POTVRDIO, postavi:
- state.stage = "finalized"
- popuni state.phone, state.pin, state.pickupTime i state.items (količine)
- ako je ovo izmjena postojeće narudžbe, postavi state.originalOrderId na postojeći ID koji ti je poslan u prethodnom stanju.

NE izmišljaj ID narudžbe – backend će to dodijeliti.
`;

    const openaiMessages = [
      { role: "system", content: systemPrompt },
      ...(messages || [])
    ];

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: openaiMessages,
      temperature: 0.4
    });

    const assistantMessage = completion.choices[0].message;
    const assistantText = assistantMessage.content || "";

    // Pokušaj izdvojiti <state>...</state> JSON
    let newState = state || {};
    const stateMatch = assistantText.match(/<state>([\s\S]*?)<\/state>/i);
    if (stateMatch) {
      try {
        const jsonText = stateMatch[1];
        newState = JSON.parse(jsonText);
      } catch (e) {
        console.error("Parse state error:", e);
      }
    }

    // Ako je stage == finalized -> spremi order
    if (newState && newState.stage === "finalized") {
      const projectIdUsed = newState.projectId || projectId;
      const langUsed = newState.lang || lang;

      const phone = newState.phone;
      const pin = newState.pin;
      const name = newState.name || null;
      const pickupTime = newState.pickupTime || null;
      const items = newState.items || {};
      const originalOrderId = newState.originalOrderId || null;

      // Upsert kupca
      let customerCategories = [];
      if (phone && pin) {
        const cust = await upsertCustomer({
          projectId: projectIdUsed,
          phone,
          pin,
          name,
          categories: newState.categories || []
        });
        if (cust && Array.isArray(cust.categories)) {
          customerCategories = cust.categories;
        }
      }

      const order = await saveFinalOrder({
        projectId: projectIdUsed,
        lang: langUsed,
        phone,
        name,
        pickupTime,
        items,
        customerCategories,
        originalOrderId,
        req
      });

      if (order && originalOrderId) {
        await cancelOriginalOrderIfAny(originalOrderId);
      }

      console.log("NEW FINAL ORDER:", {
        projectId: projectIdUsed,
        phone,
        name,
        pickupTime,
        items,
        total: order?.total || null,
        orderId: order?.id || null
      });
    }

    res.json({
      messages: [...(messages || []), assistantMessage],
      state: newState
    });
  } catch (err) {
    console.error("Error /api/chat:", err);
    res.status(500).json({ error: "Chat error" });
  }
});

// ----- ADMIN: HTML STRANICE ----------------------------------------------

// /admin – narudžbe
app.get("/admin", adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// /admin/products – proizvodi & popusti
app.get("/admin/products", adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "products-admin.html"));
});

// /admin/customers – kupci & kategorije
app.get("/admin/customers", adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "customers-admin.html"));
});

// ----- ADMIN: ORDERS API --------------------------------------------------

// GET /api/admin/orders?project=burek01&status=open|all&date=today|all
app.get("/api/admin/orders", adminAuth, async (req, res) => {
  try {
    const projectId = req.query.project || "burek01";
    const status = req.query.status || "open";
    const date = req.query.date || "today";

    let query = supabase
      .from("orders")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });

    if (status === "open") {
      query = query.in("status", ["confirmed"]);
    }

    if (date === "today") {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const isoStart = today.toISOString();
      const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
      const isoEnd = tomorrow.toISOString();
      query = query.gte("created_at", isoStart).lt("created_at", isoEnd);
    }

    const { data, error } = await query;

    if (error) {
      console.error("Supabase get orders error:", error);
      return res.status(500).json({ error: "DB error" });
    }

    res.json(data || []);
  } catch (err) {
    console.error("Error /api/admin/orders:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/admin/orders/:id/delivered
app.post("/api/admin/orders/:id/delivered", adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { data, error } = await supabase
      .from("orders")
      .update({ status: "delivered" })
      .eq("id", id)
      .select()
      .maybeSingle();

    if (error) {
      console.error("Supabase delivered error:", error);
      return res.status(500).json({ error: "DB error" });
    }

    res.json(data);
  } catch (err) {
    console.error("Error /api/admin/orders/:id/delivered:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/admin/orders/:id/canceled
app.post("/api/admin/orders/:id/canceled", adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { data, error } = await supabase
      .from("orders")
      .update({ status: "canceled" })
      .eq("id", id)
      .select()
      .maybeSingle();

    if (error) {
      console.error("Supabase cancel order error:", error);
      return res.status(500).json({ error: "DB error" });
    }

    res.json(data);
  } catch (err) {
    console.error("Error /api/admin/orders/:id/canceled:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ----- ADMIN: PRODUCTS API -----------------------------------------------

// GET /api/admin/products?project=burek01
app.get("/api/admin/products", adminAuth, async (req, res) => {
  try {
    const projectId = req.query.project || "burek01";
    const { data, error } = await supabase
      .from("products")
      .select("*")
      .eq("project_id", projectId)
      .order("id", { ascending: true });

    if (error) {
      console.error("Supabase get products error:", error);
      return res.status(500).json({ error: "DB error" });
    }

    res.json(data || []);
  } catch (err) {
    console.error("Error /api/admin/products:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/admin/products
app.post("/api/admin/products", adminAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const payload = {
      project_id: body.project_id || "burek01",
      sku: body.sku,
      name_hr: body.name_hr,
      name_de: body.name_de,
      name_en: body.name_en,
      base_price: body.base_price,
      currency: body.currency || "EUR",
      is_active: body.is_active ?? true,
      discount_type: body.discount_type || null,
      discount_value: body.discount_value ?? null,
      discount_name: body.discount_name || null,
      is_discount_active: body.is_discount_active ?? false,
      allowed_categories: body.allowed_categories || []
    };

    const { data, error } = await supabase
      .from("products")
      .insert(payload)
      .select()
      .maybeSingle();

    if (error) {
      console.error("Supabase insert product error:", error);
      return res.status(500).json({ error: "DB error" });
    }

    res.json(data);
  } catch (err) {
    console.error("Error POST /api/admin/products:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/admin/products/:id
app.put("/api/admin/products/:id", adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};

    const payload = {
      sku: body.sku,
      name_hr: body.name_hr,
      name_de: body.name_de,
      name_en: body.name_en,
      base_price: body.base_price,
      currency: body.currency,
      is_active: body.is_active,
      discount_type: body.discount_type,
      discount_value: body.discount_value,
      discount_name: body.discount_name,
      is_discount_active: body.is_discount_active,
      allowed_categories: body.allowed_categories
    };

    const { data, error } = await supabase
      .from("products")
      .update(payload)
      .eq("id", id)
      .select()
      .maybeSingle();

    if (error) {
      console.error("Supabase update product error:", error);
      return res.status(500).json({ error: "DB error" });
    }

    res.json(data);
  } catch (err) {
    console.error("Error PUT /api/admin/products/:id:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /api/admin/products/:id
app.delete("/api/admin/products/:id", adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { error } = await supabase.from("products").delete().eq("id", id);

    if (error) {
      console.error("Supabase delete product error:", error);
      return res.status(500).json({ error: "DB error" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Error DELETE /api/admin/products/:id:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ----- ADMIN: CUSTOMERS API ----------------------------------------------

// GET /api/admin/customers?project=burek01
app.get("/api/admin/customers", adminAuth, async (req, res) => {
  try {
    const projectId = req.query.project || "burek01";

    const { data, error } = await supabase
      .from("customers")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Supabase get customers error:", error);
      return res.status(500).json({ error: "DB error" });
    }

    res.json(data || []);
  } catch (err) {
    console.error("Error GET /api/admin/customers:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/admin/customers
app.post("/api/admin/customers", adminAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const payload = {
      project_id: body.project_id || "burek01",
      phone: body.phone,
      pin: body.pin,
      name: body.name || null,
      categories: body.categories || []
    };

    const { data, error } = await supabase
      .from("customers")
      .insert(payload)
      .select()
      .maybeSingle();

    if (error) {
      console.error("Supabase insert customer error:", error);
      return res.status(500).json({ error: "DB error" });
    }

    res.json(data);
  } catch (err) {
    console.error("Error POST /api/admin/customers:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/admin/customers/:id
app.put("/api/admin/customers/:id", adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};

    const payload = {
      phone: body.phone,
      pin: body.pin,
      name: body.name,
      categories: body.categories
    };

    const { data, error } = await supabase
      .from("customers")
      .update(payload)
      .eq("id", id)
      .select()
      .maybeSingle();

    if (error) {
      console.error("Supabase update customer error:", error);
      return res.status(500).json({ error: "DB error" });
    }

    res.json(data);
  } catch (err) {
    console.error("Error PUT /api/admin/customers/:id:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /api/admin/customers/:id
app.delete("/api/admin/customers/:id", adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { error } = await supabase.from("customers").delete().eq("id", id);

    if (error) {
      console.error("Supabase delete customer error:", error);
      return res.status(500).json({ error: "DB error" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Error DELETE /api/admin/customers/:id:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------------------------------------------------------------

app.get("/", (req, res) => {
  res.send("Oplend AI Burek bot – backend radi 🚀");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
