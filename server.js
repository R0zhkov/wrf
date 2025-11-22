// server.js — CommonJS (no top-level await)
const express = require("express")
const { chromium } = require("playwright")

const app = express()
const PORT = parseInt(process.env.PORT || "3000")
const POINT_ID = process.env.POINT_ID || "125021"

// Кеширование данных на 2 минуты
let cachedData = null
let lastFetchTime = 0
const CACHE_TTL = 2 * 60 * 1000 // 120 000 мс = 2 минуты

// CORS для API
app.use((req, res, next) => {
	if (req.path.startsWith("/api/")) {
		res.setHeader("Access-Control-Allow-Origin", "*")
	}
	next()
})
// Главная страница — HTML с автообновлением
app.get("/", (req, res) => {
	res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Статистика посетителей</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, sans-serif;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          margin: 0;
          background: #f9fafb;
          color: #1f2937;
        }
        .stats {
          font-size: 2.5rem;
          text-align: center;
          background: white;
          padding: 2rem;
          border-radius: 16px;
          box-shadow: 0 4px 20px rgba(0,0,0,0.08);
        }
        .error { color: #ef4444; }
      </style>
    </head>
    <body>
      <div class="stats" id="output">Загрузка…</div>
      <script>
        async function fetchStats() {
          try {
            const res = await fetch('/api/stats');
            const data = await res.json();
            const el = document.getElementById('output');
            if (data.error) {
              el.innerHTML = '<div class="error">❌ Ошибка:<br>' + (data.error || 'неизвестно') + '</div>';
            } else {
              el.innerHTML = 
                \`В зале: <strong>\${data.inside}</strong><br>Ожидают: <strong>\${data.waiting}</strong>\`;
            }
          } catch (err) {
            document.getElementById('output').innerHTML = '<div class="error">Не удалось загрузить</div>';
          }
        }
        fetchStats();
        setInterval(fetchStats, 60000); // обновление раз в минуту
      </script>
    </body>
    </html>
  `)
})
// Функция: получить данные с clientomer.ru
async function fetchFromClientomer() {
	let browser = null
	let context = null
	try {
		browser = await chromium.launch({
			headless: true,
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
				"--disable-gpu",
				"--disable-web-security",
				"--disable-features=VizDisplayCompositor",
			],
		})

		context = await browser.newContext({
			userAgent:
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		})

		const page = await context.newPage()

		await page.goto(`https://cabinet.clientomer.ru/${POINT_ID}`, {
			waitUntil: "domcontentloaded",
			timeout: 60000,
		})

		await page.waitForSelector("#login", { timeout: 30000 })
		await page.fill("#login", process.env.MY_SITE_LOGIN)
		await page.fill("#password", process.env.MY_SITE_PASSWORD)
		await page.click('button[type="submit"]')

		await page.waitForURL(`**/${POINT_ID}`, { timeout: 45000 })
		await page.waitForSelector(".guest-today__item-block", { timeout: 60000 })

		const firstText = await page.evaluate(() => {
			const el = document.querySelector(".guest-today__item-block")
			return el?.firstChild?.textContent?.trim() || ""
		})

		const match = firstText.match(/(\d+)\s*\/\s*(\d+)/)
		if (!match)
			throw new Error('Не найдены числа в блоке "guest-today__item-block"')

		return {
			inside: parseInt(match[1]),
			waiting: parseInt(match[2]),
		}
	} finally {
		if (context) await context.close()
		if (browser) await browser.close()
	}
}

// API-эндпоинт с кешированием
app.get("/api/stats", async (req, res) => {
	const { MY_SITE_LOGIN, MY_SITE_PASSWORD } = process.env
	if (!MY_SITE_LOGIN || !MY_SITE_PASSWORD) {
		return res
			.status(500)
			.json({ error: "Missing MY_SITE_LOGIN or MY_SITE_PASSWORD in env" })
	}

	const now = Date.now()
	if (!cachedData || now - lastFetchTime > CACHE_TTL) {
		console.log("🔄 Получаем свежие данные с clientomer.ru...")
		try {
			cachedData = await fetchFromClientomer()
			lastFetchTime = now
			console.log("✅ Успешно получены данные:", cachedData)
		} catch (err) {
			console.error("❌ Ошибка при парсинге:", err.message)
			return res.status(500).json({ error: err.message.substring(0, 200) })
		}
	} else {
		console.log("📦 Используем кешированные данные")
	}

	res.json(cachedData)
})

// Запуск сервера
app.listen(PORT, "0.0.0.0", () => {
	console.log(`✅ Сервер запущен на порту ${PORT}`)
})
