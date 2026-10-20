// Google Apps Script web app that appends one survey row to the "Responses" sheet.
//
// Setup: bind this script to the Google Sheet, add a "Responses" tab with the header
// row  survey_id | date_utc | version | q1 | q2 | q3 | q4 | q5, then
// Project Settings > Script properties > add SHARED_SECRET (same value as the
// backend's SHEET_SHARED_SECRET). Deploy as a web app: Execute as "Me", access
// "Anyone". The deployment URL is SHEET_WEBHOOK_URL.
//
// The row shape is checked strictly, so even a leaked secret cannot be used to
// write free text or anything else into the sheet.

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
var VERSION_RE = /^[0-9.]{1,10}$/;

function isValidRow(row) {
  if (!Array.isArray(row) || row.length !== 8) return false;
  if (typeof row[0] !== 'string' || !UUID_RE.test(row[0])) return false;
  if (typeof row[1] !== 'string' || !DATE_RE.test(row[1])) return false;
  if (typeof row[2] !== 'string' || !VERSION_RE.test(row[2])) return false;
  for (var i = 3; i < 8; i++) {
    if (typeof row[i] !== 'number' || row[i] % 1 !== 0 || row[i] < 1 || row[i] > 5) return false;
  }
  return true;
}

function reply(ok) {
  return ContentService.createTextOutput(JSON.stringify({ ok: ok })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var data = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
    if (!secret || data.secret !== secret) return reply(false);
    if (!isValidRow(data.row)) return reply(false);

    lock.waitLock(10000);
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Responses').appendRow(data.row);
    return reply(true);
  } catch (err) {
    return reply(false);
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}
