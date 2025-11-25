// tenantContext.js
// Middleware koji određuje firm/store na temelju URL parametara
// i puni req.tenant = { firmId, storeId, projectId, lang, store, firm }

const { supabase } = require('./supabaseClient'); // prilagodi ako je drugačiji path

async function tenantContext(req, res, next) {
  try {
    const lang = (req.query.lang || req.body?.lang || 'hr').toLowerCase();

    const storeSlug = req.query.store || req.body?.store || null;
    const storeId   = req.query.store_id || req.body?.store_id || null;
    const projectId = req.query.project_id || req.body?.project_id || null;

    let store = null;

    // Po store_id
    if (storeId) {
      const { data } = await supabase
        .from('stores')
        .select('*')
        .eq('id', storeId)
        .eq('is_active', true)
        .single();
      if (data) store = data;
    }

    // Po slug
    if (!store && storeSlug) {
      const { data } = await supabase
        .from('stores')
        .select('*')
        .eq('slug', storeSlug)
        .eq('is_active', true)
        .single();
      if (data) store = data;
    }

    // Po legacy project_id
    if (!store && projectId) {
      const { data } = await supabase
        .from('stores')
        .select('*')
        .eq('legacy_project_id', projectId)
        .eq('is_active', true)
        .single();
      if (data) store = data;
    }

    // Ako nema – koristi default TEST store 01
    if (!store) {
      const { data } = await supabase
        .from('stores')
        .select('*')
        .eq('id', '00000000-0000-0000-0000-000000000101')
        .single();
      if (!data) return res.status(400).json({ error: 'Store not found (default)' });

      store = data;
    }

    // Učitaj firmu
    let firm = null;
    if (store.firm_id) {
      const { data } = await supabase
        .from('firms')
        .select('*')
        .eq('id', store.firm_id)
        .single();
      if (data) firm = data;
    }

    req.tenant = {
      lang,
      projectId: projectId || store.legacy_project_id || 'TEST-PROJECT-01',
      storeId: store.id,
      firmId: store.firm_id,
      store,
      firm
    };

    next();
  } catch (err) {
    console.error('tenantContext error:', err);
    return res.status(500).json({ error: 'Tenant middleware error' });
  }
}

module.exports = { tenantContext };
