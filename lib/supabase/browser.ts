"use client";
import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/supabase/env";

export const supabaseBrowser = () => createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
