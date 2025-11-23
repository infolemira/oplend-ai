// products-admin.js – jednostavan UI za uređivanje products tablice

(async function () {
  const projectId = "burek01";
  const tableBody = document.querySelector("#products-table tbody");
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

  async function loadProducts() {
    tableBody.innerHTML = "<tr><td colspan='9'>Učitavanje...</td></tr>";
    try {
      const res = await fetch(
        `/api/admin/products?projectId=${encodeURIComponent(projectId)}`
      );
      if (!res.ok) throw new Error("Greška kod učitavanja proizvoda");
      const data = await res.json();
      renderRows(data.products || []);
    } catch (err) {
      console.error(err);
      tableBody.innerHTML =
        "<tr><td colspan='9'>Greška kod učitavanja.</td></tr>";
      setStatus("Greška kod učitavanja proizvoda.", true);
    }
  }

  function renderRows(products) {
    if (!products.length) {
      tableBody.innerHTML =
        "<tr><td colspan='9'>Nema proizvoda.</td></tr>";
      return;
    }

    tableBody.innerHTML = "";

    products.forEach((p) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><input type="text" value="${p.name || ""}" data-field="name" /></td>
        <td><input type="text" value="${p.code || ""}" data-field="code" /></td>
        <td><input type="number" step="0.01" value="${p.base_price || ""}" data-field="base_price" /></td>
        <td><input type="text" value="${p.discount_name || ""}" data-field="discount_name" /></td>
        <td><input type="number" step="0.01" value="${p.discount_price || ""}" data-field="discount_price" /></td>
        <td><input type="datetime-local" value="${p.discount_start ? toLocalInputValue(p.discount_start) : ""}" data-field="discount_start" /></td>
        <td><input type="datetime-local" value="${p.discount_end ? toLocalInputValue(p.discount_end) : ""}" data-field="discount_end" /></td>
        <td><input type="text" value="${(p.discount_allowed_categories || []).join(",")}" data-field="discount_allowed_categories" /></td>
        <td><button class="btn-save">Spremi</button></td>
      `;

      const saveBtn = tr.querySelector(".btn-save");
      saveBtn.addEventListener("click", () => saveRow(p.id, tr));

      tableBody.appendChild(tr);
    });
  }

  function toLocalInputValue(ts) {
    const d = new Date(ts);
    const pad = (n) => (n < 10 ? "0" + n : "" + n);
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mi = pad(d.getMinutes());
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
  }

  async function saveRow(id, tr) {
    const inputs = tr.querySelectorAll("input");
    const payload = {};

    inputs.forEach((inp) => {
      const field = inp.getAttribute("data-field");
      if (!field) return;
      payload[field] = inp.value;
    });

    try {
      setStatus("Spremam...", false);
      const res = await fetch(`/api/admin/products/${id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Greška kod spremanja");

      setStatus("Proizvod spremljen.", false);
      await loadProducts();
    } catch (err) {
      console.error(err);
      setStatus("Greška kod spremanja proizvoda.", true);
    }
  }

  loadProducts();
})();
