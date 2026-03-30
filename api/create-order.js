export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { amount, currency, receipt } = req.body;

    // Hardcoded for testing — move to env vars before production
    const KEY_ID = process.env.RAZORPAY_KEY_ID || "rzp_test_SXNd70RUaa6CoG";
    const KEY_SECRET =
      process.env.RAZORPAY_KEY_SECRET || "BefZwjVIIyIAI4o35DLJFxPj";

    const credentials = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString(
      "base64",
    );

    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: Math.round(amount * 100),
        currency: currency || "INR",
        receipt: receipt,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(400).json({
        error: data?.error?.description ?? "Razorpay error",
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
