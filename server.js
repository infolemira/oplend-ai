import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

// CORS – dozvoli samo tvoj sajt
app.use(
  cors({
    origin: [
      "https://oplend.com",
      "https://www.oplend.com"
    ],
  })
);

// -------- ENV VARS --------
const {
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY
} = process.env;

// OpenAI client
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
});

// Supabase client
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

// -------- PROJECT CONFIGS --------
const PROJECTS = {
  "burek01": {
    lang: "de",
    title: "Burek – Online-Bestellung",
    pricing: { kaese: 3.5, fleisch: 4.0, kartoffeln: 3.5 },
    systemPrompt: `
Du bist ein Bestell-Assistent für eine Bäckerei. Du nimmst ausschließlich Bestellungen für:
1) Burek mit Käse
2) Burek mit Fleisch
3) Burek mit Kartoffeln

Regeln:
- Antworte immer auf Deutsch.
- Frage nach Sorte, Anzahl, Abholzeit, Name, Telefonnummer.
- Berechne den Gesamtpreis anhand der Preisliste.
- Erstelle am Ende eine klare Zusammenfassung.
- Keine anderen Produkte anbieten.
`
  }
};

// -------- WIDGET.JS --------
app.get("/widget.js", (req, res) => {
  const js = `
(function(){
  const script = document.currentScript;
  const projectId = script.getAttribute('data-project') || 'burek01';
  const host = script.src.split("/widget.js")[0];

  // Create widget box
  const box = document.createElement('div');
  box.style.cssText = "max-width:900px;margin:0 auto;border:1px solid #ddd;border-radius:10px;overflow:hidden;font-family:Arial, sans-serif";

  box.innerHTML = \`
    <div style="padding:14px 16px;border-bottom:1px solid #eee;background:white">
      <h2 style="margin:0;font-size:22px">Chat</h2>
      <div id="opl-desc" style="margin-top:6px;color:#555;font-size:14px"></div>
    </div>

    <div id="opl-chat" style="height:60vh;overflow:auto;padding:12px;background:#fafafa"></div>

    <div style="display:flex;gap:8px;padding:12px;border-top:1px solid #eee;background:white">
      <textarea id="opl-in" placeholder="Nachricht..." style="flex:1;min-height:44px;border:1px solid #ddd;border-radius:8px;padding:10px"></textarea>
      <button id="opl-send" style="padding:10px 14px;border:1px solid #222;background:#222;color:white;border-radius:8px;cursor:pointer">Senden</button>
    </div>
  \`;

  script.parentNode.insertBefore(box, script);

  const chat = document.getElementById('opl-chat');
  const input = document.getElementById('opl-in');
  const sendBtn = document.getElementById('opl-send');
  const desc = document.getElementById('opl-desc');

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

  // Load config
  fetch(host + "/api/projects/" + projectId + "/config")
    .then(r => r.json())
    .then(cfg => {
      desc.textContent = cfg.description || "";
      add("assistant", cfg.welcome || "Willkommen! Was darf’s sein?");
    });

  async function send(){
    const text = input.valu
