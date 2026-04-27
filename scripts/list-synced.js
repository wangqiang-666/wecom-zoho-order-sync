require("dotenv").config();
const { db } = require("../src/utils/db");
const rows = db.prepare("SELECT row_id, zoho_id, status FROM sync_state WHERE status='ok' LIMIT 5").all();
console.log("DB 已成功的行：");
for (const r of rows) {
  const recordId = r.row_id.split("::").pop();
  console.log(`  record_id=${recordId} zoho=${r.zoho_id}`);
}
