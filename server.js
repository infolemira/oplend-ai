import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// --- Express app ---
const app = express();
app.use(express.json());

// --- CORS ---
app.use(
  cors({
    origin: ["https://oplend.com", "https://www.oplend.com"],
  })
);

// --- ENV ---
const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

// OpenAI client
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Supabase client
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

// --- PROJECT CONFIG ---
const PROJECTS = {
  burek01: {
    lang: "multi",
    title: "Burek – Online-Bestellung",
    pricing: { kaese: 3.5, fleisch: 4.0, kartoffeln: 3.5 },
    systemPrompt: `
Du bist ein Bestell-Assistent für eine Bäckerei.

SPRACHE:
- Antworte immer in der gleichen Sprache wie die LETZTE Nachricht des Kunden.
- English → answer in English
- Deutsch → antworten auf Deutsch
- Bosanski/Hrvatski/Srpski → odgovaraj tim jezikom
- Ne mijenjaj jezik usred razgovora.

(ostatak tvog sistema…)    
    `,
  },
};

// --- Quantity parsers ---
function parseQuantities(text) {
  const lower = (text || "").toLowerCase();

  const extract = (re) => {
    const
