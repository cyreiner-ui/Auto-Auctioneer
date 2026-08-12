const RESEND_API_URL = "https://api.resend.com/emails";

export type NotifiableFinderItem = {
  ebay_item_id: string;
  title: string;
  ebay_url: string;
  image_url: string | null;
  item_price: number;
  shipping_cost: number | null;
  total_cost: number | null;
  cost_per_knife: number | null;
  knife_count: number | null;
};

const usd = (value: number | null) => (value == null ? "—" : Number(value).toLocaleString("en-US", { style: "currency", currency: "USD" }));

function renderEmailHtml(items: NotifiableFinderItem[]) {
  const rows = items.map((item) => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #e5e5e5;">
        <a href="${item.ebay_url}" style="font-weight:600;color:#111;text-decoration:none;">${item.title}</a><br/>
        <span>${item.knife_count ?? "?"} knives · ${usd(item.total_cost)} total · ${usd(item.cost_per_knife)}/knife</span><br/>
        <a href="${item.ebay_url}">View on eBay</a>
      </td>
    </tr>`).join("");
  return `<table style="width:100%;border-collapse:collapse;font-family:sans-serif;">${rows}</table>`;
}

export async function sendQualifiedItemsEmail(items: NotifiableFinderItem[]) {
  if (!items.length) return { ok: true, skipped: true as const };
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.FINDER_ALERT_EMAIL_FROM?.trim();
  const to = (process.env.FINDER_ALERT_EMAILS || "").split(",").map((address) => address.trim()).filter(Boolean);
  if (!apiKey || !from || !to.length) return { ok: false, skipped: true as const, message: "Email alerts are not configured (RESEND_API_KEY/FINDER_ALERT_EMAIL_FROM/FINDER_ALERT_EMAILS)." };
  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to,
      subject: `${items.length} new pocket knife deal${items.length === 1 ? "" : "s"} found`,
      html: renderEmailHtml(items),
    }),
  });
  if (!response.ok) return { ok: false, message: `Resend request failed (${response.status}): ${await response.text().catch(() => "")}` };
  return { ok: true };
}
