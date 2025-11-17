// -------- CHAT ENDPOINT --------
app.post("/api/chat", async (req, res) => {
  try {
    const { projectId = "burek01", message } = req.body || {};
    const p = PROJECTS[projectId] || PROJECTS["burek01"];

    // 1) Poruke za OpenAI
    const messages = [
      { role: "system", content: p.systemPrompt },
      { role: "user", content: message }
    ];

    const ai = await openai.chat.completions.create({
      model: "gpt-4.1-mini",       // možeš ostaviti i gpt-4o-mini ako želiš
      messages
    });

    let reply = ai.choices?.[0]?.message?.content || "OK.";

    // 2) Grubi parsing poruke za količine
    const text = (message || "").toLowerCase();

    const getQty = (patterns) => {
      for (const pat of patterns) {
        const re = new RegExp("(\\d+)\\s*(x|×)?\\s*" + pat, "i");
        const m = text.match(re);
        if (m) return Number(m[1]) || 0;
      }
      return 0;
    };

    const qtyKaese = getQty(["käse", "kaese"]);
    const qtyFleisch = getQty(["fleisch"]);
    const qtyKartoffeln = getQty(["kartoffel", "kartoffeln"]);

    const prices = p.pricing || {};
    const total =
      (qtyKaese * (prices.kaese || 0)) +
      (qtyFleisch * (prices.fleisch || 0)) +
      (qtyKartoffeln * (prices.kartoffeln || 0));

    // 3) Ako smo nešto našli, dodaj info o cijeni u odgovor
    if (total > 0) {
      const parts = [];
      if (qtyKaese) parts.push(`${qtyKaese}× Käse`);
      if (qtyFleisch) parts.push(`${qtyFleisch}× Fleisch`);
      if (qtyKartoffeln) parts.push(`${qtyKartoffeln}× Kartoffeln`);

      reply += `\n\nVorläufiger Gesamtpreis für ${parts.join(
        ", "
      )}: ${total.toFixed(2)} € (Richtwert, Zahlung bei Abholung).`;
    }

    // 4) Spremi u Supabase, ako je konfiguriran
    if (supabase) {
      await supabase.from("orders").insert({
        project_id: projectId,
        user_message: message,
        ai_reply: reply,
        items: {
          kaese: qtyKaese,
          fleisch: qtyFleisch,
          kartoffeln: qtyKartoffeln
        },
        total: total > 0 ? total : null
      });
    }

    // 5) Pošalji klijentu
    res.json({ reply, total: total > 0 ? total : null });

  } catch (e) {
    console.error("CHAT ERROR:", e);
    res.status(500).json({ error: e.message });
  }
});
