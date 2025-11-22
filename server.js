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
		console.log("fetchFromClientomer: starting browser launch...")
		console.log(
			"PLAYWRIGHT_BROWSERS_PATH =",
			process.env.PLAYWRIGHT_BROWSERS_PATH || "(not set)"
		)

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

		const targetUrl = `https://cabinet.clientomer.ru/${POINT_ID}`
		console.log("fetchFromClientomer: goto", targetUrl)
		await page.goto(targetUrl, {
			waitUntil: "domcontentloaded",
			timeout: 90000,
		})

		// Попробуем найти поля логина — если есть, логинимся
		try {
			await page.waitForSelector("#login", { timeout: 20000 })
			console.log("fetchFromClientomer: login form found — filling credentials")
			await page.fill("#login", process.env.MY_SITE_LOGIN || "")
			await page.fill("#password", process.env.MY_SITE_PASSWORD || "")
			await page.click('button[type="submit"]')
		} catch (e) {
			// поля логина нет — возможно уже залогинены
			console.log(
				"fetchFromClientomer: #login not found (maybe already logged in)"
			)
		}

		// Немного подождём, затем дождёмся нужного блока
		await page.waitForTimeout(1200)
		try {
			await page.waitForURL(`**/${POINT_ID}`, { timeout: 45000 })
		} catch (e) {
			console.log(
				"fetchFromClientomer: waitForURL didn't match; current URL:",
				page.url()
			)
		}

		// Ждём наличия блока с данными (attach/visible)
		try {
			await page.waitForSelector(".guest-today__item-block", {
				timeout: 30000,
				state: "attached",
			})
		} catch (e) {
			console.log(
				"fetchFromClientomer: .guest-today__item-block not attached (page may differ). Current URL:",
				page.url()
			)
		}

		// Парсим нужные числа: только текстовую часть до <span>, разделяем по "/"
		const parsed = await page.evaluate(() => {
			const block = document.querySelector(".guest-today__item-block")
			if (!block) return { ok: false, reason: "no_block" }

			// Только текст до первого <span> или другого элемента
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

			if (!raw)
				return { ok: false, reason: "no_text_node", innerHTML: block.innerHTML }

			// Убираем всё, кроме цифр и "/"
			const cleaned = raw
				.replace(/[^\d\/]/g, " ")
				.replace(/\s+/, " ")
				.trim()
			const parts = cleaned
				.split("/")
				.map((s) => s.trim())
				.filter(Boolean)

			if (parts.length < 2) {
				return { ok: false, reason: "bad_format", raw, cleaned }
			}

			const inside = parseInt(parts[0], 10) || 0
			const waiting = parseInt(parts[1], 10) || 0

			return { ok: true, raw, inside, waiting }
		})

		if (!parsed || !parsed.ok) {
			// Сделаем скриншот для отладки
			try {
				const screenshotPath = `/tmp/clientomer_failed_${Date.now()}.png`
				await page.screenshot({ path: screenshotPath, fullPage: true })
				console.log(
					"fetchFromClientomer: parsing failed — screenshot saved to",
					screenshotPath
				)
			} catch (sErr) {
				console.log(
					"fetchFromClientomer: failed to make screenshot:",
					sErr.message
				)
			}
			throw new Error(
				"Не удалось распарсить блок .guest-today__item-block (see logs / screenshot)"
			)
		}

		console.log("fetchFromClientomer: parsed raw text:", parsed.raw)
		console.log(
			"fetchFromClientomer: result inside =",
			parsed.inside,
			"waiting =",
			parsed.waiting,
			"total =",
			parsed.total
		)

		// Возвращаем только нужные поля
		return {
			inside: parsed.inside,
			waiting: parsed.waiting,
			total: parsed.total,
		}
	} finally {
		// аккуратно закрываем ресурсы
		if (context) {
			try {
				await context.close()
			} catch (e) {
				console.log("Error closing context:", e.message)
			}
		}
		if (browser) {
			try {
				await browser.close()
			} catch (e) {
				console.log("Error closing browser:", e.message)
			}
		}
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
