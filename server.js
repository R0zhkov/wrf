const express = require("express")
const { chromium } = require("playwright")
const path = require("path")

const app = express()
const PORT = process.env.PORT || 3000

// CORS для API
app.use((req, res, next) => {
	if (req.path.startsWith("/api/")) {
		res.setHeader("Access-Control-Allow-Origin", "*")
	}
	next()
})

// 🌐 Главная страница — красивый HTML
app.get("/", (req, res) => {
	const html = `
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
      .loading { color: #6b7280; }
    </style>
  </head>
  <body>
    <div class="stats" id="output">Загрузка…</div>
    <script>
      async function fetchStats() {
        try {
          const res = await fetch('/api/stats');
          const data = await res.json();
          if (data.error) {
            document.getElementById('output').innerHTML = '❌ Ошибка: ' + (data.error || 'неизвестно');
          } else {
            document.getElementById('output').innerHTML = 
              \`В зале: <strong>\${data.inside}</strong><br>Ожидают: <strong>\${data.waiting}</strong>\`;
          }
        } catch (err) {
          document.getElementById('output').textContent = 'Не удалось загрузить';
        }
      }
      fetchStats();
      setInterval(fetchStats, 60000); // обновлять каждую минуту
    </script>
  </body>
  </html>
  `
	res.send(html)
})

// 📡 API-эндпоинт
app.get("/api/stats", async (req, res) => {
	const { MY_SITE_LOGIN, MY_SITE_PASSWORD, POINT_ID = 125021 } = process.env

	if (!MY_SITE_LOGIN || !MY_SITE_PASSWORD) {
		return res.status(500).json({ error: "Missing login or password in env" })
	}

	let browser
	try {
		browser = await chromium.launch({
			headless: true,
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
			],
		})

		const page = await browser.newPage()
		await page.goto(`https://cabinet.clientomer.ru/${POINT_ID}`)

		await page.waitForSelector("#login", { timeout: 20000 })
		await page.fill("#login", MY_SITE_LOGIN)
		await page.fill("#password", MY_SITE_PASSWORD)
		await page.click('button[type="submit"]')

		await page.waitForSelector(".guest-today__item-block", { timeout: 30000 })

		const firstText = await page.evaluate(() => {
			const el = document.querySelector(".guest-today__item-block")
			return el?.firstChild?.textContent?.trim() || ""
		})

		const match = firstText.match(/(\d+)\s*\/\s*(\d+)/)
		const inside = match ? parseInt(match[1]) : null
		const waiting = match ? parseInt(match[2]) : null

		res.json({ inside, waiting })
	} catch (err) {
		console.error("Error:", err.message)
		res.status(500).json({ error: err.message })
	} finally {
		if (browser) await browser.close()
	}
})

app.listen(PORT, () => {
	console.log(`✅ Server running on port ${PORT}`)
})
