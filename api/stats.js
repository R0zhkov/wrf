const LOGIN = process.env.MY_SITE_LOGIN;
const PASSWORD = process.env.MY_SITE_PASSWORD;
const POINT_ID = process.env.POINT_ID || "125021";

const CACHE = {};
const CACHE_TTL = 2 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const mode = req.query.date || "today";

  const now = Date.now();
  if (CACHE[mode] && now - CACHE[mode].timestamp < CACHE_TTL) {
    return res.status(200).json(CACHE[mode].data);
  }

  try {
    const loginRes = await fetch(
      `https://cabinet.clientomer.ru/${POINT_ID}/jlogin`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: `https://cabinet.clientomer.ru/${POINT_ID}/`
        },
        body: new URLSearchParams({
          login: LOGIN,
          password: PASSWORD,
          point: POINT_ID
        })
      }
    );

    const cookie = loginRes.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Не получена кука сессии");

    const timestamp = Date.now();
    const apiUrl = `https://cabinet.clientomer.ru/${POINT_ID}/reserves.api.guestsreserves?timestamp=${timestamp}`;
    const apiRes = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "X-Requested-With": "XMLHttpRequest",
        Referer: `https://cabinet.clientomer.ru/${POINT_ID}/`
      }
    });

    const data = await apiRes.json();
    if (data.status !== "success") throw new Error("API вернул ошибку");

    const nowMSK = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const targetDate = new Date(nowMSK);
    if (mode === "tomorrow") {
      targetDate.setDate(targetDate.getDate() + 1);
    }
    const targetDateStr = targetDate.toISOString().split("T")[0];

    let totalWaiting = 0;
    let bookings5to7 = 0;
    let bookings8plus = 0;

    for (const reserve of data.data.reserves || []) {
      const date = reserve.estimated_time.split("T")[0];
      const status = reserve.inner_status;
      const guests = reserve.guests_count || 0;

      if (
        date === targetDateStr &&
        ["new", "waiting", "confirmed"].includes(status)
      ) {
        totalWaiting += guests;
        if (guests >= 5 && guests <= 7) bookings5to7++;
        if (guests >= 8) bookings8plus++;
      }
    }

    const result = {
      waiting: totalWaiting,
      bookings5to7,
      bookings8plus
    };

    CACHE[mode] = { data: result, timestamp: now };

    res.status(200).json(result);
  } catch (err) {
    console.error("API error:", err.message);
    res.status(500).json({ error: err.message.substring(0, 200) });
  }
}
