const puppeteer = require('puppeteer');
const fs = require('fs');
const { google } = require('googleapis');

// Load and fix credentials
const keys = JSON.parse(process.env.GOOGLE_CREDENTIALS);
keys.private_key = keys.private_key.replace(/\\n/g, '\n');

(async () => {
  // Authenticate with Google Sheets
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

  // Step 1: Read column A to determine row count
  const idRange = `${sheetName}!A2:A`;
  const idRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: idRange });
  const rowCount = (idRes.data.values || []).length;
  console.log(`📄 Found ${rowCount} rows in column A`);

  // Step 2: Read column T (URLs) up to that row count
  const urlRange = `${sheetName}!T2:T${rowCount + 1}`;
  const urlRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: urlRange });
  const urls = urlRes.data.values || [];

  // Launch Puppeteer
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const BATCH_SIZE = 5;
  const updates = [];

  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const batch = urls.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(batch.map(async (row, index) => {
      const rowIndex = i + index + 2; // +2 to match sheet rows
      const url = row[0];
      if (!url || url.trim() === '') {
        console.log(`⏭️ Skipping row ${rowIndex}: empty URL`);
        return null;
      }

      const page = await browser.newPage();
      const start = Date.now();

      try {
        console.log(`🔍 Visiting row ${rowIndex}: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded' });

        const bidSelector = '.item-detail-current-bid span[data-currency]';
        await page.waitForSelector(bidSelector, { timeout: 1500 });

        const bid = await page.$eval(bidSelector, el => el.textContent.trim());
        console.log(`✅ Row ${rowIndex}: 💰 ${bid} (took ${Date.now() - start}ms)`);

        return {
          range: `${sheetName}!V${rowIndex}`, // 💰 Column V for Price
          values: [[bid]],
        };
      } catch (err) {
        console.warn(`⚠️ Row ${rowIndex}: Failed to scrape ${url} — ${err.message} (after ${Date.now() - start}ms)`);
        return null;
      } finally {
        await page.close();
      }
    }));

    updates.push(...results.filter(r => r));
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
    console.log('✅ All bids written to column V.');
  } else {
    console.log('ℹ️ No updates to apply.');
  }
})();