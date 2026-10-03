// Payment gateway adapters. The booking logic only talks to this interface:
//   createCheckout({ booking, session, successUrl, cancelUrl, expiresAtMs }) -> { id, url }
//   getCheckout(id)    -> { paid, paymentRef }
//   expireCheckout(id) -> void (best effort)
//   refund(paymentRef) -> void
// To use a different gateway, add another adapter with the same shape.

function createStripePayments(config) {
  const Stripe = require('stripe');
  const stripe = new Stripe(config.stripeSecretKey);

  return {
    name: 'stripe',
    stripe,

    async createCheckout({ booking, session, successUrl, cancelUrl, expiresAtMs }) {
      const checkout = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: booking.email,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: booking.currency,
              unit_amount: booking.amount_minor,
              product_data: {
                name: `${session.title} — ${session.starts_at.replace('T', ' ')}`,
                description: config.studio.name,
              },
            },
          },
        ],
        metadata: { booking_id: String(booking.id), session_id: String(session.id) },
        payment_intent_data: { metadata: { booking_id: String(booking.id) } },
        success_url: successUrl,
        cancel_url: cancelUrl,
        expires_at: Math.floor(expiresAtMs / 1000),
      });
      return { id: checkout.id, url: checkout.url };
    },

    async getCheckout(id) {
      const checkout = await stripe.checkout.sessions.retrieve(id);
      return {
        paid: checkout.payment_status === 'paid',
        paymentRef: typeof checkout.payment_intent === 'string' ? checkout.payment_intent : checkout.payment_intent?.id,
      };
    },

    async expireCheckout(id) {
      try {
        await stripe.checkout.sessions.expire(id);
      } catch {
        // Already expired or completed.
      }
    },

    async refund(paymentRef) {
      await stripe.refunds.create({ payment_intent: paymentRef });
    },

    constructWebhookEvent(rawBody, signature) {
      return stripe.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
    },
  };
}

// Moyasar (Saudi Arabia) via its hosted Invoices page: mada, Visa/Mastercard, Apple Pay, STC Pay.
// Webhook payloads are only used as a hint — the invoice is always re-fetched from the
// API before a booking is confirmed, so a forged webhook cannot confirm anything.
function createMoyasarPayments(config) {
  const API = 'https://api.moyasar.com/v1';
  const auth = 'Basic ' + Buffer.from(`${config.moyasarSecretKey}:`).toString('base64');

  async function call(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Moyasar ${method} ${path} failed (${res.status}): ${data.message || JSON.stringify(data)}`);
    return data;
  }

  return {
    name: 'moyasar',

    async createCheckout({ booking, session, successUrl, cancelUrl, expiresAtMs }) {
      const invoice = await call('POST', '/invoices', {
        amount: booking.amount_minor,
        currency: booking.currency.toUpperCase(),
        description: `${config.studio.name}: ${session.title}, ${session.starts_at.replace('T', ' ')}`,
        success_url: successUrl,
        back_url: cancelUrl,
        callback_url: `${config.baseUrl}/api/moyasar/webhook`,
        expired_at: new Date(expiresAtMs).toISOString(),
        metadata: { booking_id: String(booking.id) },
      });
      return { id: invoice.id, url: invoice.url };
    },

    async getCheckout(id) {
      const invoice = await call('GET', `/invoices/${encodeURIComponent(id)}`);
      const payment = (invoice.payments || []).find((p) => p.status === 'paid' || p.status === 'captured');
      return { paid: invoice.status === 'paid' || Boolean(payment), paymentRef: payment?.id };
    },

    async expireCheckout(id) {
      try {
        await call('PUT', `/invoices/${encodeURIComponent(id)}/cancel`);
      } catch {
        // Already paid, expired or cancelled.
      }
    },

    async refund(paymentRef) {
      await call('POST', `/payments/${encodeURIComponent(paymentRef)}/refund`, {});
    },

    // Invoice ids a webhook or invoice callback may refer to. They are re-checked with the API.
    invoiceIdsFromEvent(body) {
      if (config.moyasarWebhookSecret && body.secret_token !== config.moyasarWebhookSecret) return [];
      const d = body.data || body;
      return [d.invoice_id, d.id].filter((id) => typeof id === 'string' && id.length < 100);
    },
  };
}

// Demo mode: no real money moves. The "checkout" is a page on this site with a
// button that simulates a successful payment.
function createDemoPayments(config) {
  return {
    name: 'demo',
    async createCheckout({ booking }) {
      return { id: `demo_${booking.token}`, url: `${config.baseUrl}/demo-pay.html?token=${booking.token}` };
    },
    async getCheckout() {
      return { paid: false };
    },
    async expireCheckout() {},
    async refund() {},
  };
}

function createPayments(config) {
  switch (config.paymentProvider) {
    case 'moyasar':
      if (!config.moyasarSecretKey) throw new Error('MOYASAR_SECRET_KEY is required for Moyasar payments');
      return createMoyasarPayments(config);
    case 'stripe':
      if (!config.stripeSecretKey) throw new Error('STRIPE_SECRET_KEY is required for Stripe payments');
      return createStripePayments(config);
    default:
      return createDemoPayments(config);
  }
}

module.exports = { createPayments, createDemoPayments, createMoyasarPayments };
