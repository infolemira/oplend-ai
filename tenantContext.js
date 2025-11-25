// tenantContext.js
// Ovaj modul samo definira funkciju koja stvara middleware.
// Supabase client mu prosljeđujemo iz server.js.

function createTenantContext(supabase) {
  // Ovo je stvarni Express middleware
  return async function tenantContext(req, res, next) {
    try {
      const lang = (req.query.lang || req.body?.lang || 'hr').toLowerCase();

      const storeSlug = req.query.store || req.body?.store || null;
      const storeId   = req.query.store_id || req.body?.store_id || null;
      const projectId = req.query.project_id || req.body?.project_id || null;

      let store = null;

      // 1) pokušaj po store_id
      if (storeId) {
        const { data } = await supabase
          .from('stores')
          .select('*')
          .eq('id', storeId)
          .eq('is_active', true)
          .maybeSingle();

        if (data) store = data;
      }

      // 2) pokušaj po slug-u (?store=test-store-01)
      if (!store && storeSlug) {
        const { data } = await supabase
          .from('stores')
          .select('*')
          .eq('slug', storeSlug)
          .eq('is_active', true)
          .maybeSingle();

        if (data) store = data;
      }

      // 3) pokušaj po legacy project_id
      if (!store && projectId) {
        const { data } = await supabase
          .from('stores')
          .select('*')
          .eq('legacy_project_id', projectId)
          .eq('is_active', true)
          .maybeSingle();

        if (data) store = data;
      }

      // 4) fallback: default Test store 01 (ID iz SQL skripte)
      if (!store) {
        const { data } = await supabase
          .from('stores')
          .select('*')
          .eq('id', '00000000-0000-0000-0000-000000000101')
          .single();

        if (!data) {
          return res.status(400).json({ error: 'Store context not found' });
        }

        store = data;
      }

      // 5) učitaj firmu
      let firm = null;
      if (store.firm_id) {
        const { data } = await supabase
          .from('firms')
          .select('*')
          .eq('id', store.firm_id)
          .single();

        if (data) firm = data;
      }

      // 6) spremi u req.tenant
      req.tenant = {
        lang,
        projectId: projectId || store.legacy_project_id || 'TEST-PROJECT-01',
        storeId: store.id,
        firmId: store.firm_id,
        store,
        firm,
      };

      next();
    } catch (err) {
      console.error('tenantContext error:', err);
      return res.status(500).json({ error: 'Tenant middleware error' });
    }
  };
}

module.exports = { createTenantContext };
