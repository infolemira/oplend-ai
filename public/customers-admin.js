(async function () {
  const projectSelect = document.getElementById("project-select");
  const tableBody = document.querySelector("#customers-table tbody");
  const btnAdd = document.getElementById("btn-add");

  async function fetchCustomers() {
    const project = projectSelect.value;
    const res = await fetch(
      `/api/admin/customers?project=${encodeURIComponent(project)}`
    );
    if (!res.ok) {
      tableBody.innerHTML =
        '<tr><td colspan="6">Greška kod učitavanja kupaca.</td></tr>';
      return;
    }
    const rows = await res.json();
    renderCustomers(rows);
  }

  function renderCustomers(rows) {
    if (!rows || !rows.length) {
      tableBody.innerHTML =
        '<tr><td colspan="6">Nema kupaca za ovaj projekt.</td></tr>';
      return;
    }

    tableBody.innerHTML = rows
      .map((c) => {
        const cats = Array.isArray(c.categories)
          ? c.categories.join(",")
          : "";
        return `
        <tr data-id="${c.id}">
          <td>${c.id}</td>
          <td><input class="small-input" type="text" value="${c.phone || ""}" data-field="phone"></td>
          <td><input class="small-input" type="text" value="${c.pin || ""}" data-field="pin"></td>
          <td><input class="wide-input" type="text" value="${c.name || ""}" data-field="name"></td>
          <td>
            <input class="wide-input" type="text" value="${cats}" data-field="categories">
            <div><small>npr. student,radnik</small></div>
          </td>
          <td>
            <button class="primary" data-action="save" data-id="${c.id}">Spremi</button><br>
            <button class="danger" data-action="delete" data-id="${c.id}">Obriši</button>
          </td>
        </tr>`;
      })
      .join("");
  }

  btnAdd.addEventListener("click", async () => {
    const project = projectSelect.value;
    const phone = prompt("Telefon kupca:");
    if (!phone) return;
    const pin = prompt("PIN kupca (za izmjene narudžbe):");
    if (!pin) return;
    const name = prompt("Ime (opcionalno):") || "";

    const body = {
      project_id: project,
      phone,
      pin,
      name,
      categories: []
    };

    await fetch("/api/admin/customers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    fetchCustomers();
  });

  tableBody.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    const id = btn.getAttribute("data-id");
    const row = tableBody.querySelector(`tr[data-id="${id}"]`);
    if (!row) return;

    if (action === "delete") {
      await fetch(`/api/admin/customers/${id}`, { method: "DELETE" });
      fetchCustomers();
      return;
    }

    if (action === "save") {
      const payload = {};
      row.querySelectorAll("[data-field]").forEach((el) => {
        const field = el.getAttribute("data-field");
        let val = el.value;
        if (field === "categories") {
          payload[field] = val
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        } else {
          payload[field] = val;
        }
      });

      await fetch(`/api/admin/customers/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      fetchCustomers();
    }
  });

  projectSelect.addEventListener("change", fetchCustomers);
  fetchCustomers();
})();
