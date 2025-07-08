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

  const spreadsheetId = '1CypDOy2PseT9FPz9cyz1JdFhsUmyfnrMGKSmJ2V0fe0'; // Replace with your actual ID
  const sheetName = 'InHunt';

  // Step 1: Read column A to determine how many rows to process
const idRange = `${sheetName}!A2:A`;
const idRes = await sheets.spreadsheets.values.get({
  spreadsheetId,
  range: idRange,
});
const rowCount = (idRes.data.values || []).length;
console.log(`📄 Found ${rowCount} rows in column A`);

// Step 2: Read column M (auction URLs) up to that row count
const readRange = `${sheetName}!M2:M${rowCount + 1}`;
const res = await sheets.spreadsheets.values.get({
  spreadsheetId,
  range: readRange,
});
const urls = res.data.values || [];


  // Launch Puppeteer with GitHub Actions–safe flags
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  const updates = [];

for (let i = 0; i < urls.length; i++) {
  const url = urls[i][0];
  if (!url || !url.startsWith('http')) continue;

  console.log(`🔍 Visiting row ${i + 2}: ${url}`);
  const start = Date.now();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const bidSelector = '.item-detail-current-bid span[data-currency]';
    await page.waitForSelector(bidSelector, { timeout: 1500 }); // faster timeout

    const bid = await page.$eval(bidSelector, el => el.textContent.trim());

    console.log(`✅ Row ${i + 2}: 💰 ${bid} (took ${Date.now() - start}ms)`);

    updates.push({
      range: `${sheetName}!Q${i + 2}`,
      values: [[bid]],
    });

  } catch (err) {
    console.warn(`⚠️ Row ${i + 2}: Failed to scrape ${url} — ${err.message} (after ${Date.now() - start}ms)`);
  }
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
    console.log('✅ All bids written to column Q.');
  } else {
    console.log('ℹ️ No updates to apply.');
  }
})();

// trigger redeploy