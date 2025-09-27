// api/guests.js
// Серверлес-функция Vercel: логин -> booking/filter -> вернуть { value: <guests> }

const BASE = "https://wrf.hostes.me"
const LOGIN_URL = `${BASE}/api/auth/login`
const FILTER_URL = `${BASE}/api/internal/v2/booking/filter`

function json(res, status, obj) {
	res.status(status)
	res.setHeader("Content-Type", "application/json; charset=utf-8")
	// CORS — на всякий случай, чтобы страница могла дергать из любого домена
	res.setHeader("Access-Control-Allow-Origin", "*")
	res.end(JSON.stringify(obj))
}

module.exports = async (req, res) => {
	try {
		const {
			WRF_LOGIN,
			WRF_PASSWORD,
			WRF_TENANT = "resto-wrf",
			WRF_LOCALE = "ru_RU",
			WRF_RESTAURANT_ID = "3",
			WRF_PLACES = "7,133,348,349", // через запятую
			WRF_STATUSES = "WAIT_LIST,NEW,CONFIRMED",
		} = process.env

		if (!WRF_LOGIN || !WRF_PASSWORD) {
			return json(res, 500, { error: "Missing env: WRF_LOGIN/WRF_PASSWORD" })
		}

		// дата: из ?date=YYYY-MM-DD, иначе сегодня (по локальному UTC)
		const url = new URL(req.url, "http://dummy")
		const dateParam = url.searchParams.get("date")
		const date =
			dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
				? dateParam
				: new Date().toISOString().slice(0, 10)

		// 1) логин -> access_token
		const loginPayload = {
			locale: WRF_LOCALE,
			tenant: WRF_TENANT,
			login: WRF_LOGIN,
			password: WRF_PASSWORD,
		}

		const loginResp = await fetch(LOGIN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "*/*",
				Origin: BASE,
				Referer: `${BASE}/login?redirectTo=/`,
			},
			body: JSON.stringify(loginPayload),
		})

		if (!loginResp.ok) {
			const t = await loginResp.text()
			return json(res, 502, {
				error: "login_failed",
				status: loginResp.status,
				body: t.slice(0, 500),
			})
		}

		const loginJson = await loginResp.json()
		const token = loginJson?.data?.access_token
		if (!token) {
			return json(res, 502, {
				error: "no_access_token_in_response",
				raw: loginJson,
			})
		}

		// 2) booking/filter
		const places = WRF_PLACES.split(",")
			.map((s) => Number(s.trim()))
			.filter(Boolean)
		const statuses = WRF_STATUSES.split(",")
			.map((s) => s.trim())
			.filter(Boolean)

		const body = {
			restaurant_id: Number(WRF_RESTAURANT_ID),
			from: date,
			to: date,
			search_keyword: "",
			sort: [
				{ param: "date", direction: "ASC" },
				{ param: "time", direction: "ASC" },
			],
			statuses,
			management_tables: true,
			places,
		}

		const filterResp = await fetch(FILTER_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "*/*",
				Origin: BASE,
				Referer: `${BASE}/dashboard`,
				authorization: token, // ВАЖНО: без "Bearer "
			},
			body: JSON.stringify(body),
		})

		if (!filterResp.ok) {
			const t = await filterResp.text()
			return json(res, 502, {
				error: "filter_failed",
				status: filterResp.status,
				body: t.slice(0, 1000),
			})
		}

		const data = await filterResp.json()
		let value =
			data?.data?.statistics?.all?.guests ??
			(Array.isArray(data?.data?.slots)
				? data.data.slots.reduce(
						(sum, s) => sum + (Number(s?.visitors) || 0),
						0
				  )
				: null)

		if (typeof value !== "number") {
			return json(res, 500, {
				error: "cannot_extract_guests",
				sample: data?.data?.statistics || data?.data,
			})
		}

		// можно немного кэшировать на стороне CDN
		res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30")

		return json(res, 200, {
			value,
			date,
			updated_at: Math.floor(Date.now() / 1000),
		})
	} catch (e) {
		return json(res, 500, { error: "exception", message: String(e) })
	}
}
