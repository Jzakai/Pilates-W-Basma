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
  return config.stripeSecretKey ? createStripePayments(config) : createDemoPayments(config);
}

module.exports = { createPayments, createDemoPayments };
