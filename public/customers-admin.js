// customers-admin.js – jednostavan UI za uređivanje customers (ime + kategorije)

(async function () {
  const tableBody = document.querySelector("#customers-table tbody");
  const statusEl = document.getElementById("status");

  function setStatus(msg, isError = false) {
    statusEl.textContent = msg || "";
    statusEl.className = isError ? "status error" : "status";
    if (msg) {
      setTimeout(() => {
        statusEl.textContent = "";
      }, 4000);
    }
  }

  async function loadCustomers() {
    tableBody.innerHTML = "<tr><td colspan='5'>Učitavanje...</td></tr>";
    try {
      const res = await fetch(`/api/admin/customers`);
      if (!res.ok) throw new Error("Greška kod učitavanja customers");
      const data = await res.json();
      renderRows(data.customers || []);
    } catch (err) {
      console.error(err);
      tableBody.innerHTML =
        "<tr><td colspan='5'>Greška kod učitavanja.</td></tr>";
      setStatus("Greška kod učitavanja customers.", true);
    }
  }

  function renderRows(customers) {
    if (!customers.length) {
      tableBody.innerHTML =
        "<tr><td colspan='5'>Još nema registriranih customers.</td></tr>";
      return;
    }

    tableBody.innerHTML = "";

    customers.forEach((c) => {
      const tr = document.createElement("tr");
      const cats = Array.isArray(c.categories) ? c.categories.join(",") : "";
      const created = c.created_at
        ? new Date(c.created_at).toLocaleString()
        : "";

      tr.innerHTML = `
        <td>${c.phone || ""}</td>
        <td><input type="text" value="${c.name || ""}" data-field="name" /></td>
        <td><input type="text" value="${cats}" data-field="categories" /></td>
        <td>${created}</td>
        <td><button class="btn-save">Spremi</button></td>
      `;

      const saveBtn = tr.querySelector(".btn-save");
      saveBtn.addEventListener("click", () => saveRow(c.phone, tr));

      tableBody.appendChild(tr);
    });
  }

  async function saveRow(phone, tr) {
    const nameInput = tr.querySelector('input[data-field="name"]');
    const categoriesInput = tr.querySelector(
      'input[data-field="categories"]'
    );

    const payload = {
      name: nameInput.value,
      categories: categoriesInput.value,
    };

    try {
      setStatus("Spremam...", false);
      const res = await fetch(
        `/api/admin/customers/${encodeURIComponent(phone)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }
      );

      if (!res.ok) throw new Error("Greška kod spremanja");

      setStatus("Customer spremljen.", false);
      await loadCustomers();
    } catch (err) {
      console.error(err);
      setStatus("Greška kod spremanja customer-a.", true);
    }
  }

  loadCustomers();
})();
