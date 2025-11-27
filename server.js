// server.js — CommonJS
const express = require("express")
const { chromium } = require("playwright")

const app = express()
const PORT = parseInt(process.env.PORT || "3000")
const POINT_ID = process.env.POINT_ID || "125021"
const CACHE_TTL = 5 * 60 * 1000 // 5 минут
let cachedData = null
let lastFetchTime = 0
let isFetching = false

// CORS
app.use((req, res, next) => {
	if (req.path.startsWith("/api/")) {
		res.setHeader("Access-Control-Allow-Origin", "*")
	}
	next()
})

// Главная страница — только "ожидают", на весь экран
app.get("/", (req, res) => {
	res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Ожидают</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          background: #000;
          color: #fff;
          font-family: -apple-system, BlinkMacSystemFont, sans-serif;
          height: 100vh;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          align-items: center;
          padding: 20px;
        }
        .number {
          font-size: min(60vw, 60vh);
          font-weight: 800;
          line-height: 1;
          text-align: center;
          text-shadow: 0 0 20px rgba(255,255,255,0.4);
        }
        .label {
          font-size: min(8vw, 8vh);
          opacity: 0.7;
          margin-top: 20px;
        }
        .footer {
          font-size: min(4vw, 18px);
          opacity: 0.6;
          text-align: center;
          margin-bottom: 20px;
          max-width: 800px;
        }
      </style>
    </head>
    <body>
      <div style="flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center;">
        <div class="number" id="waiting">--</div>
        <div class="label">ожидают</div>
      </div>

      <div class="footer">
        Кухня работает как часы, к кухне претензий не имеем
      </div>

      <script>
        async function fetchStats() {
          try {
            const res = await fetch('/api/stats');
            const data = await res.json();
            document.getElementById('waiting').textContent = data.waiting || 0;
          } catch (err) {
            document.getElementById('waiting').textContent = '—';
          }
        }
        fetchStats();
        setInterval(fetchStats, 60000);
      </script>
    </body>
    </html>
  `)
})

// Парсинг (всё как раньше)
async function fetchFromClientomer() {
	let browser = null
	let context = null
	let page = null
	try {
		browser = await chromium.launch({
			headless: true,
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
				"--disable-gpu",
				"--single-process",
				"--no-zygote",
				"--disable-background-tasks",
				"--disable-backgrounding-occluded-windows",
				"--disable-renderer-backgrounding",
				"--memory-pressure-off",
				"--disable-features=VizDisplayCompositor",
				"--disable-blink-features=AutomationControlled",
			],
		})

		context = await browser.newContext({
			viewport: { width: 1920, height: 1080 },
			userAgent:
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			locale: "ru-RU",
			timezoneId: "Europe/Moscow",
			permissions: ["geolocation"],
			extraHTTPHeaders: {
				"Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
			},
		})

		await context.addInitScript(() => {
			Object.defineProperty(navigator, "webdriver", { get: () => undefined })
			window.chrome = { runtime: {} }
		})

		page = await context.newPage()
		await page.goto(`https://cabinet.clientomer.ru/${POINT_ID}`, {
			waitUntil: "domcontentloaded",
			timeout: 60000,
		})

		try {
			await page.waitForSelector("#login", { timeout: 10000 })
			await page.fill("#login", process.env.MY_SITE_LOGIN)
			await page.fill("#password", process.env.MY_SITE_PASSWORD)
			await page.click('button[type="submit"]')
		} catch (e) {
			console.log("Форма входа не найдена — возможно, уже залогинены")
		}

		await page.waitForFunction(
			() => {
				const block = document.querySelector(".guest-today__item-block")
				if (!block) return false
				let raw = ""
				for (const node of block.childNodes) {
					if (node.nodeType === Node.TEXT_NODE) {
						const t = (node.textContent || "").trim()
						if (t) {
							raw = t
							break
						}
					}
				}
				const match = raw.match(/(\d+)\s*\/\s*(\d+)/)
				return (
					match && (parseInt(match[1], 10) >= 0 || parseInt(match[2], 10) > 0)
				)
			},
			{ timeout: 60000, polling: 2000 }
		)

		const result = await page.evaluate(() => {
			const block = document.querySelector(".guest-today__item-block")
			if (!block) return { ok: false }

			let mainText = ""
			for (const node of block.childNodes) {
				if (node.nodeType === Node.TEXT_NODE) {
					const t = (node.textContent || "").trim()
					if (t) {
						mainText = t
						break
					}
				}
			}
			const mainMatch = mainText.match(/(\d+)\s*\/\s*(\d+)/)
			const inside = mainMatch ? parseInt(mainMatch[1], 10) : 0
			const waiting = mainMatch ? parseInt(mainMatch[2], 10) : 0

			const span = block.querySelector("span.d-block")
			const totalText = span ? span.textContent.trim() : ""
			const total = totalText
				? parseInt(totalText.replace(/[^\d]/g, ""), 10)
				: inside + waiting

			return { ok: true, inside, waiting, total }
		})

		if (!result.ok) throw new Error("Не удалось распарсить блок")

		return {
			inside: result.inside,
			waiting: result.waiting,
			total: result.total,
		}
	} finally {
		if (page) await page.close().catch(() => {})
		if (context) await context.close().catch(() => {})
		if (browser) await browser.close().catch(() => {})
	}
}

// API — остаётся без изменений (возвращает все поля)
app.get("/api/stats", async (req, res) => {
	const { MY_SITE_LOGIN, MY_SITE_PASSWORD } = process.env
	if (!MY_SITE_LOGIN || !MY_SITE_PASSWORD) {
		return res.status(500).json({ error: "Missing credentials" })
	}

	const now = Date.now()
	if (cachedData && now - lastFetchTime <= CACHE_TTL) {
		return res.json(cachedData)
	}

	if (isFetching) {
		if (cachedData) {
			console.log("⏳ Используем кеш — обновление уже в процессе")
			return res.json(cachedData)
		}
		return res.status(503).json({ error: "Сервис занят" })
	}

	isFetching = true
	try {
		console.log("🔄 Обновляем данные...")
		cachedData = await fetchFromClientomer()
		lastFetchTime = now
		console.log("✅ Данные:", cachedData)
		res.json(cachedData)
	} catch (err) {
		console.error("❌ Ошибка:", err.message)
		res.status(500).json({ error: err.message.substring(0, 200) })
	} finally {
		isFetching = false
	}
})

app.listen(PORT, "0.0.0.0", () => {
	console.log(`✅ Сервер запущен на порту ${PORT}`)
})
