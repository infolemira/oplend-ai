// tenantContext.js
// Jednostavan tenant middleware za FAZA 1
// - ne koristi tablice stores/firms
// - postavlja default projectId i storeId
// - izlaže NAMED export: createTenantContext

function getLangFromReq(req) {
  const q = (req.query?.lang || req.body?.lang || "hr").toLowerCase();
  if (q.startsWith("de")) return "de";
  if (q.startsWith("en")) return "en";
  return "hr";
}

export function createTenantContext(supabase) {
  const DEFAULT_PROJECT_ID = "burek01";
  const DEFAULT_STORE_ID = "00000000-0000-0000-0000-000000000101"; // Test store 01
  const DEFAULT_FIRM_ID = null;

  return async function tenantContext(req, res, next) {
    try {
      const lang = getLangFromReq(req);

      // projectId može doći iz query/body, inače default
      const projectId =
        req.query?.project ||
        req.query?.projectId ||
        req.body?.projectId ||
        DEFAULT_PROJECT_ID;

      // za sada ne čitamo iz DB, nego koristimo jedan store
      const storeId = DEFAULT_STORE_ID;
      const firmId = DEFAULT_FIRM_ID;

      req.tenant = {
        lang,
        projectId,
        storeId,
        firmId,
        store: null,
        firm: null
      };

      return next();
    } catch (err) {
      console.error("tenantContext error:", err);
      return res.status(500).json({ error: "Tenant middleware error" });
    }
  };
}
