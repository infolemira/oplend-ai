(async function () {
  const projectSelect = document.getElementById("project-select");
  const statusSelect = document.getElementById("status-select");
  const dateSelect = document.getElementById("date-select");
  const refreshBtn = document.getElementById("refresh-btn");
  const tableBody = document.querySelector("#orders-table tbody");
  const sumInfo = document.getElementById("sum-info");

  async function fetchOrders() {
    const project = projectSelect.value;
    const status = statusSelect.value;
    const date = dateSelect.value;

    const url = `/api/admin/orders?project=${encodeURIComponent(
      project
    )}&status=${encodeURIComponent(status)}&date=${encodeURIComponent(date)}`;
    const res = await fetch(url);
    if (!res.ok) {
      tableBody.innerHTML =
        '<tr><td colspan="9">Greška kod učitavanja narudžbi.</td></tr>';
      return;
    }
    const rows = await res.json();
    renderOrders(rows);
  }

  function formatStatus(status) {
    const s = (status || "").toLowerCase();
    if (s === "confirmed")
      return '<span class="badge badge-confirmed">Potvrđena</span>';
    if (s === "delivered")
      return '<span class="badge badge-delivered">Isporučena</span>';
    if (s === "canceled")
      return '<span class="badge badge-canceled">Otkazana</span>';
    return `<span class="badge">${status}</span>`;
  }

  function renderOrders(rows) {
    if (!rows || !rows.length) {
      tableBody.innerHTML =
        '<tr><td colspan="9" class="text-muted">Nema narudžbi za odabrani filter.</td></tr>';
      sumInfo.textContent = "";
      return;
    }

    let sumTotal = 0;
    let sumConfirmed = 0;

    const html = rows
      .map((row) => {
        const created = row.created_at
          ? new Date(row.created_at).toLocaleString()
          : "";
        const pickup = row.pickup_time || "";
        const name = row.name || "";
        const phone = row.phone || "";
        const total =
          typeof row.total === "number"
            ? row.total.toFixed(2) + " " + (row.currency || "EUR")
            : "";

        if (typeof row.total === "number") {
          sumTotal += row.total;
          if (row.status === "confirmed") {
            sumConfirmed += row.total;
          }
        }

        const itemsRaw = row.items?.raw || {};
        const lines = row.items?.lines || [];

        const itemsText =
          lines.length > 0
            ? lines
                .map((l) => {
                  return `${l.quantity}x ${l.sku} (${l.unit_price.toFixed(
                    2
                  )}€)` + (l.discount_name ? ` – ${l.discount_name}` : "");
                })
                .join("<br>")
            : Object.entries(itemsRaw)
                .map(([k, v]) => `${v}x ${k}`)
                .join("<br>");

        const actions = [];
        if (row.status === "confirmed") {
          actions.push(
            `<button class="primary" data-action="delivered" data-id="${row.id}">Isporučeno</button>`
          );
          actions.push(
            `<button class="danger" data-action="canceled" data-id="${row.id}">Otkazano</button>`
          );
        }

        return `
        <tr>
          <td>${row.id}</td>
          <td>${created}</td>
          <td>${name}</td>
          <td>${phone}</td>
          <td>${pickup}</td>
          <td>${itemsText || ""}</td>
          <td>${total}</td>
          <td>${formatStatus(row.status)}</td>
          <td>${actions.join("<br>")}</td>
        </tr>`;
      })
      .join("");

    tableBody.innerHTML = html;

    sumInfo.textContent = `Broj narudžbi: ${
      rows.length
    } | Ukupno: ${sumTotal.toFixed(
      2
    )} EUR | Ukupno otvorene: ${sumConfirmed.toFixed(2)} EUR`;
  }

  tableBody.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    const id = btn.getAttribute("data-id");

    if (action === "delivered") {
      await fetch(`/api/admin/orders/${id}/delivered`, { method: "POST" });
      fetchOrders();
    } else if (action === "canceled") {
      await fetch(`/api/admin/orders/${id}/canceled`, { method: "POST" });
      fetchOrders();
    }
  });

  refreshBtn.addEventListener("click", fetchOrders);
  statusSelect.addEventListener("change", fetchOrders);
  dateSelect.addEventListener("change", fetchOrders);
  projectSelect.addEventListener("change", fetchOrders);

  fetchOrders();
})();
