const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { items, customerEmail, userId } = JSON.parse(event.body);

    if (!items || !Array.isArray(items) || items.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Cart is empty' }) };
    }

    // Server-side price verification against Firestore
    const lineItems = [];
    for (const item of items) {
      const prodDoc = await db.collection('products').doc(item.id).get();
      if (!prodDoc.exists) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: `Product not found: ${item.id}` }),
        };
      }
      const product = prodDoc.data();

      if (product.soldOut) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: `${product.name} is sold out` }),
        };
      }

      const priceTier = product.prices.find((p) => p.label === item.size);
      if (!priceTier) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: `Invalid size for ${product.name}: ${item.size}` }),
        };
      }

      lineItems.push({
        price_data: {
          currency: 'aud',
          product_data: {
            name: product.name,
            description: `${priceTier.label}${product.korean ? ' (' + product.korean + ')' : ''}`,
          },
          unit_amount: Math.round(priceTier.price * 100),
        },
        quantity: item.qty,
      });
    }

    const siteUrl = process.env.SITE_URL || 'https://nimble-moonbeam-0f42e6.netlify.app';

    const sessionConfig = {
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: lineItems,
      success_url: `${siteUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/index.html#menu`,
      locale: 'en',
      metadata: {
        userId: userId || '',
      },
      shipping_address_collection: {
        allowed_countries: ['AU'],
      },
      allow_promotion_codes: true,
    };

    if (customerEmail) {
      sessionConfig.customer_email = customerEmail;
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    console.error('Stripe session creation error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to create checkout session' }),
    };
  }
};
