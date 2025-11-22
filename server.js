// server.js — CommonJS (no top-level await)
const express = require("express")
const { chromium } = require("playwright")

const app = express()
const PORT = parseInt(process.env.PORT || "3000")
const POINT_ID = process.env.POINT_ID || "125021"

// Кеширование данных на 2 минуты
let cachedData = null
let lastFetchTime = 0
const CACHE_TTL = 5 * 60 * 1000 // 2 минуты

// CORS для API
app.use((req, res, next) => {
	if (req.path.startsWith("/api/")) {
		res.setHeader("Access-Control-Allow-Origin", "*")
	}
	next()
})

// Главная страница
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
        setInterval(fetchStats, 60000);
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
		console.log("🔧 Запускаем браузер в режиме эмуляции человека...")

		browser = await chromium.launch({
			headless: true,
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
				"--disable-gpu",
				"--disable-web-security",
				"--disable-features=VizDisplayCompositor",
				"--disable-features=IsolateOrigins,site-per-process",
				"--disable-blink-features=AutomationControlled",
			],
		})

		// === Эмуляция "человеческого" браузера ===
		context = await browser.newContext({
			viewport: { width: 1920, height: 1080 },
			userAgent:
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			locale: "ru-RU",
			timezoneId: "Europe/Moscow",
			permissions: ["geolocation", "notifications"],
			extraHTTPHeaders: {
				"Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
				Referer: "https://cabinet.clientomer.ru/",
			},
		})

		// Обход детекторов headless
		await context.addInitScript(() => {
			// Скрыть признаки автоматизации
			Object.defineProperty(navigator, "webdriver", { get: () => undefined })
			window.chrome = { runtime: {} }
			Object.defineProperty(navigator, "plugins", {
				get: () => [1, 2, 3, 4, 5],
			})
			Object.defineProperty(navigator, "languages", {
				get: () => ["ru-RU", "ru", "en"],
			})
			Object.defineProperty(Notification, "permission", {
				get: () => "default",
			})
		})

		const page = await context.newPage()
		const targetUrl = `https://cabinet.clientomer.ru/${POINT_ID}`
		console.log("🌐 Переходим на:", targetUrl)
		await page.goto(targetUrl, {
			waitUntil: "domcontentloaded",
			timeout: 60000,
		})

		// Попытка входа
		try {
			await page.waitForSelector("#login", { timeout: 10000 })
			console.log("🔓 Найдена форма входа — логинимся...")
			await page.fill("#login", process.env.MY_SITE_LOGIN || "")
			await page.fill("#password", process.env.MY_SITE_PASSWORD || "")
			await page.click('button[type="submit"]')
		} catch (e) {
			console.log("ℹ️ Форма входа не найдена — возможно, уже залогинены")
		}

		// === ЖДЁМ ДАННЫЕ С ДИАГНОСТИКОЙ ===
		console.log("⏳ Ожидание появления статистики (до 60 сек)...")
		try {
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
					if (!match) return false
					const inside = parseInt(match[1], 10)
					const waiting = parseInt(match[2], 10)
					return inside >= 0 || waiting > 0 // разрешаем inside=0, если waiting>0
				},
				{ timeout: 60000, polling: 2000 }
			)
		} catch (e) {
			// === ДИАГНОСТИКА ПРИ ТАЙМАУТЕ ===
			console.log("🚨 Таймаут! Собираем диагностические данные...")
			console.log("URL:", page.url())
			const title = await page.title()
			console.log("Title:", title)
			const html = await page.content()
			console.log("HTML (первые 800 символов):", html.substring(0, 800))

			// Скриншот в base64
			const screenshot = await page.screenshot({ fullPage: true })
			console.log("📸 base64 screenshot:", screenshot.toString("base64"))

			throw new Error("Данные не загрузились за 60 сек — см. логи выше")
		}

		// Парсим
		const parsed = await page.evaluate(() => {
			const block = document.querySelector(".guest-today__item-block")
			if (!block) return { ok: false }
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
			if (!match) return { ok: false, raw }
			return {
				ok: true,
				raw,
				inside: parseInt(match[1], 10),
				waiting: parseInt(match[2], 10),
			}
		})

		if (!parsed.ok) throw new Error(`Парсинг не удался: raw="${parsed.raw}"`)

		console.log("✅ Получены данные:", parsed.raw)
		return { inside: parsed.inside, waiting: parsed.waiting }
	} finally {
		if (context) await context.close().catch(() => {})
		if (browser) await browser.close().catch(() => {})
	}
}

// API с кешированием
app.get("/api/stats", async (req, res) => {
	const { MY_SITE_LOGIN, MY_SITE_PASSWORD } = process.env
	if (!MY_SITE_LOGIN || !MY_SITE_PASSWORD) {
		return res.status(500).json({
			error: "Missing MY_SITE_LOGIN or MY_SITE_PASSWORD in env",
		})
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
