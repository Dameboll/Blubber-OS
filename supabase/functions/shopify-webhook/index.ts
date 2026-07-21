// POST /functions/v1/shopify-webhook
//
// Receives Shopify's `orders/paid` webhook and grants an entitlement row for
// whichever product(s) the order contains. HMAC-verified against the raw
// request body — Shopify does not call this with our anon key, so this
// function has verify_jwt = false (see supabase/config.toml) and does its
// OWN authentication via the signature instead.
//
// ============================================================================
// SETUP DAME STILL NEEDS TO DO (Shopify side is explicitly not built here):
//   1. In the Shopify admin, create a webhook: Settings -> Notifications ->
//      Webhooks -> "orders/paid", format JSON, pointing at this function's
//      URL: https://<project-ref>.supabase.co/functions/v1/shopify-webhook
//   2. Shopify shows a signing secret for that webhook. Set it with:
//        supabase secrets set SHOPIFY_WEBHOOK_SECRET=whsec_xxx --project-ref <project-ref>
//      Until that secret is set, every request is rejected (see below) —
//      this function never fabricates or skips the check.
//   3. Set which product identifies each tier via two more secrets so this
//      function needs no code change when real Shopify product handles
//      exist:
//        supabase secrets set SHOPIFY_HANDLE_STARTER_KIT=<starter-kit-handle> --project-ref <project-ref>
//        supabase secrets set SHOPIFY_HANDLE_ALL_ACCESS=<all-access-handle> --project-ref <project-ref>
//      A line item matches a tier if its `sku` OR its handle-ized `name`
//      equals the configured handle. All-access is checked first, so a
//      bundle containing both line items grants the higher tier.
// ============================================================================

import { supabaseAdmin } from '../_shared/supabase-admin.ts';

interface ShopifyLineItem {
  sku?: string | null;
  name?: string | null;
  title?: string | null;
}

interface ShopifyOrderPaidPayload {
  email?: string | null;
  contact_email?: string | null;
  id?: number | string;
  order_number?: number | string;
  line_items?: ShopifyLineItem[];
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const webhookSecret = Deno.env.get('SHOPIFY_WEBHOOK_SECRET');
  if (!webhookSecret) {
    // No fabricated secret, no "trust it anyway" fallback — fail closed.
    console.error('[shopify-webhook] SHOPIFY_WEBHOOK_SECRET is not set — rejecting all requests.');
    return new Response('Webhook not configured', { status: 503 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get('x-shopify-hmac-sha256');

  const valid = signature ? await verifyHmac(rawBody, signature, webhookSecret) : false;
  if (!valid) {
    console.error('[shopify-webhook] HMAC verification failed — rejecting.');
    return new Response('Invalid signature', { status: 401 });
  }

  let payload: ShopifyOrderPaidPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const email = (payload.email ?? payload.contact_email ?? '').trim().toLowerCase();
  if (!email) {
    console.error('[shopify-webhook] payload had no buyer email, order:', payload.order_number);
    return new Response('No buyer email on order', { status: 400 });
  }

  const products = matchProducts(payload.line_items ?? []);
  if (products.length === 0) {
    // Order paid but none of its line items match a configured tier — not an
    // error (could be an unrelated Shopify order), just nothing to grant.
    return new Response(JSON.stringify({ ok: true, granted: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabase = supabaseAdmin();
  const orderId = String(payload.id ?? payload.order_number ?? '');

  for (const product of products) {
    const { error } = await supabase.from('entitlements').upsert(
      {
        email,
        product,
        shopify_order_id: orderId,
        granted_at: new Date().toISOString(),
      },
      { onConflict: 'email,product' },
    );
    if (error) {
      console.error('[shopify-webhook] entitlement upsert failed:', error.message);
      return new Response('Failed to grant entitlement', { status: 500 });
    }
  }

  return new Response(JSON.stringify({ ok: true, granted: products }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});

function matchProducts(lineItems: ShopifyLineItem[]): Array<'starter_kit' | 'all_access'> {
  const allAccessHandle = Deno.env.get('SHOPIFY_HANDLE_ALL_ACCESS');
  const starterKitHandle = Deno.env.get('SHOPIFY_HANDLE_STARTER_KIT');

  const identifiers = lineItems.flatMap((item) =>
    [item.sku, item.name, item.title].filter((v): v is string => Boolean(v)).map((v) => v.trim().toLowerCase()),
  );

  const products: Array<'starter_kit' | 'all_access'> = [];

  if (allAccessHandle && identifiers.includes(allAccessHandle.trim().toLowerCase())) {
    products.push('all_access');
  }
  if (starterKitHandle && identifiers.includes(starterKitHandle.trim().toLowerCase())) {
    products.push('starter_kit');
  }

  return products;
}

/** Shopify signs the raw request body with HMAC-SHA256, base64-encoded. */
async function verifyHmac(rawBody: string, signatureHeader: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const computed = base64Encode(new Uint8Array(digest));
  return timingSafeEqual(computed, signatureHeader);
}

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
