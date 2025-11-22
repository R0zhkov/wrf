const express = require("express")
const { chromium } = require("playwright")

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())

// CORS (если frontend на другом домене)
app.use((req, res, next) => {
	res.setHeader("Access-Control-Allow-Origin", "*")
	res.setHeader("Access-Control-Allow-Methods", "GET, POST")
	res.setHeader("Access-Control-Allow-Headers", "Content-Type")
	next()
})

app.get("/api/stats", async (req, res) => {
	const { MY_SITE_LOGIN, MY_SITE_PASSWORD, POINT_ID } = process.env

	if (!MY_SITE_LOGIN || !MY_SITE_PASSWORD) {
		return res.status(500).json({ error: "Missing credentials in env" })
	}

	let browser
	try {
		browser = await chromium.launch({
			headless: true,
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
				"--disable-gpu",
				"--disable-software-rasterizer",
			],
		})

		const page = await browser.newPage()
		const url = `https://cabinet.clientomer.ru/${POINT_ID}`
		await page.goto(url)

		// Ждём поля логина
		await page.waitForSelector("#login", { timeout: 20000 })
		await page.fill("#login", MY_SITE_LOGIN)
		await page.fill("#password", MY_SITE_PASSWORD)
		await page.click('button[type="submit"]')

		// Ждём блок с данными
		await page.waitForSelector(".guest-today__item-block", { timeout: 30000 })

		// Получаем текст до <span> и содержимое span.d-block
		const firstText = await page.evaluate(() => {
			const el = document.querySelector(".guest-today__item-block")
			return el?.firstChild?.textContent?.trim() || ""
		})

		const spanText =
			(await page.$eval("span.d-block", (el) => el.textContent.trim())) || ""

		console.log("raw first_text:", firstText)
		console.log("raw span_text:", spanText)

		// Парсим числа
		const match = firstText.match(/(\d+)\s*\/\s*(\d+)/)
		const inside = match ? parseInt(match[1]) : null
		const waiting = match ? parseInt(match[2]) : null

		res.json({ inside, waiting })
	} catch (error) {
		console.error("Error:", error.message)
		res.status(500).json({ error: error.message })
	} finally {
		if (browser) await browser.close()
	}
})

app.listen(PORT, () => {
	console.log(`✅ Backend запущен на http://localhost:${PORT}`)
})
