// supabaseClient.js
// ─────────────────────────────────────────────────────────────
//  Shared Supabase client — import this wherever you need DB access
//  Works in both main.js (frontend) and dashboard.html (inline script)
//
//  Get your keys from:
//  Supabase Dashboard → Project Settings → API
// ─────────────────────────────────────────────────────────────

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

// ── YOUR SUPABASE CREDENTIALS ─────────────────────────────────
// Project URL:  Supabase Dashboard → Settings → API → Project URL
// Anon key:     Supabase Dashboard → Settings → API → anon (public)
//               The anon key is safe to expose in frontend code —
//               RLS policies protect what it can actually access.

export const SUPABASE_URL = "https://paxeivuabqbfodnjxfpw.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBheGVpdnVhYnFiZm9kbmp4ZnB3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyNDQwMTAsImV4cCI6MjA4OTgyMDAxMH0.iit20CxI6S04wEJgsPRmEyf3oziSD4e9T2SjJGlHiVQ";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
