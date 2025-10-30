// lib/airtable.js
import fetch from "node-fetch";

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,

  // --- TABLES
  AIRTABLE_TABLE_ORDERS     = "Unfulfilled Orders Log",
  AIRTABLE_TABLE_INVENTORY  = "Inventory",
  AIRTABLE_TABLE_SALES      = "Sales",
  AIRTABLE_TABLE_OFFER_MSGS = "Offer Messages",

  // --- INVENTORY FIELDS
  FIELD_INV_QTY               = "Quantity",
  FIELD_INV_PRODUCT_NAME      = "Master Product Name",
  FIELD_INV_SIZE              = "Size EU",
  FIELD_INV_BRAND             = "Brand",
  FIELD_INV_VAT_TYPE          = "VAT Type (Margin / VAT0 / VAT21)",
  FIELD_INV_LINK_SKU_MASTER   = "SKU Master",     // linked to SKU Master
  FIELD_INV_LINKED_SELLER     = "Linked Seller",  // linked to Sellers Database

  // --- SALES FIELDS (your base)
  FIELD_SALE_PRODUCT_NAME     = "Product Name",
  FIELD_SALE_SKU_LINK         = "SKU",                 // linked -> expects ["rec..."]
  FIELD_SALE_SIZE             = "Size",
  FIELD_SALE_BRAND            = "Brand",
  FIELD_SALE_FINAL_PRICE      = "Final Selling Price", // number/currency
  FIELD_SALE_VAT_TYPE         = "VAT Type",            // single select -> expects plain string value
  FIELD_SALE_SELLER_LINK      = "Seller ID",           // linked -> expects ["rec..."]
  FIELD_SALE_ORDER_LINK       = "Order Number",        // linked -> expects ["rec..."]

  // --- OFFER MSG FIELDS
  // Text field that stores the order record id (recXXXXXXXX)
  FIELD_OFFERS_ORDER_ID_TEXT  = "Order Record ID",
  // Optional: if you ALSO have a linked-record to Orders, set this to its name
  FIELD_OFFERS_ORDER_ID_LINK  = "", // e.g. "Order" (leave empty if you don't have it)
  FIELD_OFFERS_CHANNEL_ID     = "Channel ID",
  FIELD_OFFERS_MESSAGE_ID     = "Message ID",
} = process.env;

const AT_API = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

/* -------------------- core request -------------------- */
async function airtableRequest(method, path, body) {
  const res = await fetch(`${AT_API}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`[Airtable] ${method} ${path} → ${res.status} ${txt}`);
  }
  return res.json();
}

/* -------------------- tiny helpers -------------------- */

const toText = (val) => {
  if (val == null) return null;
  if (Array.isArray(val)) {
    const parts = val.map(x =>
      typeof x === "string" ? x :
      (x && typeof x.name === "string" ? x.name : null)
    ).filter(Boolean);
    return parts.join(", ") || null;
  }
  if (typeof val === "object" && val.name) return val.name;
  if (typeof val === "string") return val.trim();
  if (typeof val === "number") return String(val);
  return null;
};

const toNumber = (val) => {
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const n = parseFloat(val.replace(/[^\d.,-]/g, "").replace(",", "."));
    return Number.isNaN(n) ? null : n;
  }
  return null;
};

// Return first linked rec id if the cell is ["rec..."] or [{id:"rec..."}]
const getFirstLinkedId = (val) => {
  if (!Array.isArray(val) || !val.length) return null;
  const first = val[0];
  if (typeof first === "string") return first;
  if (first && typeof first.id === "string") return first.id;
  return null;
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ====================================================================
   OFFER MESSAGES (logging + lookup for disabling buttons)
==================================================================== */

/**
 * Log one Discord message row so we can disable it later.
 * Writes the order id into a TEXT field. If you also have a linked field,
 * we'll write that too (when FIELD_OFFERS_ORDER_ID_LINK is set).
 */
export async function logOfferMessage({ orderRecId, channelId, messageId }) {
  try {
    const fields = {
      [FIELD_OFFERS_ORDER_ID_TEXT]: orderRecId, // text field
      [FIELD_OFFERS_CHANNEL_ID]: channelId,
      [FIELD_OFFERS_MESSAGE_ID]: messageId,
    };

    // Optional: also store a linked record if you configured it
    if (FIELD_OFFERS_ORDER_ID_LINK && FIELD_OFFERS_ORDER_ID_LINK.trim()) {
      fields[FIELD_OFFERS_ORDER_ID_LINK] = [{ id: orderRecId }];
    }

    await airtableRequest("POST", encodeURIComponent(AIRTABLE_TABLE_OFFER_MSGS), { fields });
  } catch (e) {
    console.warn("logOfferMessage warn:", e.message);
  }
}

/**
 * Get ALL (channelId, messageId) pairs for a given order id.
 * 1) Try exact filter on the TEXT field.
 * 2) If configured, also try a linked-record FIND() filter.
 * 3) If still empty, paginate the table and filter in JS (fallback).
 */
export async function listOfferMessagesForOrder(orderRecId) {
  const results = new Map(); // dedupe by channelId|messageId

  // 1) TEXT field filter
  try {
    const f1 = encodeURIComponent(`{${FIELD_OFFERS_ORDER_ID_TEXT}}='${orderRecId}'`);
    const data1 = await airtableRequest(
      "GET",
      `${encodeURIComponent(AIRTABLE_TABLE_OFFER_MSGS)}?filterByFormula=${f1}`
    );
    for (const r of (data1.records || [])) {
      const channelId = r.fields?.[FIELD_OFFERS_CHANNEL_ID];
      const messageId = r.fields?.[FIELD_OFFERS_MESSAGE_ID];
      if (channelId && messageId) results.set(`${channelId}|${messageId}`, { channelId, messageId });
    }
  } catch (e) {
    console.warn("listOfferMessagesForOrder (text filter) warn:", e.message);
  }

  // 2) Linked-record filter (optional)
  if (FIELD_OFFERS_ORDER_ID_LINK && FIELD_OFFERS_ORDER_ID_LINK.trim()) {
    try {
      const link = FIELD_OFFERS_ORDER_ID_LINK;
      // FIND(recordId, ARRAYJOIN({Order})) catches both single & multiple links
      const f2 = encodeURIComponent(`FIND('${orderRecId}', ARRAYJOIN({${link}}))`);
      const data2 = await airtableRequest(
        "GET",
        `${encodeURIComponent(AIRTABLE_TABLE_OFFER_MSGS)}?filterByFormula=${f2}`
      );
      for (const r of (data2.records || [])) {
        const channelId = r.fields?.[FIELD_OFFERS_CHANNEL_ID];
        const messageId = r.fields?.[FIELD_OFFERS_MESSAGE_ID];
        if (channelId && messageId) results.set(`${channelId}|${messageId}`, { channelId, messageId });
      }
    } catch (e) {
      console.warn("listOfferMessagesForOrder (linked filter) warn:", e.message);
    }
  }

  // 3) Fallback pagination (scan table)
  if (results.size === 0) {
    try {
      let path = `${encodeURIComponent(AIRTABLE_TABLE_OFFER_MSGS)}?pageSize=100`;
      while (true) {
        const data = await airtableRequest("GET", path);
        for (const r of (data.records || [])) {
          const textMatch = (r.fields?.[FIELD_OFFERS_ORDER_ID_TEXT] === orderRecId);
          let linkMatch = false;
          if (FIELD_OFFERS_ORDER_ID_LINK && FIELD_OFFERS_ORDER_ID_LINK.trim()) {
            const arr = r.fields?.[FIELD_OFFERS_ORDER_ID_LINK];
            if (Array.isArray(arr)) {
              linkMatch = arr.some(x =>
                (typeof x === "string" && x === orderRecId) ||
                (x && typeof x.id === "string" && x.id === orderRecId)
              );
            }
          }
          if (textMatch || linkMatch) {
            const channelId = r.fields?.[FIELD_OFFERS_CHANNEL_ID];
            const messageId = r.fields?.[FIELD_OFFERS_MESSAGE_ID];
            if (channelId && messageId) results.set(`${channelId}|${messageId}`, { channelId, messageId });
          }
        }
        if (data.offset) {
          path = `${encodeURIComponent(AIRTABLE_TABLE_OFFER_MSGS)}?pageSize=100&offset=${encodeURIComponent(data.offset)}`;
        } else break;
      }
    } catch (e) {
      console.warn("listOfferMessagesForOrder (fallback scan) warn:", e.message);
    }
  }

  return Array.from(results.values());
}

/* ====================================================================
   SALES: create row + decrement inventory (do not modify VAT of inventory)
==================================================================== */

export async function createSaleAndDecrement({ inventoryId, orderRecId, finalPrice }) {
  // 1) Read Inventory
  const inv = await airtableRequest(
    "GET",
    `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`
  );
  const f = inv.fields || {};

  const productName  = toText(f[FIELD_INV_PRODUCT_NAME]) || "";
  const size         = toText(f[FIELD_INV_SIZE]) || "";
  const brand        = toText(f[FIELD_INV_BRAND]) || "";
  const vatTypeName  = toText(f[FIELD_INV_VAT_TYPE]) || ""; // "Margin" | "VAT0" | "VAT21"

  // Linked record IDs (must exist)
  const skuLinkId     = getFirstLinkedId(f[FIELD_INV_LINK_SKU_MASTER]);
  const sellerLinkId  = getFirstLinkedId(f[FIELD_INV_LINKED_SELLER]);
  if (!sellerLinkId) throw new Error(`Inventory ${inventoryId}: Linked Seller field empty or not a linked record.`);
  if (!skuLinkId)    throw new Error(`Inventory ${inventoryId}: SKU Master field empty or not a linked record.`);

  // We (buyer) are NL. If inventory VAT was VAT0, Sales VAT becomes VAT21. Otherwise keep original name.
  const vatTypeOut = (String(vatTypeName).toUpperCase() === "VAT0") ? "VAT21" : (vatTypeName || "Margin");

  // 2) Create Sales row
  const saleFields = {
    [FIELD_SALE_PRODUCT_NAME]: productName,
    [FIELD_SALE_SIZE]:         size,
    [FIELD_SALE_BRAND]:        brand,
    [FIELD_SALE_FINAL_PRICE]:  round2(finalPrice),
    [FIELD_SALE_VAT_TYPE]:     vatTypeOut,      // single select expects raw string
    [FIELD_SALE_SKU_LINK]:     [skuLinkId],     // link arrays accept ["rec..."]
    [FIELD_SALE_SELLER_LINK]:  [sellerLinkId],
    [FIELD_SALE_ORDER_LINK]:   orderRecId ? [orderRecId] : undefined,
  };

  console.log("Creating Sale:", saleFields);

  await airtableRequest(
    "POST",
    encodeURIComponent(AIRTABLE_TABLE_SALES),
    { fields: saleFields }
  );

  // 3) Decrement Inventory.Quantity by 1 (don’t change any other fields)
  const currentQty = toNumber(f[FIELD_INV_QTY]) ?? 0;
  const newQty = Math.max(0, currentQty - 1);

  await airtableRequest(
    "PATCH",
    `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`,
    { fields: { [FIELD_INV_QTY]: newQty } }
  );

  console.log(`✅ Sale created + Quantity decremented → newQty: ${newQty}`);
}
