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
    const { sessionId } = JSON.parse(event.body);
    if (!sessionId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing session_id' }) };
    }

    // Check if order was already processed (idempotency)
    const existingOrder = await db.collection('orders').doc(sessionId).get();
    if (existingOrder.exists) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, order: existingOrder.data() }),
      };
    }

    // Retrieve session from Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items'],
    });

    if (session.payment_status !== 'paid') {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Payment not completed' }),
      };
    }

    // Build order data
    const orderData = {
      stripeSessionId: sessionId,
      stripePaymentIntent: session.payment_intent,
      customerEmail: session.customer_details?.email || '',
      customerName: session.customer_details?.name || '',
      shippingAddress: session.shipping_details?.address || null,
      items: session.line_items.data.map((li) => ({
        name: li.description,
        quantity: li.quantity,
        amountTotal: li.amount_total / 100,
        currency: li.currency,
      })),
      totalAmount: session.amount_total / 100,
      currency: session.currency,
      paymentStatus: session.payment_status,
      status: 'confirmed',
      userId: session.metadata?.userId || null,
      createdAt: admin.firestore.Timestamp.now(),
    };

    // Save order to Firestore
    await db.collection('orders').doc(sessionId).set(orderData);

    // Award loyalty points (1 point per AUD spent)
    if (session.metadata?.userId) {
      const pointsEarned = Math.floor(session.amount_total / 100);
      if (pointsEarned > 0) {
        const userRef = db.collection('users').doc(session.metadata.userId);
        await userRef.update({
          points: admin.firestore.FieldValue.increment(pointsEarned),
          totalEarned: admin.firestore.FieldValue.increment(pointsEarned),
          pointsHistory: admin.firestore.FieldValue.arrayUnion({
            type: 'earn',
            amount: pointsEarned,
            description: `Order #${sessionId.slice(-8)}`,
            date: admin.firestore.Timestamp.now(),
          }),
        });
        orderData.pointsEarned = pointsEarned;
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, order: orderData }),
    };
  } catch (err) {
    console.error('Verify session error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to verify session' }),
    };
  }
};
