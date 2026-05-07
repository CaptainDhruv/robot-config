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

export const SUPABASE_URL = "https://nzevwmjhvtxjdphorjcf.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56ZXZ3bWpodnR4amRwaG9yamNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxMjkxMjMsImV4cCI6MjA5MzcwNTEyM30.cRWdxVyizbBtP0Eb984GT1E9ZM22wLe0DHWshellygQ";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
