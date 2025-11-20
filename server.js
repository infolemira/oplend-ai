app.get("/widget.js", (req, res) => {
  const js = `
(function(){
  // Uvijek koristi domenu gdje je skripta učitana (dinamički host)
  const script = document.currentScript || document.querySelector('script[data-project]');
  const projectId = script.getAttribute('data-project') || 'burek01';
  const host = script.src.split("/widget.js")[0];

  const history = [];

  // Glavni box
  const box = document.createElement('div');
  box.style.cssText = "max-width:900px;margin:0 auto;border:1px solid #ddd;border-radius:10px;overflow:hidden;font-family:Arial,sans-serif";

  box.innerHTML =
    "<div style=\\"padding:14px 16px;border-bottom:1px solid #eee;background:white\\">" +
      "<h2 style=\\"margin:0;font-size:22px\\">Chat</h2>" +
      "<div id=\\"opl-desc\\" style=\\"margin-top:6px;color:#555;font-size:14px\\"></div>" +
    "</div>" +
    "<div id=\\"opl-chat\\" style=\\"height:60vh;overflow:auto;padding:12px;background:#fafafa\\"></div>" +
    "<div style=\\"display:flex;gap:8px;padding:12px;border-top:1px solid #eee;background:white\\">" +
      "<textarea id=\\"opl-in\\" placeholder=\\"Nachricht...\\" style=\\"flex:1;min-height:44px;border:1px solid #ddd;border-radius:8px;padding:10px\\"></textarea>" +
      "<button id=\\"opl-send\\" style=\\"padding:10px 16px;border:1px solid #222;background:#222;color:white;border-radius:8px;cursor:pointer\\">Senden</button>" +
    "</div>";

  script.parentNode.insertBefore(box, script);

  const chat = document.getElementById('opl-chat');
  const input = document.getElementById('opl-in');
  const sendBtn = document.getElementById('opl-send');
  const desc = document.getElementById('opl-desc');

  // Dodaj poruku u chat
  function add(role, text){
    const row = document.createElement('div');
    row.style.margin = "8px 0";
    row.style.display = "flex";
    row.style.justifyContent = role === 'user' ? 'flex-end' : 'flex-start';

    const b = document.createElement('div');
    b.style.maxWidth = "75%";
    b.style.padding = "10px 12px";
    b.style.borderRadius = "12px";
    b.style.whiteSpace = "pre-wrap";
    b.style.border = "1px solid " + (role === 'user' ? "#d6e3ff" : "#eee");
    b.style.background = role === 'user' ? "#e8f0ff" : "white";
    b.textContent = text;

    row.appendChild(b);
    chat.appendChild(row);
    chat.scrollTop = chat.scrollHeight;
  }

  // Učitaj config
  fetch(host + "/api/projects/" + projectId + "/config")
    .then(r => r.json())
    .then(cfg => {
      var welcome = cfg.welcome || "Willkommen! Was darf’s sein?";
      desc.textContent = cfg.description || "";
      add("assistant", welcome);
      history.push({ role: "assistant", content: welcome });
    })
    .catch(err => {
      console.error("Config error:", err);
      var welcome = "Willkommen! Was darf’s sein?";
      add("assistant", welcome);
      history.push({ role: "assistant", content: welcome });
    });

  // Slanje poruke
  async function send(){
    var text = input.value.trim();
    if(!text) return;

    input.value = "";
    add("user", text);
    history.push({ role: "user", content: text });

    var row = document.createElement("div");
    row.style.margin = "8px 0";
    row.innerHTML =
      "<div style='padding:10px 12px;border-radius:12px;border:1px solid #eee;background:white'>…</div>";

    chat.appendChild(row);
    chat.scrollTop = chat.scrollHeight;
    var bubble = row.querySelector("div");

    try {
      var r = await fetch(host + "/api/chat", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          projectId: projectId,
          message: text,
          history: history
        })
      });

      var j = await r.json();
      var reply = j.reply || "OK.";

      bubble.textContent = reply;
      history.push({ role: "assistant", content: reply });

    } catch (err) {
      bubble.textContent = "Fehler beim Senden.";
      console.error("Chat error:", err);
    }
  }

  sendBtn.onclick = send;

  input.addEventListener("keydown", function(e){
    if(e.key === "Enter" && !e.shiftKey){
      e.preventDefault();
      send();
    }
  });

})();
`;
  res.setHeader("Content-Type", "application/javascript");
  res.send(js);
});
