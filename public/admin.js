(async function () {

  const tableBody = document.querySelector("#orders-table tbody");
  const statusEl = document.getElementById("status");

  function setStatus(msg, isError = false) {
    statusEl.textContent = msg;
    statusEl.className = isError ? "status error" : "status";
    if (msg) setTimeout(() => (statusEl.textContent = ""), 3500);
  }

  async function loadOrders() {
    tableBody.innerHTML = "<tr><td colspan='7'>Učitavanje...</td></tr>";

    const status = document.getElementById("filter-status").value;
    const date = document.getElementById("filter-date").value;

    const url = `/api/admin/orders?project=burek01&status=${status}&date=${date}`;

    try {
      const res = await fetch(url);
      const data = await res.json();
      renderRows(data.orders || []);
    } catch (e) {
      tableBody.innerHTML = "<tr><td colspan='7'>Greška kod učitavanja.</td></tr>";
    }
  }

  function renderRows(orders) {
    if (!orders.length) {
      tableBody.innerHTML =
        "<tr><td colspan='7'>Nema narudžbi.</td></tr>";
      return;
    }

    tableBody.innerHTML = "";

    orders.forEach((o) => {
      const tr = document.createElement("tr");

      const itemsText = Object.entries(o.items || {})
        .filter((x) => x[1] > 0)
        .map(([k, v]) => `${v}× ${k}`)
        .join(", ");

      tr.innerHTML = `
        <td>${new Date(o.created_at).toLocaleString()}</td>
        <td>${o.user_name || ""}</td>
        <td>${o.user_phone || ""}</td>
        <td>${itemsText}</td>
        <td>${o.total ? o.total.toFixed(2) + " €" : ""}</td>
        <td>${o.is_cancelled ? "❌ Otkazano"
              : o.is_delivered ? "✔ Isporučeno"
              : o.is_finalized ? "🟢 Aktivno"
              : "— Nacrt"}</td>
        <td>
          ${
            !o.is_delivered && o.is_finalized
              ? `<button data-id="${o.id}" class="btn-delivered">Označi isporučeno</button>`
              : ""
          }
        </td>
      `;

      const btn = tr.querySelector(".btn-delivered");
      if (btn) {
        btn.onclick = async () => {
          try {
            const r = await fetch(`/api/admin/orders/${o.id}/delivered`, {
              method: "POST",
            });
            if (r.ok) {
              setStatus("Narudžba označena kao isporučena.");
              loadOrders();
            }
          } catch {}
        };
      }

      tableBody.appendChild(tr);
    });
  }

  document.getElementById("filter-status").onchange = loadOrders;
  document.getElementById("filter-date").onchange = loadOrders;

  loadOrders();

})();
