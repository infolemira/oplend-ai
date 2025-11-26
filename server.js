import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import basicAuth from "express-basic-auth";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import { fileURLToPath } from "url";

import { createTenantContext } from "./tenantContext.js";
import { randomUUID } from "crypto";


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
  const cleanPhone = (phone || "").toString().trim();
  const cleanPin = (pin || "").toString().trim();

  if (!cleanPhone) {
    return { customer: null, error: "no_phone" };
  }
  if (!cleanPin) {
    return { customer: null, error: "no_pin" };
  }

  // 1) prvo tražimo po project_id + phone (NE po PIN-u!)
  const { data: existing, error: selError } = await supabase
    .from("customers")
    .select("*")
    .eq("project_id", projectId)
    .eq("phone", cleanPhone)
    .maybeSingle();

  if (selError) {
    console.error("Supabase customers select error:", selError);
    return { customer: null, error: "db_select" };
  }

  // 2) ako postoji kupac za taj telefon
  if (existing) {
    // ako PIN ne odgovara → BLOKIRAJ NARUDŽBU
    if (existing.pin !== cleanPin) {
      return { customer: null, error: "wrong_pin" };
    }

    // ako je ime novo → update imena
    if (name && name !== existing.name) {
      const { data: updated, error: updErr } = await supabase
        .from("customers")
        .update({ name })
        .eq("id", existing.id)
        .select()
        .single();

      if (updErr) {
        console.error("Supabase customers update error:", updErr);
        // i dalje vraćamo postojećeg, jer je PIN ok
        return { customer: existing, error: null };
      }

      return { customer: updated, error: null };
    }

    return { customer: existing, error: null };
  }

  // 3) ako NE postoji kupac za taj telefon → kreiramo NOVOG
  const { data: created, error: insError } = await supabase
    .from("customers")
    .insert({
      project_id: projectId,
      phone: cleanPhone,
      pin: cleanPin,
      name: name || null,
      categories: []
    })
    .select()
    .single();

  if (insError) {
    console.error("Supabase customers insert error:", insError);
    return { customer: null, error: "db_insert" };
  }

  return { customer: created, error: null };
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
  const { customer, error } = await getOrCreateCustomer({
    projectId,
    phone,
    pin,
    name
  });

  if (error) {
    if (error === "wrong_pin") {
      console.log("❌ Pogrešan PIN za telefon:", phone);
      return { error: "wrong_pin" };
    }
    if (error === "no_phone") return { error: "no_phone" };
    if (error === "no_pin") return { error: "no_pin" };

    console.log("❌ Greška pri dohvaćanju/kreiranju kupca:", error);
    return { error: "customer_error" };
  }

  const customerCategories = customer?.categories || [];

  // učitaj proizvode i izračunaj total ako nije poslan
  const products = await loadProductsForProject(projectId);

  const skuMap = {};
  for (const p of products) {
    skuMap[p.sku] = p;
  }

  // očekujemo items u formatu:
  // { "SKU": količina, ... } npr. { "TEST-PROD-01": 2, "TEST-PROD-02": 1 }
  // to je već direktno iz JSON_ORDER-a
  const normalizedItems = items || {};

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
let messages = req.body.messages || [];

// sigurnosni limit: zadnjih 20 poruka
messages = messages.slice(-20);


    const tCfg = tConfig(lang);
    const products = await loadProductsForProject(projectId);

   const systemPrompt = `

    const systemPrompt = `

Ti si inteligentni chatbot za primanje narudžbi proizvoda iz kataloga.

Uvijek odgovaraj na jeziku: ${
  lang === "de" ? "njemački" : lang === "en" ? "engleski" : "hrvatski"
}.

Katalog proizvoda (nazivi i cijene dolje su već iz baze):

${products
  .map((p) => {
    const popustText = p.is_discount_active
      ? (p.discount_name || "aktivni popust")
      : "nema popusta";

    return \`- SKU: ${p.sku}, HR: ${p.name_hr}, DE: ${p.name_de}, EN: ${p.name_en}, cijena: ${p.base_price} €. Popust: ${popustText}.\`;
  })
  .join("\\n")}

VAŽNA PRAVILA RADA (IDENTIFIKACIJA KLIJENTA):

1. U PRVOJ PORUCI TI SE OBRATIŠ KLIJENTU I LJUBAZNO GA ZAMOLIŠ
   DA NAJPRIJE NAVEDE SVOJ BROJ TELEFONA.
   NEMOJ ODMAH TRAŽITI NARUDŽBU, NEGO PRVO TELEFON.

   Primjeri prvog pitanja (ovisno o jeziku):
   - HR: "Dobrodošli! Molim vas, prvo navedite svoj broj telefona."
   - DE: "Willkommen! Bitte geben Sie zuerst Ihre Telefonnummer an."
   - EN: "Welcome! Please first tell me your phone number."

2. Nakon što korisnik pošalje broj telefona:
   - ZATIM traži ostale podatke: ime, PIN (lozinku) i detalje narudžbe
     (proizvodi iz kataloga, količina, vrijeme preuzimanja).

3. PIN:
   - PIN služi za potvrdu narudžbi i izmjena.
   - U svakom procesu narudžbe trebaš imati jasno naveden PIN.
   - Za NOVE klijente PIN se definira prvi put kada daju broj telefona + ime.
   - Za VEĆ POSTOJEĆE klijente tražiš da potvrde isti PIN prije potvrde nove narudžbe.

4. TI NE PROVJERAVAŠ BAZU DIREKTNO.
   Backend sustav provjerava postoji li taj telefon i PIN.
   Tvoj zadatak je SAMO da prikupiš:
   - broj telefona,
   - ime,
   - PIN,
   - proizvode,
   - količine,
   - vrijeme preuzimanja.

5. NIKADA NEMOJ SPOMINJATI "backend", "bazu podataka" ili tehničke detalje.
   Korisniku odgovaraj normalno, npr.:
   - "Ukupna cijena je približno X €."
   - "Vašu narudžbu ću proslijediti na pripremu."
   NIKAD nemoj reći: "cijena će biti izračunata na backendu" ili slično.

6. Ako korisnik uporni šalje sadržaj koji nema veze s narudžbom
   (random tekst, oglasi, dugački copy/paste s Facebooka, itd.),
   nakon nekoliko pokušaja objašnjenja smiješ ljubazno prekinuti razgovor:
   - HR: "Nažalost, bez konkretnih podataka o narudžbi ne mogu pomoći.
          Ako želite naručiti, molim vas da napišete proizvod, količinu i vrijeme preuzimanja."
   - DE/EN analogno.

7. Ako korisnik uopće ne da broj telefona:
   - Objasni da bez broja telefona ne možeš potvrditi narudžbu.
   - Nemoj generirati JSON_ORDER bez telefona.

Tvoj zadatak (sažetak):

1. Vodi korisnika kroz narudžbu:
   - prvo telefon,
   - zatim ime,
   - PIN,
   - proizvodi iz kataloga (SKU ili naziv),
   - količine,
   - vrijeme preuzimanja (pickup_time).

2. Na temelju kataloga i količina napravi prijedlog ukupne cijene
   (samo koristi cijene koje vidiš gore; backend će precizno izračunati).
   - Nemoj objašnjavati da backend računa cijenu.
   - Korisniku samo reci finalni iznos u valuti.

3. Kada korisnik JASNO potvrdi narudžbu, **OBAVEZNO** na kraj poruke dodaj:
   \`JSON_ORDER: {...}\`

JSON mora sadržavati:
- projectId
- phone
- pin
- name
- pickup_time
- items → objekt:
  npr.
    {
      "TEST-PROD-01": 2,
      "TEST-PROD-02": 1
    }
- total → broj ili null ako nisi siguran

4. Ako korisnik želi izmijeniti prethodnu narudžbu:
   - koristi isti telefon + PIN,
   - prikupi nove količine proizvoda,
   - generiraj novi JSON_ORDER.

5. Budi kratak, jasan i ljubazan.
   Ne spominji interne tehničke detalje, backend, baze podataka, JSON
   (osim u skrivenom JSON_ORDER bloku na kraju poruke).

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

      // Izvuci SAMO prvi JSON objekt između { }
      const match = jsonPart.match(/\{[\s\S]*\}/);
      if (match) {
        const jsonOnly = match[0];
        try {
          finalOrder = JSON.parse(jsonOnly);
        } catch (e) {
          console.error("JSON_ORDER parse error (inner JSON):", e, jsonOnly);
        }
      } else {
        console.error("JSON_ORDER not found as JSON object:", jsonPart);
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

        const usedProjectId = projectId || projFromModel || "burek01";


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

// -----------------------
// ADMIN: ORDERS API (bez store_id filtra)
// -----------------------
app.get("/api/admin/orders", adminAuth, async (req, res) => {
  try {
    const projectId = req.query.project || "burek01";
    const statusFilter = req.query.status || "open";   // open | all
    const dateFilter = req.query.date || "today";      // today | all

    let query = supabase
      .from("orders")
      .select("*")
      .eq("project_id", projectId)
      .neq("status", "draft"); // ne prikazujemo nacrte

    // status filter
    if (statusFilter === "open") {
      query = query.in("status", ["confirmed"]);
    } else if (statusFilter === "all") {
      query = query.in("status", ["confirmed", "delivered", "canceled"]);
    }

    // date filter
    if (dateFilter === "today") {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const isoStart = today.toISOString();
      query = query.gte("created_at", isoStart);
    }

    const { data, error } = await query.order("created_at", {
      ascending: false,
    });

    if (error) {
      console.error("ADMIN /orders error:", error);
      return res.status(500).json({ error: "DB error", details: error.message });
    }

    const orders = (data || []).map((o) => ({
      id: o.id,
      created_at: o.created_at,
      pickup_time: o.pickup_time,
      name: o.user_name || o.name || "",
      phone: o.user_phone || o.phone || "",
      items: o.items || {},
      total: o.total,
      status: o.status,
    }));

    return res.json({ orders });
  } catch (err) {
    console.error("ADMIN /orders exception:", err);
    return res.status(500).json({ error: "Server error" });
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
    const projectId = req.query.project || "burek01";

    const { data, error } = await supabase
      .from("products")
      .select("*")
      .eq("project_id", projectId)
      .order("id", { ascending: true });

    if (error) {
      console.error("/api/admin/products error:", error);
      return res.status(500).json({ error: "products_error", detail: error.message });
    }

    res.json({ products: data || [] });
  } catch (err) {
    console.error("/api/admin/products exception:", err);
    res.status(500).json({ error: "products_exception", detail: String(err) });
  }
});

app.post("/api/admin/products", async (req, res) => {
  try {
    const projectId = req.body.projectId || "burek01";
    const payload = req.body || {};

    const product = {
      project_id: projectId,
      sku: payload.sku,
      name_hr: payload.name_hr,
      name_de: payload.name_de,
      name_en: payload.name_en,
      base_price: Number(payload.base_price || 0),
      discount_type: payload.discount_type || null,      // "percentage" | "fixed" | null
      discount_value: payload.discount_value != null ? Number(payload.discount_value) : null,
      discount_name: payload.discount_name || null,
      is_discount_active: !!payload.is_discount_active,
      allowed_categories: Array.isArray(payload.allowed_categories)
        ? payload.allowed_categories
        : (payload.allowed_categories ? String(payload.allowed_categories).split(",").map(c => c.trim()).filter(Boolean) : []),
      is_active: payload.is_active !== false
    };

    let result;

    // UPDATE
    if (payload.id) {
      const { data, error } = await supabase
        .from("products")
        .update(product)
        .eq("id", payload.id)
        .select()
        .single();

      if (error) {
        console.error("products update error:", error);
        return res.status(500).json({ error: "update_error", detail: error.message });
      }
      result = data;

    // INSERT
    } else {
  const { data, error } = await supabase
    .from("products")
    .insert({
      id: randomUUID(),       // <── ovdje dodaj ID
      ...product
    })
    .select()
    .single();

      if (error) {
        console.error("products insert error:", error);
        return res.status(500).json({ error: "insert_error", detail: error.message });
      }
      result = data;
    }

    res.json({ product: result });
  } catch (err) {
    console.error("/api/admin/products POST exception:", err);
    res.status(500).json({ error: "exception", detail: String(err) });
  }
});

/* ------------------------------------------------------------------ */
/*  ADMIN: CUSTOMERS API                                               */
/* ------------------------------------------------------------------ */

app.get("/api/admin/customers", async (req, res) => {
  try {
    const projectId = req.query.project || "burek01";

    const { data, error } = await supabase
      .from("customers")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("/api/admin/customers error:", error);
      return res.status(500).json({ error: "customers_error", detail: error.message });
    }

    res.json({ customers: data || [] });
  } catch (err) {
    console.error("/api/admin/customers exception:", err);
    res.status(500).json({ error: "customers_exception", detail: String(err) });
  }
});

app.post("/api/admin/customers", async (req, res) => {
  try {
    const projectId = req.body.projectId || "burek01";

    // iz bodyja dolazi: id?, phone, pin, name, categories (array)
    const payload = req.body || {};

    const customer = {
      project_id: projectId,
      phone: payload.phone,
      pin: payload.pin,
      name: payload.name || null,
      categories: Array.isArray(payload.categories)
        ? payload.categories
        : (payload.categories ? String(payload.categories).split(",").map(c => c.trim()).filter(Boolean) : [])
    };

    let result;

    // UPDATE
    if (payload.id) {
      const { data, error } = await supabase
        .from("customers")
        .update(customer)
        .eq("id", payload.id)
        .select()
        .single();

      if (error) {
        console.error("customers update error:", error);
        return res.status(500).json({ error: "update_error", detail: error.message });
      }
      result = data;

    // INSERT
    } else {
  const { data, error } = await supabase
    .from("customers")
    .insert({
      id: randomUUID(),          // <── ovdje dodaj ID
      ...customer
    })
    .select()
    .single();

      if (error) {
        console.error("customers insert error:", error);
        return res.status(500).json({ error: "insert_error", detail: error.message });
      }
      result = data;
    }

    res.json({ customer: result });
  } catch (err) {
    console.error("/api/admin/customers POST exception:", err);
    res.status(500).json({ error: "exception", detail: String(err) });
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
