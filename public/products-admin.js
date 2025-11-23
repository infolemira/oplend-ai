(async function () {
  const projectSelect = document.getElementById("project-select");
  const tableBody = document.querySelector("#products-table tbody");
  const btnAdd = document.getElementById("btn-add");

  async function fetchProducts() {
    const project = projectSelect.value;
    const res = await fetch(
      `/api/admin/products?project=${encodeURIComponent(project)}`
    );
    if (!res.ok) {
      tableBody.innerHTML =
        '<tr><td colspan="8">Greška kod učitavanja proizvoda.</td></tr>';
      return;
    }
    const rows = await res.json();
    renderProducts(rows);
  }

  function renderProducts(rows) {
    if (!rows || !rows.length) {
      tableBody.innerHTML =
        '<tr><td colspan="8">Nema proizvoda za ovaj projekt.</td></tr>';
      return;
    }

    tableBody.innerHTML = rows
      .map((p) => {
        const cats = Array.isArray(p.allowed_categories)
          ? p.allowed_categories.join(",")
          : "";
        const discountLabel = p.is_discount_active
          ? `${p.discount_type || ""} ${p.discount_value || ""} (${p.discount_name || "bez naziva"})`
          : "Nema aktivnog popusta";

        return `
        <tr data-id="${p.id}">
          <td>${p.id}</td>
          <td><input class="small-input" type="text" value="${p.sku || ""}" data-field="sku"></td>
          <td>
            <div><small>HR</small> <input class="wide-input" type="text" value="${p.name_hr || ""}" data-field="name_hr"></div>
            <div><small>DE</small> <input class="wide-input" type="text" value="${p.name_de || ""}" data-field="name_de"></div>
            <div><small>EN</small> <input class="wide-input" type="text" value="${p.name_en || ""}" data-field="name_en"></div>
          </td>
          <td>
            <div><small>Osnovna cijena</small><br>
            <input class="small-input" type="number" step="0.01" value="${p.base_price || 0}" data-field="base_price"></div>
            <div><small>Valuta</small><br>
            <input class="small-input" type="text" value="${p.currency || "EUR"}" data-field="currency"></div>
          </td>
          <td>
            <select data-field="is_active">
              <option value="true" ${p.is_active ? "selected" : ""}>Da</option>
              <option value="false" ${!p.is_active ? "selected" : ""}>Ne</option>
            </select>
          </td>
          <td>
            <div><small>Aktivan popust</small><br>
              <select data-field="is_discount_active">
                <option value="true" ${p.is_discount_active ? "selected" : ""}>Da</option>
                <option value="false" ${!p.is_discount_active ? "selected" : ""}>Ne</option>
              </select>
            </div>
            <div><small>Vrsta</small><br>
              <select data-field="discount_type">
                <option value="" ${!p.discount_type ? "selected" : ""}>-</option>
                <option value="percent" ${
                  p.discount_type === "percent" ? "selected" : ""
                }>%</option>
                <option value="amount" ${
                  p.discount_type === "amount" ? "selected" : ""
                }>Iznos</option>
              </select>
            </div>
            <div><small>Vrijednost</small><br>
              <input class="small-input" type="number" step="0.01" value="${
                p.discount_value || 0
              }" data-field="discount_value">
            </div>
            <div><small>Naziv</small><br>
              <input class="wide-input" type="text" value="${
                p.discount_name || ""
              }" data-field="discount_name">
            </div>
            <div><small>Trenutno:</small><br><span>${discountLabel}</span></div>
          </td>
          <td>
            <input type="text" value="${cats}" data-field="allowed_categories">
            <div><small>npr. student,radnik</small></div>
          </td>
          <td>
            <button class="primary" data-action="save" data-id="${p.id}">Spremi</button><br>
            <button class="danger" data-action="delete" data-id="${p.id}">Obriši</button>
          </td>
        </tr>`;
      })
      .join("");
  }

  // Dodavanje novog proizvoda
  btnAdd.addEventListener("click", async () => {
    const project = projectSelect.value;
    const body = {
      project_id: project,
      sku: "NEW",
      name_hr: "Novi proizvod HR",
      name_de: "Neues Produkt DE",
      name_en: "New product EN",
      base_price: 5,
      currency: "EUR",
      is_active: true,
      discount_type: null,
      discount_value: null,
      discount_name: null,
      is_discount_active: false,
      allowed_categories: []
    };

    await fetch("/api/admin/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    fetchProducts();
  });

  tableBody.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    const id = btn.getAttribute("data-id");
    const row = tableBody.querySelector(`tr[data-id="${id}"]`);
    if (!row) return;

    if (action === "delete") {
      await fetch(`/api/admin/products/${id}`, { method: "DELETE" });
      fetchProducts();
      return;
    }

    if (action === "save") {
      const payload = {};
      row.querySelectorAll("[data-field]").forEach((el) => {
        const field = el.getAttribute("data-field");
        let val = el.value;
        if (field === "is_active" || field === "is_discount_active") {
          payload[field] = val === "true";
        } else if (field === "base_price" || field === "discount_value") {
          payload[field] = parseFloat(val || "0");
        } else if (field === "allowed_categories") {
          payload[field] = val
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        } else {
          payload[field] = val;
        }
      });

      await fetch(`/api/admin/products/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      fetchProducts();
    }
  });

  projectSelect.addEventListener("change", fetchProducts);
  fetchProducts();
})();
