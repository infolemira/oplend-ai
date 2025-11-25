import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import basicAuth from "express-basic-auth";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import { fileURLToPath } from "url";

import { createTenantContext } from "./tenantContext.js";

/* ------------------------------------------------------------------ */
/*  OSNOVNO PODEŠAVANJE                                                */
/* ------------------------------------------------------------------ */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

app.set("trust proxy", 1); // zbog Render / X-Forwarded-For

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* ------------------------------------------------------------------ */
/*  ENV / KLIJENTI                                                     */
/* ------------------------------------------------------------------ */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("⚠️  SUPABASE_URL ili SUPABASE_SERVICE_ROLE_KEY nisu postavljeni.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});
// Tenant middleware (FAZA 1)
const tenantMiddleware = createTenantContext(supabase);
app.use(tenantMiddleware);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const PROJECTS = {
  burek01: {
    id: "burek01",
    title: "Burek – chat narudžba",
    currency: "€"
  }
};

/* ------------------------------------------------------------------ */
/*  RATE LIMIT ZA /api/chat                                            */
/* ------------------------------------------------------------------ */

const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuta
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api/chat", chatLimiter);

/* ------------------------------------------------------------------ */
/*  BASIC AUTH ZA ADMIN                                                */
/* ------------------------------------------------------------------ */

const ADMIN_USER = process.env.ADMIN_USER || "burek";
const ADMIN_PASS = process.env.ADMIN_PASS || "burek123";

const adminAuth = basicAuth({
  users: { [ADMIN_USER]: ADMIN_PASS },
  challenge: true
});

/* ------------------------------------------------------------------ */
/*  POMOĆNE FUNKCIJE                                                   */
/* ------------------------------------------------------------------ */

function getLang(req) {
  const q = (req.query.lang || "hr").toLowerCase();
  if (q.startsWith("de")) return "de";
  if (q.startsWith("en")) return "en";
  return "hr";
}

function getProject(req) {
  const id = req.query.project || req.params.id || "burek01";
  return PROJECTS[id] || PROJECTS["burek01"];
}

function tConfig(lang) {
  if (lang === "de") {
    return {
      title: "Burek – Chat-Bestellung",
      description: "Bestellen Sie Burek: Käse | Fleisch | Kartoffeln",
      welcome:
        "Willkommen! Bitte geben Sie Sorte, Anzahl der Stücke und Abholzeit ein. Zum Ändern einer Bestellung verwenden Sie Ihre Telefonnummer und Ihr Passwort."
    };
  }
  if (lang === "en") {
    return {
      title: "Burek – Chat order",
      description: "Order burek: cheese | meat | potato",
      welcome:
        "Welcome! Please enter the type of burek, number of pieces and pickup time. To change an order, use your phone number and password."
    };
  }
  return {
    title: "Burek – chat narudžba",
    description: "Naruči burek: sir | meso | krumpir",
    welcome:
      "Dobrodošli! Upišite vrstu bureka, broj komada i vrijeme preuzimanja. Za izmjenu narudžbe koristite broj mobitela i lozinku."
  };
}

/**
 * Dohvati proizvode iz tablice products za određeni projekt.
 * Ako nema proizvoda, koristi fallback 3 klasična bureka po 5 €.
 */
async function loadProductsForProject(projectId) {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("project_id", projectId)
    .eq("is_active", true)
    .order("id", { ascending: true });

  if (error) {
    console.error("Supabase products error:", error);
  }

  if (!data || data.length === 0) {
    return [
      {
        id: 1,
        project_id: projectId,
        sku: "burek_sir",
        name_hr: "Burek sa sirom",
        name_de: "Burek mit Käse",
        name_en: "Burek with cheese",
        base_price: 5,
        is_active: true,
        discount_type: null,
        discount_value: null,
        discount_name: null,
        is_discount_active: false,
        allowed_categories: []
      },
      {
        id: 2,
        project_id: projectId,
        sku: "burek_meso",
        name_hr: "Burek s mesom",
        name_de: "Burek mit Fleisch",
        name_en: "Burek with meat",
        base_price: 5,
        is_active: true,
        discount_type: null,
        discount_value: null,
        discount_name: null,
        is_discount_active: false,
        allowed_categories: []
      },
      {
        id: 3,
        project_id: projectId,
        sku: "burek_krumpir",
        name_hr: "Burek s krumpirom",
        name_de: "Burek mit Kartoffeln",
        name_en: "Burek with potato",
        base_price: 5,
        is_active: true,
        discount_type: null,
        discount_value: null,
        discount_name: null,
        is_discount_active: false,
        allowed_categories: []
      }
    ];
  }

  return data;
}

/**
 * Jednostavna logika za obračun cijena + popusta po artiklu.
 * Vraća { unitPrice, finalPrice, appliedDiscountName }.
 */
function computeUnitPrice(product, customerCategories = []) {
  const base = Number(product.base_price || 0);
  let final = base;
  let discountName = null;

  if (product.is_discount_active && product.discount_type && product.discount_value) {
    let allowed = true;

    if (Array.isArray(product.allowed_categories) && product.allowed_categories.length > 0) {
      const set = new Set(customerCategories || []);
      const allowedSet = new Set(product.allowed_categories);
      allowed = [...allowedSet].some((c) => set.has(c));
    }

    if (allowed) {
      if (product.discount_type === "percentage") {
        const pct = Number(product.discount_value);
        final = Math.max(0, base - (base * pct) / 100);
      } else if (product.discount_type === "fixed") {
        final = Math.max(0, base - Number(product.discount_value));
      }
      discountName = product.discount_name || null;
    }
  }

  return {
    unitPrice: base,
    finalPrice: final,
    appliedDiscountName: discountName
  };
}

/**
 * Pomoćna za dohvat ili kreiranje customer-a (phone + pin)
 */
async function getOrCreateCustomer({ projectId, phone, pin, name }) {
  if (!phone || !pin) return null;

  const { data: existing, error: selError } = await supabase
    .from("customers")
    .select("*")
    .eq("project_id", projectId)
    .eq("phone", phone)
    .eq("pin", pin)
    .maybeSingle();

  if (selError) {
    console.error("Supabase customers select error:", selError);
  }

  if (existing) {
    // Ako je došao novi name, updejtaj
    if (name && name !== existing.name) {
      const { error: updErr } = await supabase
        .from("customers")
        .update({ name })
        .eq("id", existing.id);
      if (updErr) console.error("Supabase customers update error:", updErr);
    }
    return existing;
  }

  const { data: created, error: insError } = await supabase
    .from("customers")
    .insert({
      project_id: projectId,
      phone,
      pin,
      name,
      categories: [] // default
    })
    .select()
    .single();

  if (insError) {
    console.error("Supabase customers insert error:", insError);
    return null;
  }

  return created;
}

/**
 * Upis nove potvrđene narudžbe + otkazivanje stare (ako je izmjena)
 */
async function insertFinalOrder({
  projectId,
  phone,
  pin,
  name,
  pickup_time,
  items,
  total
}) {
  // prvo customer
  const customer = await getOrCreateCustomer({ projectId, phone, pin, name });
  const customerCategories = (customer && customer.categories) || [];

  // učitaj proizvode i izračunaj total ako nije poslan
  const products = await loadProductsForProject(projectId);

  const skuMap = {};
  for (const p of products) {
    skuMap[p.sku] = p;
  }

  // očekujemo items npr: { kaese: 1, fleisch:2, kartoffeln:0 }
  // mapiramo na sku
  const normalizedItems = {
    burek_sir: items.cheese ?? items.sir ?? items.kaese ?? 0,
    burek_meso: items.meat ?? items.meso ?? items.fleisch ?? 0,
    burek_krumpir: items.potato ?? items.krumpir ?? items.kartoffeln ?? 0
  };

  let computedTotal = 0;
  const priceDetails = {};

  for (const [sku, qty] of Object.entries(normalizedItems)) {
    const q = Number(qty || 0);
    if (!q) continue;
    const p = skuMap[sku];
    if (!p) continue;
    const { finalPrice, unitPrice, appliedDiscountName } = computeUnitPrice(
      p,
      customerCategories
    );
    const lineTotal = finalPrice * q;
    computedTotal += lineTotal;
    priceDetails[sku] = {
      qty: q,
      unitBase: unitPrice,
      unitFinal: finalPrice,
      lineTotal,
      discountName: appliedDiscountName
    };
  }

  const finalTotal = total != null ? total : computedTotal;

  // sve prethodne potvrđene narudžbe istog phone+pin označi kao canceled
  let originalOrderId = null;
  if (phone && pin) {
    const { data: previous, error: prevErr } = await supabase
      .from("orders")
      .select("id")
      .eq("project_id", projectId)
      .eq("phone", phone)
      .eq("pin", pin)
      .eq("status", "confirmed")
      .order("created_at", { ascending: false });

    if (prevErr) {
      console.error("Supabase previous orders error:", prevErr);
    } else if (previous && previous.length > 0) {
      const prevIds = previous.map((o) => o.id);
      originalOrderId = previous[0].id;
      const { error: updErr } = await supabase
        .from("orders")
        .update({ status: "canceled" })
        .in("id", prevIds);
      if (updErr) console.error("Supabase cancel previous orders error:", updErr);
    }
  }

  const { data: inserted, error: insError } = await supabase
    .from("orders")
    .insert({
      project_id: projectId,
      phone,
      pin,
      name,
      items: normalizedItems,
      total: finalTotal,
      status: "confirmed",
      original_order_id: originalOrderId,
      pickup_time,
      price_details: priceDetails
    })
    .select()
    .single();

  if (insError) {
    console.error("Supabase insert order error:", insError);
    return null;
  }

  console.log("NOVA POTVRĐENA NARUDŽBA:", {
    id: inserted.id,
    phone,
    name,
    pickup_time,
    total: inserted.total,
    items: normalizedItems
  });

  return inserted;
}

/* ------------------------------------------------------------------ */
/*  ROUTE: KONFIGURACIJA PROJEKTA                                     */
/* ------------------------------------------------------------------ */

app.get("/api/projects/:id/config", async (req, res) => {
  try {
    const lang = getLang(req);
    const p = getProject(req);
    const t = tConfig(lang);

    // proizvodi i cijene iz DB
    const products = await loadProductsForProject(p.id);

    const pricing = products.map((prod) => {
      const lp =
        lang === "de"
          ? prod.name_de
          : lang === "en"
          ? prod.name_en
          : prod.name_hr;

      return {
        sku: prod.sku,
        name: lp,
        base_price: Number(prod.base_price || 0),
        discount_type: prod.discount_type,
        discount_value: prod.discount_value,
        discount_name: prod.discount_name,
        is_discount_active: prod.is_discount_active,
        allowed_categories: prod.allowed_categories || []
      };
    });

    res.json({
      projectId: p.id,
      title: t.title,
      description: t.description,
      welcome: t.welcome,
      currency: p.currency,
      pricing
    });
  } catch (err) {
    console.error("/api/projects/:id/config error:", err);
    res.status(500).json({ error: "config_error" });
  }
});

/* ------------------------------------------------------------------ */
/*  ROUTE: CHAT                                                        */
/* ------------------------------------------------------------------ */

app.post("/api/chat", async (req, res) => {
  try {
    const lang = (req.body.lang || "hr").toLowerCase();
    const projectId = req.body.projectId || "burek01";
    const messages = req.body.messages || [];

    const tCfg = tConfig(lang);
    const products = await loadProductsForProject(projectId);

    const systemPrompt = `
Ti si chatbot za narudžbu bureka u pekari.

Uvijek odgovaraj na jeziku: ${
      lang === "de" ? "njemački" : lang === "en" ? "engleski" : "hrvatski"
    }.

Proizvodi i cijene (osnovne + mogući popusti):

${products
  .map((p) => {
    return `- SKU: ${p.sku}, HR: ${p.name_hr}, DE: ${p.name_de}, EN: ${p.name_en}, osnovna cijena: ${p.base_price} €. Popust: ${
      p.is_discount_active ? p.discount_name || "aktivni popust" : "nema popusta"
    }.`;
  })
  .join("\n")}

Tvoj zadatak:
1. Ljubazno vodi korisnika kroz:
   - izbor vrste / vrsta bureka i količina,
   - ime,
   - broj telefona,
   - kratku lozinku (PIN) za promjenu narudžbe,
   - vrijeme preuzimanja.
2. Izračunaj ukupnu cijenu na temelju gore navedenih cijena (pretpostavi da vrijede i eventualni popusti koje sam ja izračunao).
3. Kada korisnik potvrdi narudžbu, OBAVEZNO na kraj odgovora dodaj jedan red:
   JSON_ORDER: {...}

JSON mora imati ključeve:
- projectId
- phone
- pin
- name
- pickup_time
- items: objekt s ključevima (cheese, meat, potato) ili (sir, meso, krumpir)
- total: broj ili null ako nisi siguran.

Korisnik može reći da želi promijeniti staru narudžbu. Tada:
- prikupi nove količine,
- traži ISTI telefon i PIN,
- i ponovno izračunaj narudžbu.
`;

    const openaiMessages = [
      {
        role: "system",
        content: `${tCfg.welcome}\n\n${systemPrompt}`
      },
      ...messages
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: openaiMessages,
      temperature: 0.4
    });

    const reply = completion.choices[0].message.content || "";

    // tražimo JSON_ORDER:
    let finalOrder = null;
    const marker = "JSON_ORDER:";
    const idx = reply.indexOf(marker);
    if (idx !== -1) {
      const jsonPart = reply.substring(idx + marker.length).trim();
      try {
        finalOrder = JSON.parse(jsonPart);
      } catch (e) {
        console.error("JSON_ORDER parse error:", e, jsonPart);
      }
    }

    if (finalOrder) {
      const {
        projectId: projFromModel,
        phone,
        pin,
        name,
        pickup_time,
        items,
        total
      } = finalOrder;

      const usedProjectId = projFromModel || projectId;

      const inserted = await insertFinalOrder({
        projectId: usedProjectId,
        phone,
        pin,
        name,
        pickup_time,
        items: items || {},
        total
      });

      if (inserted) {
        console.log("NEW FINAL ORDER:", {
          projectId: usedProjectId,
          phone,
          name,
          pickupTime: pickup_time,
          items: inserted.items,
          total: inserted.total,
          orderId: inserted.id
        });
      }
    }

    res.json({
      reply
    });
  } catch (err) {
    console.error("/api/chat error:", err);
    res.status(500).json({ error: "chat_error" });
  }
});

/* ------------------------------------------------------------------ */
/*  ADMIN: ORDERS API                                                  */
/* ------------------------------------------------------------------ */

app.use(["/admin", "/admin/*", "/api/admin", "/api/admin/*"], adminAuth);

app.get("/api/admin/orders", async (req, res) => {
  try {
    // project iz queryja ili iz tenant konteksta
    const projectId = req.query.project || req.tenant?.projectId || "burek01";
    const statusFilter = req.query.status || "open"; // open | all
    const dateFilter = req.query.date || "today"; // today | all

    // store iz tenant konteksta (postavlja ga tenantMiddleware)
    const storeId = req.tenant?.storeId || null;

    let query = supabase
      .from("orders")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });

    // filtriranje po statusu (tvoj originalni kod)
    if (statusFilter === "open") {
      query = query.eq("status", "confirmed");
    } else if (statusFilter === "all") {
      query = query.in("status", ["confirmed", "delivered", "canceled"]);
    }

    // filtriranje po datumu (tvoj originalni kod)
    if (dateFilter === "today") {
      query = query.gte("created_at", new Date().toISOString().substring(0, 10));
    }

    // NOVO: filtriranje po store_id ako postoji
    if (storeId) {
      query = query.eq("store_id", storeId);
    }

    const { data, error } = await query;

    if (error) {
      console.error("/api/admin/orders error:", error);
      return res.status(500).json({ error: "orders_error" });
    }

    res.json({ orders: data || [] });
  } catch (err) {
    console.error("/api/admin/orders exception:", err);
    res.status(500).json({ error: "orders_exception" });
  }
});

app.post("/api/admin/orders/:id/delivered", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { error } = await supabase
      .from("orders")
      .update({ status: "delivered" })
      .eq("id", id);

    if (error) {
      console.error("set delivered error:", error);
      return res.status(500).json({ error: "update_error" });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("/api/admin/orders/:id/delivered exception:", err);
    res.status(500).json({ error: "exception" });
  }
});

app.post("/api/admin/orders/:id/cancel", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { error } = await supabase
      .from("orders")
      .update({ status: "canceled" })
      .eq("id", id);

    if (error) {
      console.error("set canceled error:", error);
      return res.status(500).json({ error: "update_error" });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("/api/admin/orders/:id/cancel exception:", err);
    res.status(500).json({ error: "exception" });
  }
});

/* ------------------------------------------------------------------ */
/*  ADMIN: PRODUCTS API                                                */
/* ------------------------------------------------------------------ */

app.get("/api/admin/products", async (req, res) => {
  try {
    // 1) projectId iz query ili tenant
    const projectId = req.query.project || req.tenant?.projectId || "burek01";

    // 2) storeId iz tenant middleware
    const storeId = req.tenant?.storeId || null;

    // 3) osnovni query
    let query = supabase
      .from("products")
      .select("*")
      .eq("project_id", projectId)
      .order("id", { ascending: true });

    // 4) ako postoji store → filtriraj po store_id
    if (storeId) {
      query = query.eq("store_id", storeId);
    }

    const { data, error } = await query;

    if (error) {
      console.error("/api/admin/products error:", error);
      return res.status(500).json({ error: "products_error" });
    }

    res.json({ products: data || [] });
  } catch (err) {
    console.error("/api/admin/products exception:", err);
    res.status(500).json({ error: "products_exception" });
  }
});

app.post("/api/admin/products", async (req, res) => {
  try {
    const projectId = req.body.projectId || req.tenant?.projectId || "burek01";
    const storeId = req.tenant?.storeId || null;

    const product = {
      ...req.body,
      project_id: projectId,
      store_id: storeId
    };
    delete product.projectId;

    let q = supabase.from("products");
    let result;

    // UPDATE
    if (product.id) {
      const id = product.id;
      delete product.id;

      const { data, error } = await q
        .update(product)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        console.error("products update error:", error);
        return res.status(500).json({ error: "update_error" });
      }
      result = data;

    // INSERT
    } else {
      const { data, error } = await q
        .insert(product)
        .select()
        .single();

      if (error) {
        console.error("products insert error:", error);
        return res.status(500).json({ error: "insert_error" });
      }
      result = data;
    }

    res.json({ product: result });

  } catch (err) {
    console.error("/api/admin/products POST exception:", err);
    res.status(500).json({ error: "exception" });
  }
});


/* ------------------------------------------------------------------ */
/*  ADMIN: CUSTOMERS API                                               */
/* ------------------------------------------------------------------ */

app.get("/api/admin/customers", async (req, res) => {
  try {
    const projectId = req.query.project || req.tenant?.projectId || "burek01";
    const storeId = req.tenant?.storeId || null;

    let query = supabase
      .from("customers")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });

    if (storeId) {
      query = query.eq("store_id", storeId);
    }

    const { data, error } = await query;

    if (error) {
      console.error("/api/admin/customers error:", error);
      return res.status(500).json({ error: "customers_error" });
    }

    res.json({ customers: data || [] });
  } catch (err) {
    console.error("/api/admin/customers exception:", err);
    res.status(500).json({ error: "customers_exception" });
  }
});

app.post("/api/admin/customers", async (req, res) => {
  try {
    const projectId = req.body.projectId || req.tenant?.projectId || "burek01";
    const storeId = req.tenant?.storeId || null;

    const customer = {
      ...req.body,
      project_id: projectId,
      store_id: storeId
    };
    delete customer.projectId;

    let result;

    // UPDATE
    if (customer.id) {
      const id = customer.id;
      delete customer.id;

      const { data, error } = await supabase
        .from("customers")
        .update(customer)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        console.error("customers update error:", error);
        return res.status(500).json({ error: "update_error" });
      }
      result = data;

    // INSERT
    } else {
      const { data, error } = await supabase
        .from("customers")
        .insert(customer)
        .select()
        .single();

      if (error) {
        console.error("customers insert error:", error);
        return res.status(500).json({ error: "insert_error" });
      }
      result = data;
    }

    res.json({ customer: result });

  } catch (err) {
    console.error("/api/admin/customers POST exception:", err);
    res.status(500).json({ error: "exception" });
  }
});

/* ------------------------------------------------------------------ */
/*  FRONTEND ROUTE-OVI                                                 */
/* ------------------------------------------------------------------ */

app.get("/demo", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "demo.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/admin/products", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "products-admin.html"));
});

app.get("/admin/customers", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "customers-admin.html"));
});

/* ------------------------------------------------------------------ */
/*  START                                                              */
/* ------------------------------------------------------------------ */

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
