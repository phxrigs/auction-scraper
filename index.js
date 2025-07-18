/**
 * Auction Scraper - v2025.07.18-scroll-inspect-image-fallback
 * ✔ Adds scroll detection for lazy-loaded images
 * ✔ Logs HTML around missing selectors
 * ✔ Captures screenshot for offline debugging
 * ✔ Uses headless: "new" for improved rendering
 */

const puppeteer = require('puppeteer');
const { google } = require('googleapis');
require('dotenv').config();

const keys = JSON.parse(process.env.GOOGLE_CREDENTIALS);
keys.private_key = keys.private_key.replace(/\\n/g, '\n');

(async () => {
  const auth = new google.auth.JWT(
    keys.client_email,
    null,
    keys.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  await auth.authorize();
  const sheets = google.sheets({ version: 'v4', auth });

  const spreadsheetId = '1CypDOy2PseT9FPz9cyz1JdFhsUmyfnrMGKSmJ2V0fe0';
  const sheetName = 'InHunt';

  const rowCount = (
    await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A2:A`,
    })
  ).data.values?.length || 0;
  console.log(`📘 Found ${rowCount} rows`);

  const urlRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!T2:T${rowCount + 1}`,
  });
  const urls = urlRes.data.values || [];

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const BATCH_SIZE = 5;
  const updates = [];

  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const batch = urls.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async (row, index) => {
        const rowIndex = i + index + 2;
        const url = row[0];
        if (!url || url.trim() === '') {
          console.log(`⏭️ Row ${rowIndex}: empty URL`);
          return null;
        }

        const page = await browser.newPage();
        const start = Date.now();

        try {
          console.log(`🌐 Row ${rowIndex}: visiting ${url}`);
          await page.goto(url, { waitUntil: 'domcontentloaded' });

          // 🔄 Scroll down to trigger lazy loading
          await page.evaluate(() => {
            return new Promise(resolve => {
              let totalHeight = 0;
              const distance = 300;
              const timer = setInterval(() => {
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= document.body.scrollHeight) {
                  clearInterval(timer);
                  resolve();
                }
              }, 200);
            });
          });

          const bidSelector = '.item-detail-current-bid span[data-currency]';
          await page.waitForSelector(bidSelector, { timeout: 3000 });
          const bid = await page.$eval(bidSelector, el => el.textContent.trim());

          // 👁️ Wait for image selectors (optional but helpful)
          await page.waitForSelector('.fotorama__img, .product-image img', { timeout: 3000 }).catch(() => {
            console.log(`⏳ Row ${rowIndex}: Image selector not detected after scroll`);
          });

          // 🖼️ Primary image selector
          let imageUrls = await page.$$eval(
            '.fotorama__stage__shaft img.fotorama__img',
            imgs => imgs.map(img => img.src)
          );

          // 🖼️ Fallback selector
          if (imageUrls.length === 0) {
            console.log(`🔁 Row ${rowIndex}: trying fallback selector`);
            imageUrls = await page.$$eval(
              '.product-image img',
              imgs => imgs.map(img => img.src)
            );
          }

          // 🩺 If still no image, log nearby HTML
          if (imageUrls.length === 0) {
            const rawHTML = await page.evaluate(() => {
              const gallery = document.querySelector('.product-image') || document.querySelector('.fotorama');
              return gallery ? gallery.innerHTML : '📭 No relevant gallery HTML found';
            });
            console.log(`📜 Row ${rowIndex}: Gallery HTML fallback\n${rawHTML.slice(0, 500)}...`);
          }

          // 📸 Screenshot for visual debugging
          await page.screenshot({ path: `row-${rowIndex}-screenshot.png` });

          const imageFormula = imageUrls[0]
            ? `=IMAGE("${imageUrls[0]}", 4, 60, 60)`
            : '';

          const duration = Date.now() - start;

          console.log(`🔎 Row ${rowIndex} Summary:`);
          console.log(`   - URL: ${url}`);
          console.log(`   - Bid found: ${bid || '❌ None'}`);
          console.log(`   - Images found: ${imageUrls.length}`);
          if (imageUrls.length) {
            console.log(`   - First image URL: ${imageUrls[0]}`);
            console.log(`   - Thumbnail formula: ${imageFormula}`);
          } else {
            console.log('   - No image extracted (all methods failed)');
          }
          console.log(`   - Duration: ${duration}ms\n`);

          return [
            { range: `${sheetName}!V${rowIndex}`, values: [[bid]] },
            { range: `${sheetName}!AC${rowIndex}`, values: [[imageFormula]] },
          ];
        } catch (err) {
          console.warn(`⚠️ Row ${rowIndex}: scrape error — ${err.message}`);
          return null;
        } finally {
          await page.close();
        }
      })
    );

    results.flat().forEach(update => {
      if (update) updates.push(update);
    });
  }

  await browser.close();

  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: updates,
      },
    });
    console.log(`📊 ${updates.length} updates written to sheet`);
  } else {
    console.log('ℹ️ No updates to apply');
  }
})();
