const puppeteer = require('puppeteer');
const { google } = require('googleapis');

// 🔐 Load credentials securely from environment
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

  const urlRange = `${sheetName}!T2:T${rowCount + 1}`;
  const urlRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: urlRange });
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

          // 🖼️ Grab first product image from fotorama container
          const imageUrl = await page.$$eval(
            '.fotorama__stage__shaft img.fotorama__img',
            imgs => (imgs.length ? imgs[0].src : '')
          );

          const imageFormula = imageUrl
            ? `=IMAGE("${imageUrl}", 4, 60, 60)`
            : '';

          console.log(`✅ Row ${rowIndex}: 💰 ${bid}, 🖼️ ${imageUrl ? '[image found]' : '[no image]'}`);

          return [
            { range: `${sheetName}!V${rowIndex}`, values: [[bid]] },       // 💰 Price to column V
            { range: `${sheetName}!AC${rowIndex}`, values: [[imageFormula]] }, // 🖼️ Image to column AC
          ];
        } catch (err) {
          console.warn(
            `⚠️ Row ${rowIndex}: Failed to scrape ${url} — ${err.message} (after ${Date.now() - start}ms)`
          );
          return null;
        } finally {
          await page.close();
        }
      })
    );

    results.flat().forEach(r => {
      if (r) updates.push(r);
    });
  }

  await browser.close();

  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data: updates },
    });
    console.log('✅ Bids and thumbnails written to columns V and AC.');
  } else {
    console.log('ℹ️ No updates to apply.');
  }
})();