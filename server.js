// server.js – Oplend AI (CORS fix, mobile fix, multilang fix, full working version)

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

// =============================
//  CORS FIX (radi i na mobitelima)
// =============================
app.use(
  cors({
    origin: (origin, callback) => {
      callback(null, true); // dozvoli sve JS zahtjeve
    },
  })
);

// --- ENV varijable ---
const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

// --- OpenAI client ---
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- Supabase client ---
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

// =============================
//   PROJEKTI
// =============================
const PROJECTS = {
  burek01: {
    title: "Burek – Online-Bestellung",
    pricing: { kaese: 3.5, fleisch: 4.0, kartoffeln: 3.5 },

    // *** AI uči da odgovara na jeziku korisnika ***
    systemPrompt: `
Ti si AI asistent za primanje narudžbi za:

1) Burek sa sirom
2) Burek sa mesom
3) Burek sa krompirom

JEZIK:
— UVIJEK odgovaraj na jeziku POSLJEDNJE poruke korisnika.
— Dozvoljeni jezici: Bosanski / Hrvatski / Srpski / Njemački / Engleski.
— Ako korisnik promijeni jezik → i ti promijeni.

TVOJ ZADATAK:
— Prihvatiti nove narudžbe
— Mijenjati postojeće (više/manje/ukupno)
— Odgovarati na pitanja
— Raditi storno
— Pitati dodatno kad nešto nije jasno

NIKAD:
— Ne nuditi proizvode koji nisu burek
— Ne mijenjati temu

CILJ:
— Prikupiti: vrste, količine, vrijeme preuzimanja, ime, telefon
— Na kraju napraviti jasnu potvrdu narudžbe
`,
  },
};

// =============================
//  Funkcije za parsiranje količina
// =============================
function parseQuantities(text) {
  if (!text) return { kaese: 0, fleisch: 0, kartoffeln: 0 };
  const lower = text.toLowerCase();

  const extract = (re) => {
    const m = lower.match(re);
    return m ? Number(m[1]) || 0 : 0;
  };

  return {
    kaese: extract(/(\d+)\s*(?:x)?[^\n]{0,20}(käse|kaese|sir)/),
    fleisch: extract(/(\d+)\s*(?:x)?[^\n]{0,20}(fleisch|meso)/),
    kartoffeln: extract(/(\d+)\s*(?:x)?[^\n]{0,20}(kartoffeln?|krompir|krumpir)/),
  };
}

function parseQuantitiesFromConversation(userHistory, lastMsg) {
  return parseQuantities(
    userHistory.map((m) => m.content).join("\n") + "\n" + lastMsg
  );
}

// =============================
//  WIDGET.JS ENDPOINT (MOBILE FIX)
// =============================
app.get("/widget.js", (req, res) => {
  const js = `
(function(){

  const script = document.currentScript || document.querySelector('script[data-project]'); // mobile fix
  const projectId = script.getAttribute('data-project') || 'burek01';
  const host = script.src.split("/widget.js")[0];

  const history = [];

  const box = document.createElement('div');
  box.style.cssText = "max-width:900px;margin:0 auto;border:1px solid #ddd;border-radius:10px;overflow:hidden;font-family:Arial";

  box.innerHTML = "<div style='padding:14px 16px;border-bottom:1px solid #eee;background:white'>" +
    "<h2 style='margin:0;font-size:22px'>Chat</h2>" +
    "<div id='opl-desc' style='margin-top:6px;color:#555;font-size:14px'></div>" +
    "</div>" +
    "<div id='opl-chat' style='height:60vh;overflow:auto;padding:12px;background:#fafafa'></div>" +
    "<div style='display:flex;gap:8px;padding:12px;border-top:1px solid #eee;background:white'>" +
    "<textarea id='opl-in' placeholder='Nachricht...' style='flex:1;min-height:44px;border:1px solid #ddd;border-radius:8px;padding:10px'></textarea>" +
    "<button id='opl-send' style='padding:10px 16px;border:1px solid #222;background:#222;color:white;border-radius:8px;cursor:pointer'>Senden</button>" +
    "</div>";

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

    const b =
