// Service-role Supabase client for Edge Functions only.
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically into
// every Supabase Edge Function's environment — they do not need to be set
// via `supabase secrets set`. The service role key bypasses RLS, which is
// exactly why it must never be shipped to a client (desktop app, browser).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export function supabaseAdmin() {
  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
