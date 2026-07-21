// Shared CORS headers for Blubber-OS Edge Functions.
// The desktop app calls these over plain HTTPS (no browser same-origin
// constraints for Electron's main/preload fetches), but a future public web
// waitlist page would hit the same functions from a browser — so every
// function responds to OPTIONS and sets these headers on every response.

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-shopify-hmac-sha256, x-shopify-topic',
};

export function handleOptions(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  return null;
}
