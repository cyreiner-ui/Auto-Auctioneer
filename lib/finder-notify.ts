import nodemailer from "nodemailer";

export type NotifyKind = "pocket_knife" | "carving_set";

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
  carving_piece_count?: number | null;
  carving_has_case?: boolean | null;
  carving_carbon_steel?: boolean | null;
  carving_stag_handle?: boolean | null;
};

const usd = (value: number | null) => (value == null ? "—" : Number(value).toLocaleString("en-US", { style: "currency", currency: "USD" }));
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] as string));
const dealLabel = (kind: NotifyKind) => (kind === "carving_set" ? "carving set" : "pocket knife");

function itemDetailLine(item: NotifiableFinderItem, kind: NotifyKind) {
  if (kind === "carving_set") {
    const pieces = item.carving_piece_count ?? 1;
    const parts = [`${pieces} piece${pieces === 1 ? "" : "s"}`];
    if (item.carving_has_case) parts.push("cased");
    if (item.carving_carbon_steel) parts.push("carbon steel");
    if (item.carving_stag_handle) parts.push("stag handle");
    parts.push(`${usd(item.total_cost)} total`);
    return parts.join(" · ");
  }
  return `${item.knife_count ?? "?"} knives · ${usd(item.total_cost)} total · ${usd(item.cost_per_knife)}/knife`;
}

function renderEmailHtml(items: NotifiableFinderItem[], kind: NotifyKind) {
  const rows = items.map((item) => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #e5e5e5;">
        <a href="${item.ebay_url}" style="font-weight:600;color:#111;text-decoration:none;">${escapeHtml(item.title)}</a><br/>
        <span>${itemDetailLine(item, kind)}</span><br/>
        <a href="${item.ebay_url}">View on eBay</a>
      </td>
    </tr>`).join("");
  return `<table style="width:100%;border-collapse:collapse;font-family:sans-serif;">${rows}</table>`;
}

function transportConfig() {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD?.trim();
  if (!host || !user || !password) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  return { host, port, secure: port === 465, auth: { user, pass: password } };
}

export async function sendQualifiedItemsEmail(items: NotifiableFinderItem[], recipients: string[], kind: NotifyKind = "pocket_knife") {
  if (!items.length) return { ok: true, skipped: true as const };
  const transportOptions = transportConfig();
  const from = process.env.FINDER_ALERT_EMAIL_FROM?.trim() || transportOptions?.auth.user;
  const to = recipients;
  if (!transportOptions || !from || !to.length) return { ok: false, skipped: true as const, message: "Email alerts are not configured (SMTP_HOST/SMTP_USER/SMTP_PASSWORD, and at least one recipient in finder notification settings)." };
  try {
    const transporter = nodemailer.createTransport(transportOptions);
    await transporter.sendMail({
      from,
      to,
      subject: `${items.length} new ${dealLabel(kind)} deal${items.length === 1 ? "" : "s"} found`,
      html: renderEmailHtml(items, kind),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Sending the alert email failed." };
  }
}

export type FinderRunSummaryCounts = { total: number; auctionCount: number; fixedPriceCount: number };

export async function sendRunSummaryEmail(counts: FinderRunSummaryCounts, recipients: string[], kind: NotifyKind = "pocket_knife") {
  if (!counts.total) return { ok: true, skipped: true as const };
  const transportOptions = transportConfig();
  const from = process.env.FINDER_ALERT_EMAIL_FROM?.trim() || transportOptions?.auth.user;
  const to = recipients;
  if (!transportOptions || !from || !to.length) return { ok: false, skipped: true as const, message: "Email alerts are not configured (SMTP_HOST/SMTP_USER/SMTP_PASSWORD, and at least one recipient in finder notification settings)." };
  try {
    const transporter = nodemailer.createTransport(transportOptions);
    await transporter.sendMail({
      from,
      to,
      subject: `${counts.total} new ${dealLabel(kind)} deal${counts.total === 1 ? "" : "s"} found`,
      html: `<p>The eBay deal finder found <strong>${counts.total}</strong> new qualifying listing${counts.total === 1 ? "" : "s"}:</p>
        <ul><li>${counts.auctionCount} auction${counts.auctionCount === 1 ? "" : "s"}</li><li>${counts.fixedPriceCount} fixed-price</li></ul>
        <p>Open /staff/finder to review.</p>`,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Sending the alert email failed." };
  }
}
