/**
 * Auction Scraper - v2025.07.18-image-fallback-logging
 * ✔️ Extracts bid price from column T URLs
 * ✔️ Captures first image from .fotorama__img or .product-image img
 * ✔️ Writes to column V (price) and column AC (thumbnail) in Google Sheets
 * ✔️ Includes verbose row-by-row logging for diagnostics
 */

const puppeteer = require('puppeteer');
const { google } = require('googleapis');
require('dotenv').config(); // 🔄 Loads GOOGLE_CREDENTIALS from .env

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
    headless: true,
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

          const bidSelector = '.item-detail-current-bid span[data-currency]';
          await page.waitForSelector(bidSelector, { timeout: 2000 });
          const bid = await page.$eval(bidSelector, el => el.textContent.trim());

          let imageUrls = await page.$$eval(
            '.fotorama__stage__shaft img.fotorama__img',
            imgs => imgs.map(img => img.src)
          );

          if (imageUrls.length === 0) {
            console.log(`🔁 Row ${rowIndex}: trying fallback selector`);
            imageUrls = await page.$$eval(
              '.product-image img',
              imgs => imgs.map(img => img.src)
            );
          }

          const imageFormula = imageUrls[0]
            ? `=IMAGE("${imageUrls[0]}", 4, 60, 60)`
            : '';

          const duration = Date.now() - start;

          // 🪵 Row-by-row diagnostics
          console.log(`🔎 Row ${rowIndex} Summary:`);
          console.log(`   - URL: ${url}`);
          console.log(`   - Bid found: ${bid || '❌ None'}`);
          console.log(`   - Images found: ${imageUrls.length}`);
          if (imageUrls.length) {
            console.log(`   - First image URL: ${imageUrls[0]}`);
            console.log(`   - Thumbnail formula: ${imageFormula}`);
          } else {
            console.log('   - No image extracted (both selectors failed)');
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
